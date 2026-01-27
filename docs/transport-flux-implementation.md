# @poi-sdk/transport-flux Implementation Summary

## Overview

The `@poi-sdk/transport-flux` package implements the Flux (T-Backend style) wire format transport for the poi-sdk payment layer. This package handles detection, parsing, and header application for the Flux payment protocol.

## Package Location

`D:\fluxPoint\PoI\poi-sdk\packages\transport-flux`

## Directory Structure

```
packages/transport-flux/
├── package.json          # Package manifest with workspace dependency
├── tsconfig.json         # TypeScript configuration
├── tsup.config.ts        # Build configuration
├── src/
│   ├── index.ts          # Main entry - FluxTransport factory and re-exports
│   ├── types.ts          # Flux-specific interfaces (FluxInvoice, FluxTransport)
│   ├── parse.ts          # Parse JSON invoice body into PaymentRequest
│   └── apply.ts          # Apply X-Invoice-Id, X-Payment headers
└── dist/                 # Built output (ESM, CJS, DTS)
```

## Key Files

### src/types.ts
Defines Flux-specific TypeScript interfaces:
- `FluxInvoice` - T-Backend wire format for invoice JSON body
- `FluxPaymentResponse` - Payment verification response structure
- `FluxPaymentStatus` - Status values (pending, submitted, confirmed, etc.)
- `FluxTransport` - Interface for the transport implementation
- `ApplyPaymentOptions` - Optional headers (partner, walletAddress, chain, idempotencyKey)

### src/parse.ts
Handles parsing Flux 402 responses:
- `parseFluxInvoice(invoice)` - Convert FluxInvoice to PaymentRequest
- `parse402Response(res)` - Parse Response into PaymentRequest or null
- `looksLikeFluxResponse(res)` - Quick header-only protocol detection
- `extractInvoiceIdFromHeaders(res)` - Extract X-Invoice-Id from headers

Key transformations:
- Chain format: `"cardano-mainnet"` -> `"cardano:mainnet"` (CAIP-2)
- Expiration: ISO timestamp -> timeoutSeconds calculation
- Splits: T-Backend format -> PaymentSplits format
- Raw invoice preserved in `PaymentRequest.raw`

### src/apply.ts
Handles applying payment headers to requests:
- `createPaymentHeader(proof)` - Extract proof string from PaymentProof
- `applyPaymentHeaders(headers, proof, invoiceId, options)` - Mutate Headers object
- `applyPaymentToRequest(req, proof, invoiceId, options)` - Create new Request
- `hasPaymentHeaders(req)` - Check if payment headers are present
- `extractPaymentFromRequest(req)` - Extract invoiceId and payment from headers
- `stripPaymentHeaders(req)` - Remove all Flux payment headers

Supported proof kinds:
- `cardano-txhash` - Transaction hash
- `cardano-signed-cbor` - Signed CBOR hex
- `evm-txhash` - EVM transaction hash
- Note: `x402-signature` throws error (not supported by Flux)

### src/index.ts
Main entry point with:
- `createFluxTransport()` - Factory function returning FluxTransport
- `createExtendedFluxTransport()` - Extended version with applyPaymentWithOptions
- Re-exports all types and utility functions

## Dependencies

- `@poi-sdk/core` (workspace:*) - Core types, FLUX_HEADERS, CHAINS mapping

## Usage Example

```typescript
import { createFluxTransport } from "@poi-sdk/transport-flux";

const flux = createFluxTransport();

// Fetch a resource that may require payment
const response = await fetch("https://api.example.com/paid-resource");

// Check if this is a Flux 402 response
if (flux.is402(response)) {
  // Parse the payment requirement
  const request = await flux.parse402(response);
  console.log(`Payment: ${request.amountUnits} ${request.asset} to ${request.payTo}`);
  console.log(`Chain: ${request.chain}`); // "cardano:mainnet" (CAIP-2)
  console.log(`Invoice: ${request.invoiceId}`);

  // ... execute payment using a payer ...
  const proof = { kind: "cardano-txhash", txHash: "abc123..." };

  // Retry request with payment proof
  const paidReq = flux.applyPayment(
    new Request("https://api.example.com/paid-resource"),
    proof,
    request.invoiceId!
  );

  const result = await fetch(paidReq);
  // Result has X-Invoice-Id and X-Payment headers
}
```

## Flux Protocol Details

The Flux protocol differs from x402 in these ways:

1. **402 Detection**: Flux uses JSON body (no PAYMENT-REQUIRED header)
2. **Headers**: Uses X-* prefixed headers (X-Invoice-Id, X-Payment, etc.)
3. **Chain Format**: Wire format uses dashes (`cardano-mainnet`), converted to CAIP-2 internally
4. **Split Mode**: Defaults to "additional" if not specified
5. **Payment Proof**: Expects transaction hash or signed CBOR in X-Payment header

## Build Status

- Build: SUCCESS
- Type check: PASS
- Output formats: ESM (.js), CJS (.cjs), DTS (.d.ts, .d.cts)

## Recommended Tests

The Test Engineer should verify the following test scenarios:

### Unit Tests (src/__tests__/parse.test.ts)

1. **parseFluxInvoice**
   - Parse basic invoice with required fields only
   - Parse invoice with all optional fields (decimals, expiresAt, partner, splits, metadata)
   - Convert chain format: "cardano-mainnet" -> "cardano:mainnet"
   - Convert chain format: "base-mainnet" -> "eip155:8453"
   - Handle unknown chain format (pass through as-is)
   - Calculate timeout from expiresAt (future time)
   - Handle expired invoice (expiresAt in past -> timeout = 0)
   - Convert splits with inclusive mode
   - Convert splits with additional mode (default)
   - Handle splits with optional role and currency fields
   - Preserve raw invoice in request.raw

2. **parse402Response**
   - Return null for non-JSON content type
   - Return null for missing invoiceId
   - Return null for missing required fields (amount, currency, payTo, chain)
   - Parse valid Flux 402 response
   - Clone response to preserve body
   - Handle JSON parse errors gracefully

3. **looksLikeFluxResponse**
   - Return true for JSON content type without PAYMENT-REQUIRED header
   - Return false for non-JSON content type
   - Return false if PAYMENT-REQUIRED header present (x402)

### Unit Tests (src/__tests__/apply.test.ts)

1. **createPaymentHeader**
   - Extract txHash from cardano-txhash proof
   - Extract cborHex from cardano-signed-cbor proof
   - Extract txHash from evm-txhash proof
   - Throw error for x402-signature proof

2. **applyPaymentHeaders**
   - Set X-Invoice-Id and X-Payment headers
   - Set optional X-Partner header when provided
   - Set optional X-Wallet-Address header when provided
   - Set optional X-Chain header when provided
   - Set optional X-Idempotency-Key header when provided
   - Return mutated Headers object

3. **applyPaymentToRequest**
   - Create new Request with payment headers
   - Preserve original request body and method
   - Not modify original request headers

4. **hasPaymentHeaders / extractPaymentFromRequest / stripPaymentHeaders**
   - Detect presence of payment headers
   - Extract payment info from request
   - Remove all Flux payment headers

### Integration Tests (src/__tests__/index.test.ts)

1. **createFluxTransport**
   - is402: Return true for 402 + JSON + no PAYMENT-REQUIRED
   - is402: Return false for non-402 status
   - is402: Return false for 402 + PAYMENT-REQUIRED header (x402)
   - is402: Return false for 402 + non-JSON content type
   - parse402: Parse valid response
   - parse402: Throw for invalid response
   - applyPayment: Create request with headers

2. **createExtendedFluxTransport**
   - applyPaymentWithOptions: Apply all optional headers

### Test Commands

```bash
cd D:\fluxPoint\PoI\poi-sdk\packages\transport-flux
pnpm test        # Run all tests
pnpm test:watch  # Run tests in watch mode
pnpm typecheck   # TypeScript validation
pnpm build       # Build package
```

---

**For Test Engineer**: Please read this document and implement the recommended tests. The package is ready for testing at `D:\fluxPoint\PoI\poi-sdk\packages\transport-flux`.

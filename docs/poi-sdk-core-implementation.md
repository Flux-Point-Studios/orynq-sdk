# @fluxpointstudios/poi-sdk-core Implementation Summary

## Overview

The `@fluxpointstudios/poi-sdk-core` package has been implemented as the foundational layer for the poi-sdk dual-protocol commerce system. This package provides protocol-neutral types, interfaces, and utilities that support both Flux and x402 payment protocols.

## Implementation Date
2025-01-26

## Package Location
`D:\fluxPoint\PoI\poi-sdk\packages\core`

## Key Features Implemented

### 1. Payment Types (`src/types/payment.ts`)
- **ChainId**: CAIP-2 chain identifier type (e.g., "eip155:8453", "cardano:mainnet")
- **PaymentRequest**: Protocol-neutral payment request structure supporting both Flux and x402
- **PaymentProof**: Discriminated union of proof types:
  - `cardano-txhash`: Cardano transaction hash
  - `cardano-signed-cbor`: Cardano signed CBOR
  - `evm-txhash`: EVM transaction hash
  - `x402-signature`: x402 signature proof
- **PaymentAttempt**: Complete payment attempt with idempotency key
- **PaymentStatus**: Payment lifecycle status tracking
- Type guards for all proof types

### 2. Payer Interface (`src/types/payer.ts`)
- **Signer**: Low-level cryptographic signing interface
- **Payer**: High-level payment execution interface with:
  - `supportedChains`: List of supported chain IDs
  - `supports()`: Check if request is supported
  - `getAddress()`: Get payment address
  - `pay()`: Execute payment
  - `getBalance()`: Get asset balance
- **NodePayerConfig**: Configuration for server-side payers
- **BrowserPayerConfig**: Configuration for browser-based payers

### 3. Error Classes (`src/types/errors.ts`)
- **PaymentError**: Abstract base class for all payment errors
- **PaymentRequiredError**: HTTP 402 response with payment request
- **BudgetExceededError**: Budget limit exceeded
- **InsufficientBalanceError**: Wallet balance too low
- **InvoiceExpiredError**: Invoice has expired
- **DuplicatePaymentError**: Invoice already paid
- **PaymentFailedError**: Transaction failed
- **PaymentTimeoutError**: Operation timed out
- **ChainNotSupportedError**: Chain not supported
- **AssetNotSupportedError**: Asset not supported on chain
- Type guards for error handling

### 4. Stream Types (`src/types/stream.ts`)
- NDJson event types for streaming responses:
  - PaymentRequiredEvent
  - PaymentReceivedEvent
  - PaymentConfirmedEvent
  - ContentChunkEvent
  - ProgressEvent
  - CompleteEvent
  - ErrorEvent
  - MetadataEvent
  - HeartbeatEvent
- Stream parsing utilities: `parseNDJsonLine()`, `parseNDJsonStream()`

### 5. Budget Types (`src/types/budget.ts`)
- **BudgetConfig**: Budget limit configuration
- **BudgetStore**: Interface for budget tracking storage
- **InvoiceCache**: Interface for invoice caching
- **InMemoryBudgetStore**: Reference in-memory implementation
- **InMemoryInvoiceCache**: Reference in-memory implementation

### 6. Headers (`src/types/headers.ts`)
- **X402_HEADERS**: x402 protocol header constants
- **FLUX_HEADERS**: Flux protocol header constants
- Utility functions:
  - `isPaymentRequired()`: Check for 402 status
  - `detectProtocol()`: Detect protocol from headers
  - `extractPaymentHeaders()`: Extract payment headers

### 7. Chain Utilities (`src/chains.ts`)
- **CHAINS**: Mapping of friendly names to CAIP-2 identifiers
- Supported chains:
  - EVM: Base, Ethereum, Polygon, Arbitrum, Optimism (mainnet + testnets)
  - Cardano: mainnet, preprod, preview
- Conversion functions:
  - `toCAIP2()`: Convert friendly name to CAIP-2
  - `fromCAIP2()`: Convert CAIP-2 to friendly name
  - `normalizeChainId()`: Normalize any format to CAIP-2
- Chain detection:
  - `isEvmChain()`, `isCardanoChain()`
  - `getChainFamily()`: Get chain family
  - `getChainInfo()`: Get detailed chain information

### 8. Canonical JSON (`src/utils/canonical-json.ts`)
- RFC 8785 (JCS) compliant JSON canonicalization
- Features:
  - Lexicographic key sorting
  - Configurable null/undefined removal
  - Circular reference detection
  - Maximum depth protection
- Utility functions: `canonicalize()`, `canonicalEquals()`, `normalizeJson()`

### 9. Hash Utilities (`src/utils/hash.ts`)
- SHA256 using Web Crypto API (zero dependencies)
- Functions:
  - `sha256()`, `sha256String()`, `sha256Hex()`, `sha256StringHex()`
  - `generateIdempotencyKey()`: Deterministic key from (method, url, body)
- Encoding utilities:
  - `bytesToHex()`, `hexToBytes()`, `isValidHex()`
  - `bytesToBase64()`, `base64ToBytes()`
  - `bytesToBase64Url()`, `base64UrlToBytes()`
- Content integrity: `generateContentHash()`, `verifyContentHash()`

## Critical Design Decisions

1. **All amounts are strings**: Prevents JavaScript precision issues with large numbers
2. **CAIP-2 internal format**: Uses standard chain identifier format internally
3. **Zero external dependencies**: Uses built-in Web Crypto API
4. **Explicit split modes**: `inclusive` vs `additional` must be specified
5. **exactOptionalPropertyTypes compliance**: All optional properties include `| undefined`

## Build Configuration

- **Bundler**: tsup
- **Output formats**: ESM (.js) and CJS (.cjs)
- **Declaration files**: .d.ts and .d.cts
- **Source maps**: Enabled
- **Target**: ES2022

## Package Exports

```json
{
  ".": ESM/CJS main entry,
  "./types": Types-only entry,
  "./chains": Chain utilities entry,
  "./utils": Utility functions entry
}
```

## Files Created

```
packages/core/
  package.json
  tsconfig.json
  tsup.config.ts
  src/
    index.ts
    chains.ts
    types/
      index.ts
      payment.ts
      payer.ts
      errors.ts
      stream.ts
      budget.ts
      headers.ts
    utils/
      index.ts
      canonical-json.ts
      hash.ts
```

## Recommended Tests

The Test Engineer should create tests for the following:

### Unit Tests

1. **Payment Types**
   - Test type guards for all PaymentProof variants
   - Verify PaymentRequest structure validation

2. **Chain Utilities**
   - `toCAIP2()` and `fromCAIP2()` conversions
   - `normalizeChainId()` with various formats
   - Chain detection functions (`isEvmChain`, `isCardanoChain`)
   - `getChainInfo()` returns correct info for all chains

3. **Canonical JSON**
   - Key sorting (alphabetical by UTF-16 code units)
   - Null removal behavior
   - Circular reference detection
   - Maximum depth protection
   - Cross-language hash equality (compare with reference implementations)

4. **Hash Utilities**
   - SHA256 correctness with known test vectors
   - `generateIdempotencyKey()` determinism (same input = same output)
   - Hex encoding/decoding roundtrip
   - Base64 encoding/decoding roundtrip
   - Content hash verification

5. **Error Classes**
   - Error code assignment
   - `toJSON()` serialization
   - Error inheritance chain

6. **Stream Parsing**
   - `parseNDJsonLine()` with valid/invalid input
   - `parseNDJsonStream()` with chunked data
   - Event type guards

7. **Headers**
   - `detectProtocol()` with x402 and Flux headers
   - `extractPaymentHeaders()` extraction

### Integration Tests

1. **Build verification**
   - ESM imports work correctly
   - CJS requires work correctly
   - TypeScript types resolve correctly

2. **Idempotency key generation**
   - Same request produces same key
   - Different requests produce different keys
   - URL normalization works

### Test Commands

```bash
# Run all tests
cd D:\fluxPoint\PoI\poi-sdk\packages\core
pnpm run test

# Run tests in watch mode
pnpm run test:watch

# Type check
pnpm run typecheck
```

## Instructions for Test Engineer

Please read this document and implement comprehensive tests for the @fluxpointstudios/poi-sdk-core package. Focus on:

1. **Correctness**: All functions should produce expected outputs
2. **Edge cases**: Empty inputs, invalid data, boundary conditions
3. **Type safety**: TypeScript types should be properly enforced
4. **Cross-platform**: Tests should pass in both Node.js and browser environments

Create test files in `packages/core/src/__tests__/` or `packages/core/tests/` directory.

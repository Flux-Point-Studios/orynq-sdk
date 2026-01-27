# @poi-sdk/payer-cardano-node Backend Implementation Summary

## Overview

This document summarizes the implementation work completed for the `@poi-sdk/payer-cardano-node` package, which provides server-side Cardano payment functionality with real Blockfrost/Koios integration and secure signer abstractions.

## Implementation Date

2026-01-27

## Package Location

`D:\fluxPoint\PoI\poi-sdk\packages\payer-cardano-node`

## What Was Implemented

### 1. MemorySigner (memory-signer.ts)

Replaced stub implementation with real Ed25519 cryptographic operations using `@emurgo/cardano-serialization-lib-nodejs`:

**Implemented Methods:**
- `getAddress(chain)` - Derives enterprise address from private key for mainnet/preprod
- `sign(payload, chain)` - Signs arbitrary data with Ed25519 signature scheme
- `signTx(txBodyHash, chain)` - Signs transaction body and returns complete vkey witness CBOR
- `getPublicKeyHash(chain)` - Returns the 28-byte Ed25519 key hash

**Key Features:**
- Supports both 32-byte normal and 64-byte extended private keys
- Dynamic CSL import (allows package to work without CSL for basic provider operations)
- Security warning displayed once per process
- Proper validation of input parameters

**Security Notes:**
- WARNING: For development/testing only - keys stored in memory
- Production deployments should use KmsSigner or hardware wallet integration

### 2. Transaction Builder (tx-builder.ts)

Replaced stub with real transaction building using CSL v15:

**Implemented Functions:**
- `buildPaymentTx(params)` - Full transaction building and signing pipeline
- `calculateTotalAmount(request)` - Handles inclusive/additional split modes
- `buildOutputs(request)` - Creates output list from payment request
- `selectUtxos(utxos, required, assets?)` - Greedy UTxO selection (largest-first)
- `estimateMinAda(coinsPerUtxoByte, size)` - Min-ADA calculation
- `calculateFee(minFeeA, minFeeB, txSize)` - Linear fee estimation
- `isValidCardanoAddress(address)` - Basic address format validation
- `validateCardanoAddress(address)` - Full CSL-based address validation

**Transaction Building Flow:**
1. Calculate total output amount (primary + splits)
2. Select UTxOs using greedy algorithm
3. Build transaction with protocol parameters
4. Add inputs and outputs with native asset support
5. Add change output automatically
6. Create FixedTransaction for proper hash computation
7. Sign with extended signer (signTx method)
8. Return signed CBOR and transaction hash

### 3. BlockfrostProvider (blockfrost.ts)

Already implemented - verified working:
- `getUtxos(address)` - Fetch UTxOs with retry logic
- `getProtocolParameters()` - Fresh protocol params from latest epoch
- `submitTx(txCbor)` - Submit signed transaction
- `awaitTx(txHash, timeout)` - Poll for confirmation
- `getNetworkId()` - Returns "mainnet" or "preprod"

### 4. KoiosProvider (koios.ts)

Already implemented - verified working:
- Same interface as BlockfrostProvider
- POST-based API for address queries
- Optional API key for higher rate limits

### 5. KmsSigner (kms-signer.ts)

Fully implemented for secp256k1 ECDSA signing (AWS KMS does not support Ed25519):

**Features:**
- Uses AWS KMS for secure key management
- Supports ECDSA_SHA_256 with secp256k1 curve
- DER signature parsing and S-value normalization
- Custom address derivation function support
- Lazy KMS client initialization
- Public key caching

**Limitation:**
AWS KMS does not support Ed25519 (native Cardano signature scheme). This signer provides secp256k1 ECDSA as a workaround for specific use cases.

## Files Modified

| File | Changes |
|------|---------|
| `src/signers/memory-signer.ts` | Complete rewrite with real CSL implementation |
| `src/tx-builder.ts` | Complete rewrite with real transaction building |
| `src/signers/kms-signer.ts` | Fixed TypeScript errors in DER parsing |
| `src/index.ts` | Added new exports (isValidCardanoAddress, validateCardanoAddress) |
| `vitest.config.ts` | Created for proper test discovery |

## Files Created

| File | Purpose |
|------|---------|
| `src/__tests__/tx-builder.test.ts` | Unit tests for transaction builder utilities |
| `src/__tests__/memory-signer.test.ts` | Unit tests for MemorySigner |
| `src/__tests__/providers.test.ts` | Unit tests for Blockfrost/Koios providers |

## Dependencies

**Runtime Dependencies:**
- `@poi-sdk/core` - Core types and interfaces

**Peer Dependencies (Optional):**
- `@emurgo/cardano-serialization-lib-nodejs` v15.0.3 - For transaction building (installed)
- `@aws-sdk/client-kms` v3.975.0 - For KMS signer (installed)

## Test Results

All 54 unit tests passing:
- `tx-builder.test.ts` - 20 tests
- `memory-signer.test.ts` - 19 tests
- `providers.test.ts` - 15 tests

## Build Status

- TypeScript compilation: PASSING
- Build output: ESM + CJS + DTS
- No errors or warnings

## Usage Example

```typescript
import {
  CardanoNodePayer,
  BlockfrostProvider,
  MemorySigner,
} from "@poi-sdk/payer-cardano-node";

// Create provider
const provider = new BlockfrostProvider({
  projectId: process.env.BLOCKFROST_PROJECT_ID,
  network: "preprod",
});

// Create signer (DEV ONLY - use KmsSigner for production)
const signer = new MemorySigner(process.env.PRIVATE_KEY_HEX);

// Create payer
const payer = new CardanoNodePayer({
  signer,
  provider,
  awaitConfirmation: true,
});

// Execute payment
const proof = await payer.pay({
  protocol: "flux",
  chain: "cardano:preprod",
  asset: "ADA",
  amountUnits: "2000000", // 2 ADA
  payTo: "addr_test1qz...",
});

console.log("Transaction hash:", proof.txHash);
```

## Recommended Tests for Test Engineer

### Integration Tests (with real Blockfrost/Koios)

1. **End-to-End Payment Flow**
   - Create a test wallet on preprod
   - Fund with testnet ADA
   - Execute payment and verify on-chain

2. **Split Payment Testing**
   - Test inclusive mode splits
   - Test additional mode splits
   - Verify all outputs on-chain

3. **Error Handling**
   - Test insufficient balance scenarios
   - Test invalid address handling
   - Test transaction submission failures
   - Test timeout handling

4. **Provider Failover**
   - Test with invalid API key
   - Test network timeout scenarios
   - Verify retry logic

### Test Commands

```bash
# Run unit tests
cd D:\fluxPoint\PoI\poi-sdk\packages\payer-cardano-node
pnpm test

# Run with coverage
pnpm test -- --coverage

# Run specific test file
pnpm test -- src/__tests__/tx-builder.test.ts
```

### Environment Variables for Integration Tests

```env
BLOCKFROST_PROJECT_ID=your-preprod-project-id
KOIOS_API_KEY=optional-api-key
TEST_PRIVATE_KEY_HEX=64-char-hex-private-key
TEST_RECIPIENT_ADDRESS=addr_test1...
```

---

**For Test Engineer:** Please read this document and create integration tests based on the recommendations above. The unit tests are passing; integration tests should verify the complete payment flow on preprod testnet.

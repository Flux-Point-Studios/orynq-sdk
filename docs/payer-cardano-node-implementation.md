# @poi-sdk/payer-cardano-node Implementation Summary

## Overview

The `@poi-sdk/payer-cardano-node` package provides server-side Cardano payment functionality with pluggable blockchain providers and secure signer abstractions. It implements the `Payer` interface from `@poi-sdk/core`.

## Package Location

`D:\fluxPoint\PoI\poi-sdk\packages\payer-cardano-node`

## Directory Structure

```
packages/payer-cardano-node/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── src/
│   ├── index.ts              # Main entry point, exports all public APIs
│   ├── node-payer.ts         # CardanoNodePayer implementation of Payer interface
│   ├── tx-builder.ts         # Transaction building utilities (stub)
│   ├── signers/
│   │   ├── index.ts          # Signers module entry point
│   │   ├── interface.ts      # Re-exports Signer from @poi-sdk/core
│   │   ├── memory-signer.ts  # Development-only in-memory signer
│   │   └── kms-signer.ts     # AWS KMS signer stub
│   └── providers/
│       ├── index.ts          # Providers module entry point
│       ├── interface.ts      # CardanoProvider, UTxO, ProtocolParameters interfaces
│       ├── blockfrost.ts     # Blockfrost API provider implementation
│       └── koios.ts          # Koios API provider implementation
```

## Key Components

### 1. CardanoNodePayer (`node-payer.ts`)

Main payer implementation that orchestrates payment flows:

- Implements `Payer` interface from `@poi-sdk/core`
- Uses pluggable `CardanoProvider` for blockchain data
- Uses `Signer` abstraction for key management
- Supports split payments
- Optional transaction confirmation awaiting

**Configuration:**
```typescript
interface CardanoNodePayerConfig {
  signer: Signer;
  provider: CardanoProvider;
  awaitConfirmation?: boolean;
  confirmationTimeout?: number;
}
```

### 2. Providers (`providers/`)

#### CardanoProvider Interface (`interface.ts`)

Defines the contract for blockchain data providers:

```typescript
interface CardanoProvider {
  getUtxos(address: string): Promise<UTxO[]>;
  getProtocolParameters(): Promise<ProtocolParameters>;
  submitTx(txCbor: string): Promise<string>;
  awaitTx(txHash: string, timeout?: number): Promise<boolean>;
  getNetworkId(): "mainnet" | "preprod";
}
```

#### BlockfrostProvider (`blockfrost.ts`)

Full implementation using Blockfrost API:
- UTxO fetching with pagination support
- Protocol parameters retrieval
- Transaction submission
- Transaction confirmation polling
- Retry logic with exponential backoff
- Configurable timeout

#### KoiosProvider (`koios.ts`)

Full implementation using Koios API:
- Same capabilities as Blockfrost
- Optional API key for higher rate limits
- POST-based API for address queries

### 3. Signers (`signers/`)

#### MemorySigner (`memory-signer.ts`)

**WARNING: Development only!**

- Stores private keys in memory
- Outputs security warning on instantiation
- Validates hex private key format
- Stub methods that throw with implementation instructions

#### KmsSigner (`kms-signer.ts`)

AWS KMS integration stub:
- Configuration for KMS key ID, region, endpoint
- Stub methods with detailed implementation instructions
- Notes about Ed25519 limitations in AWS KMS

### 4. Transaction Builder (`tx-builder.ts`)

Utilities for building payment transactions:

- `buildPaymentTx()` - Main builder (stub, requires cardano-serialization-lib)
- `calculateTotalAmount()` - Calculates total payment including splits
- `buildOutputs()` - Creates output list from payment request
- `selectUtxos()` - Greedy UTxO selection algorithm
- `estimateMinAda()` - Minimum ADA calculation
- `calculateFee()` - Linear fee calculation

## Dependencies

### Runtime Dependencies
- `@poi-sdk/core` - Core types and interfaces

### Peer Dependencies (Optional)
- `@emurgo/cardano-serialization-lib-nodejs` - For actual transaction building
- `@aws-sdk/client-kms` - For AWS KMS signer implementation

## Usage Example

```typescript
import {
  CardanoNodePayer,
  BlockfrostProvider,
  KmsSigner,
} from "@poi-sdk/payer-cardano-node";

// Create provider
const provider = new BlockfrostProvider({
  projectId: "your-blockfrost-project-id",
  network: "mainnet",
});

// Create signer (use KmsSigner for production!)
const signer = new KmsSigner({
  keyId: "alias/my-cardano-key",
  region: "us-east-1",
});

// Create payer
const payer = new CardanoNodePayer({
  signer,
  provider,
  awaitConfirmation: true,
  confirmationTimeout: 120000,
});

// Execute payment
const proof = await payer.pay({
  protocol: "flux",
  chain: "cardano:mainnet",
  asset: "ADA",
  amountUnits: "1000000", // 1 ADA
  payTo: "addr1...",
});

console.log("Transaction hash:", proof.txHash);
```

## Subpath Exports

The package supports subpath imports:

```typescript
// Full package
import { CardanoNodePayer, BlockfrostProvider } from "@poi-sdk/payer-cardano-node";

// Signers only
import { MemorySigner, KmsSigner } from "@poi-sdk/payer-cardano-node/signers";

// Providers only
import { BlockfrostProvider, KoiosProvider } from "@poi-sdk/payer-cardano-node/providers";
```

## Implementation Notes

### Stub Methods

The transaction building (`buildPaymentTx`) is implemented as a stub that throws with detailed implementation instructions. This is intentional because:

1. `@emurgo/cardano-serialization-lib-nodejs` is a heavy dependency
2. Users may want different transaction building strategies
3. The package can still be used for UTxO queries and balance checks

To implement actual transaction building:
1. Install `@emurgo/cardano-serialization-lib-nodejs`
2. Follow the instructions in the error message
3. Implement using CSL's TransactionBuilder

### Security Considerations

1. **Never use MemorySigner in production** - Keys in memory are vulnerable
2. **KmsSigner requires implementation** - Stub only, install AWS SDK
3. **Validate addresses** - Basic validation is included
4. **Handle API keys securely** - Use environment variables

### Error Handling

The payer uses error classes from `@poi-sdk/core`:
- `ChainNotSupportedError` - Unsupported chain
- `AssetNotSupportedError` - Unsupported asset
- `InsufficientBalanceError` - Not enough funds
- `PaymentFailedError` - Transaction failure wrapper

## Build Status

- TypeScript compilation: PASSING
- Build output: ESM + CJS + DTS

## Recommended Tests

The test engineer should verify:

### Unit Tests

1. **Provider Interface Compliance**
   - `BlockfrostProvider` implements all `CardanoProvider` methods
   - `KoiosProvider` implements all `CardanoProvider` methods
   - Both handle network errors gracefully

2. **UTxO Mapping**
   - Blockfrost response correctly mapped to `UTxO` interface
   - Koios response correctly mapped to `UTxO` interface
   - Optional fields (datumHash, datum, scriptRef) handled correctly

3. **Signer Validation**
   - `MemorySigner` validates hex private key format
   - `MemorySigner` validates key length (64 or 128 chars)
   - `KmsSigner` validates keyId is provided

4. **Transaction Builder Utilities**
   - `calculateTotalAmount` handles inclusive splits
   - `calculateTotalAmount` handles additional splits
   - `buildOutputs` creates correct output list
   - `selectUtxos` selects sufficient UTxOs
   - `selectUtxos` throws on insufficient UTxOs

5. **CardanoNodePayer**
   - `supports()` correctly identifies supported requests
   - `getAddress()` throws for unsupported chains
   - `getBalance()` aggregates UTxO balances correctly
   - `pay()` validates chain and asset before processing

### Integration Tests (with mocked providers)

1. **Payment Flow**
   - Complete payment flow with mocked provider
   - Error handling for insufficient balance
   - Error handling for submission failures

2. **Provider API Calls**
   - Blockfrost API endpoint construction
   - Koios API endpoint construction
   - Retry logic on failures
   - Timeout handling

### Test Instructions

```bash
# Run tests
cd D:\fluxPoint\PoI\poi-sdk\packages\payer-cardano-node
pnpm test

# Run specific test file
pnpm test -- src/__tests__/providers/blockfrost.test.ts

# Run with coverage
pnpm test -- --coverage
```

---

**For Test Engineer:** Please read this file and create comprehensive tests based on the recommendations above. Focus on unit tests first, then integration tests with mocked providers.

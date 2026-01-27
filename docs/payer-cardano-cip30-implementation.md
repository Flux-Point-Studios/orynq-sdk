# @poi-sdk/payer-cardano-cip30 Implementation Summary

## Overview

This document summarizes the implementation of the `@poi-sdk/payer-cardano-cip30` package, a CIP-30 browser wallet adapter for Cardano payments in the poi-sdk ecosystem.

## Package Location

`D:\fluxPoint\PoI\poi-sdk\packages\payer-cardano-cip30`

## Directory Structure

```
packages/payer-cardano-cip30/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── src/
│   ├── index.ts              # Main entry point and convenience factory
│   ├── cip30-payer.ts        # Payer interface implementation
│   ├── wallet-connector.ts   # CIP-30 wallet connection utilities
│   └── tx-builder.ts         # Transaction building with split payments
└── dist/                     # Build output (ESM/CJS)
```

## Key Features

### 1. CIP-30 Wallet Support
- Supports popular Cardano wallets: Nami, Eternl, Lace, Vespr, Flint, Typhon, GeroWallet, NuFi, Yoroi, Begin
- Provides wallet discovery (`getAvailableWallets`, `getWalletInfo`)
- Handles wallet connection flow with proper error handling

### 2. Payer Interface Implementation
- Fully implements the `Payer` interface from `@poi-sdk/core`
- Supports both ADA and native token payments
- Network validation (mainnet/preprod/preview)
- Balance checking before payment execution

### 3. Split Payments
- Supports multi-output transactions
- Two split modes:
  - **Inclusive**: Splits are deducted from the primary amount
  - **Additional**: Splits are added on top of the primary amount

### 4. Transaction Building
- Uses `lucid-cardano` for transaction construction
- Automatic coin selection and fee calculation
- Support for metadata attachment
- TTL (time-to-live) configuration

## API Reference

### Main Exports

```typescript
// Payer class
export { Cip30Payer, type Cip30PayerConfig } from "./cip30-payer.js";

// Wallet connection
export {
  getAvailableWallets,
  connectWallet,
  isWalletAvailable,
  isWalletConnected,
  type WalletName,
  type Cip30EnabledWalletApi,
} from "./wallet-connector.js";

// Transaction building
export {
  buildPaymentTx,
  calculateTotalAmount,
  isAdaAsset,
  parseAssetId,
  toLucidUnit,
} from "./tx-builder.js";

// Convenience factory
export { createCip30Payer } from "./index.js";
```

### Usage Examples

#### Quick Start with Factory
```typescript
import { createCip30Payer } from "@poi-sdk/payer-cardano-cip30";

const payer = await createCip30Payer("nami", "mainnet", {
  blockfrostProjectId: "your-project-id",
});

const proof = await payer.pay(paymentRequest);
console.log("Transaction hash:", proof.txHash);
```

#### Manual Setup
```typescript
import { connectWallet, Cip30Payer } from "@poi-sdk/payer-cardano-cip30";
import { Lucid, Blockfrost } from "lucid-cardano";

const walletApi = await connectWallet("eternl");

const lucid = await Lucid.new(
  new Blockfrost("https://cardano-mainnet.blockfrost.io/api", projectId),
  "Mainnet"
);
lucid.selectWallet(walletApi);

const payer = new Cip30Payer({
  walletApi,
  lucid,
  network: "mainnet",
});
```

## Dependencies

### Production
- `@poi-sdk/core`: workspace:*

### Peer Dependencies
- `lucid-cardano`: >=0.10.0

### Development
- `lucid-cardano`: ^0.10.7
- `tsup`: ^8.0.1
- `typescript`: ^5.3.3

## Build Status

- TypeScript compilation: PASS
- Build output: ESM + CJS with declaration files

## Files Created

1. **package.json** - Package configuration with dependencies and scripts
2. **tsconfig.json** - TypeScript configuration extending base config
3. **tsup.config.ts** - Build configuration for ESM/CJS output
4. **src/wallet-connector.ts** - CIP-30 wallet API types and connection utilities
5. **src/tx-builder.ts** - Transaction building with split payment support
6. **src/cip30-payer.ts** - Main Payer implementation class
7. **src/index.ts** - Package entry point with exports and factory function

## Recommended Tests

For the Test Engineer to verify this implementation:

### Unit Tests

1. **wallet-connector.ts**
   - Test `getAvailableWallets()` returns correct wallets when window.cardano is mocked
   - Test `connectWallet()` throws `WalletConnectionError` when wallet not found
   - Test `isWalletAvailable()` returns correct boolean values
   - Test `getWalletInfo()` returns proper wallet metadata

2. **tx-builder.ts**
   - Test `isAdaAsset()` for various asset identifiers ("ADA", "lovelace", "ada", "")
   - Test `parseAssetId()` for dot-separated and concatenated formats
   - Test `toLucidUnit()` conversion
   - Test `calculateTotalAmount()` for inclusive and additional split modes
   - Test `buildPaymentTx()` with mocked Lucid instance:
     - Simple ADA payment
     - Payment with inclusive splits
     - Payment with additional splits
     - Native token payment
     - Validation error cases

3. **cip30-payer.ts**
   - Test `supports()` returns true for matching chain IDs
   - Test `getAddress()` uses Lucid wallet.address()
   - Test `getBalance()` for ADA and native tokens
   - Test `pay()` builds, signs, and submits transaction
   - Test error handling:
     - `ChainNotSupportedError` for invalid chains
     - `InsufficientBalanceError` for low balance
     - `PaymentFailedError` for transaction failures

### Integration Tests

1. **End-to-end flow** (requires testnet wallet):
   - Connect to wallet
   - Get balance
   - Execute payment
   - Verify transaction hash

### Test Commands

```bash
# From package directory
cd packages/payer-cardano-cip30

# Type checking
pnpm typecheck

# Build
pnpm build

# Run tests (when test files are added)
pnpm test
```

## Instructions for Test Engineer

1. Read this document to understand the implementation scope
2. Create test files in `packages/payer-cardano-cip30/src/__tests__/` or similar
3. Mock the following dependencies:
   - `window.cardano` for wallet connector tests
   - `lucid-cardano` Lucid instance for transaction builder tests
   - CIP-30 wallet API for payer tests
4. Focus on:
   - Split payment logic (inclusive vs additional modes)
   - Error handling and edge cases
   - Balance checking before payment
   - CBOR parsing for balance values
5. Consider adding test utilities for common mocks

## Notes

- The package is designed for browser environments only (uses `window.cardano`)
- CBOR parsing for balance is simplified; complex multi-asset balances fall back to UTxO scanning
- Network validation can be disabled via config for testing scenarios
- The convenience factory (`createCip30Payer`) uses dynamic imports for tree-shaking

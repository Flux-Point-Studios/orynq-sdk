# @fluxpointstudios/poi-sdk-payer-cardano-cip30 MeshJS Implementation Summary

## Overview

This document summarizes the implementation of the `@fluxpointstudios/poi-sdk-payer-cardano-cip30` package using MeshJS for Cardano browser wallet integration. The implementation replaces the previous `lucid-cardano` dependency with `@meshsdk/core`.

## Package Location

`D:\fluxPoint\PoI\poi-sdk\packages\payer-cardano-cip30`

## Changes Made

### 1. Dependency Updates (`package.json`)

- Changed peer dependency from `lucid-cardano` to `@meshsdk/core` (>=1.5.0)
- Updated dev dependency to `@meshsdk/core` (^1.7.15)
- Added `vitest` for testing

### 2. Transaction Builder (`tx-builder.ts`)

Key changes:
- Replaced Lucid imports with MeshJS imports (`Transaction`, `BrowserWallet` from `@meshsdk/core`)
- Added `Recipient` and `Asset` types from MeshJS
- Updated `buildPaymentTx()` to use MeshJS `Transaction` class:
  - Creates `Transaction` instance with wallet as `initiator`
  - Uses `tx.sendAssets(recipient, assets)` for adding outputs
  - Calls `tx.build()` to produce unsigned transaction hex
- Updated `buildBatchPaymentTx()` similarly
- Added `toMeshAsset()` helper function
- Maintained backward compatibility with `toLucidUnit` alias

### 3. CIP-30 Payer (`cip30-payer.ts`)

Key changes:
- Updated imports to use MeshJS `BrowserWallet` instead of Lucid
- Modified `Cip30PayerConfig` to accept:
  - `wallet?: BrowserWallet` (preferred)
  - `walletName?: WalletName` (for auto-connection)
  - `walletApi?: Cip30EnabledWalletApi` (legacy, throws error)
- Updated `getBalance()` to use:
  - `wallet.getLovelace()` for ADA balance
  - `wallet.getBalance()` for native tokens (returns `Asset[]`)
- Updated `pay()` flow:
  - Builds transaction with `buildPaymentTx(wallet, request)`
  - Signs with `wallet.signTx(unsignedTx)`
  - Submits with `wallet.submitTx(signedTx)`
- Added `createCip30PayerFromWallet()` factory function
- Added helper methods: `getBrowserWallet()`, `isConnected()`, `getNetwork()`

### 4. Wallet Connector (`wallet-connector.ts`)

Key changes:
- Removed global `Window.cardano` type declaration (conflicts with MeshJS types)
- Added type casts where needed to handle MeshJS type differences
- Updated `isWalletConnected()` to check if `isEnabled` function exists

### 5. Index (`index.ts`)

Key changes:
- Updated factory function `createCip30Payer()` to use `BrowserWallet.enable()`
- Re-exported `BrowserWallet` from `@meshsdk/core` for convenience
- Simplified `CreateCip30PayerOptions` (removed Blockfrost options, not needed with MeshJS)

### 6. Build Configuration (`tsup.config.ts`)

- Updated external dependencies to use `@meshsdk/core` instead of `lucid-cardano`

## API Reference

### Main Exports

```typescript
// Payer class
export { Cip30Payer, type Cip30PayerConfig, type CardanoNetwork } from "./cip30-payer.js";

// Factory functions
export { createCip30Payer } from "./index.js";
export { createCip30PayerFromWallet } from "./cip30-payer.js";

// Wallet connection (legacy CIP-30 API)
export { getAvailableWallets, connectWallet, ... } from "./wallet-connector.js";

// Transaction building
export { buildPaymentTx, buildBatchPaymentTx, ... } from "./tx-builder.js";

// MeshJS re-export
export { BrowserWallet } from "@meshsdk/core";
```

### Usage Examples

#### Quick Start with Factory
```typescript
import { createCip30Payer } from "@fluxpointstudios/poi-sdk-payer-cardano-cip30";

const payer = await createCip30Payer("nami", "mainnet");
const proof = await payer.pay(paymentRequest);
console.log("Transaction hash:", proof.txHash);
```

#### Manual Setup with BrowserWallet
```typescript
import { Cip30Payer, BrowserWallet } from "@fluxpointstudios/poi-sdk-payer-cardano-cip30";

const wallet = await BrowserWallet.enable("eternl");
const payer = new Cip30Payer({
  wallet,
  network: "mainnet",
  validateNetwork: true,
});

if (payer.supports(paymentRequest)) {
  const proof = await payer.pay(paymentRequest);
}
```

#### Using Wallet Name for Lazy Connection
```typescript
import { Cip30Payer } from "@fluxpointstudios/poi-sdk-payer-cardano-cip30";

// Wallet connects on first use
const payer = new Cip30Payer({
  walletName: "lace",
  network: "preprod",
});

// Connection happens here
const address = await payer.getAddress("cardano:preprod");
```

## MeshJS Best Practices Applied

1. **Wallet Connectivity**: Uses `BrowserWallet.enable()` for CIP-30 wallet connection
2. **Transaction Building**: Uses `Transaction` class with `initiator` pattern
3. **UTxO Selection**: Handled automatically by MeshJS `Transaction.build()`
4. **Network Detection**: Uses `wallet.getNetworkId()` for validation
5. **Collateral Selection**: Exposed via `getCollateral()` method
6. **Error Handling**: Graceful handling of wallet disconnects and user rejections

## Test Files Created

### Unit Tests

1. **`src/__tests__/tx-builder.test.ts`**
   - Tests for `isAdaAsset()`, `parseAssetId()`, `toMeshUnit()`, `toMeshAsset()`
   - Tests for `calculateTotalAmount()` with inclusive/additional splits
   - Tests for `collectPaymentOutputs()` with various split configurations

2. **`src/__tests__/wallet-connector.test.ts`**
   - Tests for wallet discovery functions
   - Tests for `WalletConnectionError` handling
   - Tests for `connectWallet()` with mocked `window.cardano`

3. **`src/__tests__/cip30-payer.test.ts`**
   - Tests for `supports()`, `getAddress()`, `getBalance()`
   - Tests for `pay()` including error cases
   - Tests for network validation
   - Tests with mocked `BrowserWallet`

### Running Tests

```bash
cd packages/payer-cardano-cip30
pnpm test

# Or from root
pnpm test packages/payer-cardano-cip30
```

## Known Limitations

1. **Legacy `walletApi` Not Supported**: The old `Cip30EnabledWalletApi` config option is deprecated. Use `wallet` (BrowserWallet) or `walletName` instead.

2. **Metadata Support**: Transaction metadata is accepted in `BuildPaymentOptions` but not yet implemented in `buildPaymentTx()`. MeshJS Transaction class supports this via `setMetadata()`.

3. **TTL Configuration**: TTL slots option is accepted but not implemented. MeshJS handles this automatically.

## Dependencies

### Production
- `@fluxpointstudios/poi-sdk-core`: workspace:*

### Peer Dependencies
- `@meshsdk/core`: >=1.5.0

### Development
- `@meshsdk/core`: ^1.7.15
- `tsup`: ^8.0.1
- `typescript`: ^5.3.3
- `vitest`: ^1.2.0

## Recommended Tests for Test Engineer

### Unit Tests to Verify

1. **Transaction Builder**
   - Verify split payment calculations (inclusive vs additional modes)
   - Verify asset conversion functions
   - Mock MeshJS Transaction class to test output construction

2. **Wallet Connector**
   - Mock `window.cardano` with various wallet configurations
   - Test error codes for different failure scenarios

3. **CIP-30 Payer**
   - Mock BrowserWallet methods for full flow testing
   - Test balance checks before payment
   - Test error wrapping (InsufficientBalanceError, PaymentFailedError)
   - Test network validation

### Integration Tests (Browser Environment)

1. Connect to testnet wallet (Eternl/Nami on preprod)
2. Get balance
3. Execute small payment (1 ADA)
4. Verify transaction hash returned

### Test Commands

```bash
# Type checking
pnpm typecheck

# Build
pnpm build

# Run unit tests
pnpm test

# Run with coverage
pnpm test -- --coverage
```

## Instructions for Test Engineer

1. Read this document to understand the MeshJS migration
2. Create additional test cases in `packages/payer-cardano-cip30/src/__tests__/`
3. Focus on:
   - MeshJS Transaction class mocking
   - Split payment edge cases
   - Error handling for wallet operations
4. For browser integration tests, use preprod network with test ADA

## Files Modified/Created

| File | Status |
|------|--------|
| `package.json` | Modified - updated dependencies |
| `tsup.config.ts` | Modified - updated externals |
| `src/index.ts` | Modified - MeshJS factory |
| `src/cip30-payer.ts` | Modified - MeshJS BrowserWallet |
| `src/tx-builder.ts` | Modified - MeshJS Transaction |
| `src/wallet-connector.ts` | Modified - type compatibility |
| `src/__tests__/tx-builder.test.ts` | Created |
| `src/__tests__/wallet-connector.test.ts` | Created |
| `src/__tests__/cip30-payer.test.ts` | Created |
| `docs/payer-cardano-cip30-meshjs-implementation.md` | Created |

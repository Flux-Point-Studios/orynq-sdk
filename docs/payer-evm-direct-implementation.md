# @fluxpointstudios/poi-sdk-payer-evm-direct Implementation Summary

## Overview

The `@fluxpointstudios/poi-sdk-payer-evm-direct` package has been implemented at `D:\fluxPoint\PoI\poi-sdk\packages\payer-evm-direct`. This is a legacy EVM payer for direct ERC-20 transfers using the viem library.

## Key Features

- Direct ERC-20 transfers without x402 facilitator
- Support for multiple EVM chains: Base, Ethereum, Polygon, Arbitrum
- Pre-configured USDC contract addresses for all supported chains
- Balance checking before transfer execution
- Returns `evm-txhash` proof type for servers that verify payments on-chain
- NOT x402 compatible - designed for servers accepting raw transaction hashes

## Package Structure

```
packages/payer-evm-direct/
├── package.json           # Package configuration, deps: @fluxpointstudios/poi-sdk-core, viem (peer)
├── tsconfig.json          # TypeScript configuration extending monorepo base
├── tsup.config.ts         # Build configuration for ESM/CJS outputs
└── src/
    ├── index.ts           # Main entry point with exports and factory function
    ├── viem-payer.ts      # ViemPayer class implementing Payer interface
    ├── usdc-transfer.ts   # ERC-20 transfer and balance utilities
    └── constants.ts       # USDC addresses and ERC-20 ABI
```

## Files Implemented

### 1. `src/constants.ts`
- `USDC_ADDRESSES`: Map of CAIP-2 chain IDs to USDC contract addresses
- `ERC20_ABI`: Minimal ABI for transfer, balanceOf, and decimals functions
- `hasUsdcSupport()`: Type guard for supported USDC chains
- `getUsdcAddress()`: Helper to get USDC address for a chain

### 2. `src/usdc-transfer.ts`
- `CHAIN_CONFIGS`: Map of CAIP-2 chain IDs to viem Chain objects
- `transferErc20()`: Execute ERC-20 transfer with simulation and confirmation
- `getErc20Balance()`: Query ERC-20 balance for an address
- `getViemChain()`: Get viem chain config for a CAIP-2 ID
- `isChainSupported()`: Check if chain is supported
- `getSupportedChains()`: Get all supported chain IDs

### 3. `src/viem-payer.ts`
- `ViemPayer` class implementing `@fluxpointstudios/poi-sdk-core` Payer interface
- Methods: `supports()`, `getAddress()`, `getBalance()`, `pay()`
- Lazy client initialization with caching
- Configurable RPC URLs and chain support

### 4. `src/index.ts`
- Exports all types and functions
- `createEvmPayer()`: Convenience factory function

## Dependencies

### Production Dependencies
- `@fluxpointstudios/poi-sdk-core`: workspace:* (core types and interfaces)

### Peer Dependencies
- `viem`: >=2.0.0 (EVM client library)

### Dev Dependencies
- `tsup`: ^8.0.1
- `typescript`: ^5.3.3
- `viem`: ^2.7.0

## Supported Chains

| Chain | CAIP-2 ID | USDC Address |
|-------|-----------|--------------|
| Ethereum Mainnet | eip155:1 | 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 |
| Base Mainnet | eip155:8453 | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 |
| Base Sepolia | eip155:84532 | 0x036CbD53842c5426634e7929541eC2318f3dCF7e |
| Polygon Mainnet | eip155:137 | 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 |
| Arbitrum One | eip155:42161 | 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 |

## Usage Example

```typescript
import { createEvmPayer, ViemPayer } from "@fluxpointstudios/poi-sdk-payer-evm-direct";

// Using factory function
const payer = createEvmPayer("0x...", {
  chains: ["eip155:8453"],
  rpcUrls: {
    "eip155:8453": "https://mainnet.base.org",
  },
});

// Or using class directly
const payer = new ViemPayer({
  privateKey: "0x...",
  chains: ["eip155:8453", "eip155:84532"],
});

// Execute payment
const proof = await payer.pay({
  protocol: "flux",
  chain: "eip155:8453",
  asset: "USDC",
  amountUnits: "1000000", // 1 USDC
  payTo: "0x1234...5678",
});
// proof = { kind: "evm-txhash", txHash: "0x..." }
```

## Build Status

- TypeScript typecheck: PASSED
- Build (ESM + CJS + DTS): PASSED

---

## Recommended Tests

The test engineer should verify the following test scenarios for `@fluxpointstudios/poi-sdk-payer-evm-direct`:

### Unit Tests

1. **ViemPayer Construction**
   - Should throw if neither privateKey nor account provided
   - Should accept privateKey and derive account
   - Should accept pre-configured account
   - Should default to Base mainnet/Sepolia chains
   - Should accept custom chains list
   - Should accept custom RPC URLs

2. **ViemPayer.supports()**
   - Should return true for supported chains
   - Should return false for unsupported chains
   - Should return false for chains not in CHAIN_CONFIGS

3. **ViemPayer.getAddress()**
   - Should return the same address for all chains
   - Should return checksummed address

4. **ViemPayer.getBalance()** (requires mocking)
   - Should query native ETH balance for "ETH" or "native"
   - Should query ERC-20 balance for "USDC"
   - Should query ERC-20 balance for custom contract address

5. **ViemPayer.pay()** (requires mocking)
   - Should throw InsufficientBalanceError if balance too low
   - Should execute ERC-20 transfer for USDC
   - Should execute native ETH transfer for ETH
   - Should return evm-txhash proof type
   - Should calculate total amount including additional splits

6. **Constants**
   - Should export correct USDC addresses for all chains
   - Should export valid ERC20 ABI

7. **usdc-transfer utilities**
   - transferErc20 should throw for unsupported chains
   - getErc20Balance should throw for unsupported chains
   - CHAIN_CONFIGS should have entries for all USDC chains

### Integration Tests (if testnet available)

1. Query real balance on Base Sepolia
2. Execute small USDC transfer on Base Sepolia
3. Verify transaction confirmation

### Test Commands

```bash
cd packages/payer-evm-direct
pnpm typecheck           # Verify types
pnpm build               # Build package
pnpm test                # Run tests (once test files added)
```

### Test File Location

Tests should be created at:
- `packages/payer-evm-direct/src/__tests__/viem-payer.test.ts`
- `packages/payer-evm-direct/src/__tests__/usdc-transfer.test.ts`
- `packages/payer-evm-direct/src/__tests__/constants.test.ts`

---

**Instructions for Test Engineer**: Please read this file and implement the recommended unit tests using vitest. Mock viem clients for unit tests and optionally create integration tests for Base Sepolia testnet verification.

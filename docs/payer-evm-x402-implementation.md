# @fluxpointstudios/orynq-sdk-payer-evm-x402 Implementation Summary

## Overview

The `@fluxpointstudios/orynq-sdk-payer-evm-x402` package has been implemented as an EVM Payer for the x402 payment protocol using EIP-3009 "Transfer With Authorization" for gasless token transfers.

## Files Created

### Package Configuration

| File | Description |
|------|-------------|
| `packages/payer-evm-x402/package.json` | Package manifest with dependencies and build scripts |
| `packages/payer-evm-x402/tsconfig.json` | TypeScript configuration extending base tsconfig |
| `packages/payer-evm-x402/tsup.config.ts` | Build configuration for ESM/CJS dual outputs |

### Source Files

| File | Description |
|------|-------------|
| `src/index.ts` | Main entry point with factory functions and re-exports |
| `src/x402-payer.ts` | Main Payer implementation for EIP-3009 signatures |
| `src/signers/index.ts` | Signer implementations barrel export |
| `src/signers/viem-signer.ts` | Viem wallet signer for browser/Node.js |
| `src/signers/kms-signer.ts` | AWS KMS signer stub for server-side (requires implementation) |

## Key Features

### 1. Gasless Payment UX
- Buyer signs an EIP-3009 authorization (no gas required)
- Facilitator/server submits the on-chain transaction and pays gas
- Atomic token transfer using "transferWithAuthorization"

### 2. EIP-3009 "Transfer With Authorization"
- Time-bounded authorization (validAfter, validBefore)
- Nonce-based replay protection
- Can be executed by any party (typically facilitator)
- No approval transactions required

### 3. EIP-712 Typed Data Signing
- Secure domain-separated signatures
- Human-readable signing requests in wallets
- Standard USDC domain (name: "USD Coin", version: "2")

### 4. Supported Chains
- Base Mainnet (eip155:8453)
- Base Sepolia Testnet (eip155:84532)

### 5. Signer Architecture
- **ViemSigner**: Browser/Node.js with private key or wallet connector
- **KmsSigner**: AWS KMS stub for production server-side (requires implementation)

## Dependencies

### Runtime Dependencies
- `@fluxpointstudios/orynq-sdk-core`: workspace:* (protocol-neutral types and utilities)
- `@fluxpointstudios/orynq-sdk-transport-x402`: workspace:* (x402 protocol transport)

### Peer Dependencies
- `viem`: >=2.0.0 (required)
- `@x402/evm`: >=0.1.0 (optional)

### Dev Dependencies
- `tsup`: ^8.0.1
- `typescript`: ^5.3.3
- `viem`: ^2.7.0

## API Reference

### Factory Functions

```typescript
// Quick setup with private key
function createEvmX402Payer(
  privateKey: `0x${string}`,
  options?: Partial<Omit<EvmX402PayerConfig, "signer">>
): EvmX402Payer;

// Setup with custom signer
function createEvmX402PayerWithSigner(
  signer: ViemSigner,
  options?: Partial<Omit<EvmX402PayerConfig, "signer">>
): EvmX402Payer;
```

### EvmX402Payer

```typescript
class EvmX402Payer implements Payer {
  readonly supportedChains: readonly ChainId[];

  supports(request: PaymentRequest): boolean;
  getAddress(chain: ChainId): Promise<string>;
  getBalance(chain: ChainId, asset: string): Promise<bigint>;
  pay(request: PaymentRequest): Promise<PaymentProof>;
}
```

### ViemSigner

```typescript
class ViemSigner implements Signer {
  constructor(config: ViemSignerConfig);

  getAddress(chain: ChainId): Promise<string>;
  sign(payload: Uint8Array, chain: ChainId): Promise<Uint8Array>;
  signMessage(message: string, chain: ChainId): Promise<string>;
  getAccount(): Account;
  supportsTypedData(): boolean;
}
```

## Usage Examples

### Basic Usage

```typescript
import { createEvmX402Payer } from "@fluxpointstudios/orynq-sdk-payer-evm-x402";

const payer = createEvmX402Payer("0x...", {
  chains: ["eip155:8453"], // Base mainnet
});

const proof = await payer.pay({
  protocol: "x402",
  chain: "eip155:8453",
  asset: "USDC",
  amountUnits: "1000000", // 1 USDC
  payTo: "0x...",
});

// proof.kind === "x402-signature"
// Use proof.signature in PAYMENT-SIGNATURE header
```

### Custom Signer Configuration

```typescript
import { EvmX402Payer, ViemSigner } from "@fluxpointstudios/orynq-sdk-payer-evm-x402";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount("0x...");
const signer = new ViemSigner({ account });

const payer = new EvmX402Payer({
  signer,
  chains: ["eip155:8453", "eip155:84532"],
  rpcUrls: {
    "eip155:8453": "https://mainnet.base.org",
  },
});
```

### Integration with @fluxpointstudios/orynq-sdk-client

```typescript
import { createPoiClient } from "@fluxpointstudios/orynq-sdk-client";
import { createEvmX402Payer } from "@fluxpointstudios/orynq-sdk-payer-evm-x402";

const payer = createEvmX402Payer("0x...");
const client = createPoiClient({
  payers: [payer],
});

// Client automatically handles x402 402 responses
const response = await client.fetch("https://api.example.com/resource");
```

## EIP-3009 Signature Structure

The `pay()` method returns an `X402SignatureProof` with a base64-encoded JSON payload:

```typescript
interface X402SignaturePayload {
  signature: string;      // EIP-712 signature (0x-prefixed hex)
  from: string;           // Payer address
  to: string;             // Recipient address
  value: string;          // Amount in atomic units
  validAfter: string;     // Unix timestamp (0 = immediately valid)
  validBefore: string;    // Unix timestamp (expiration)
  nonce: string;          // Random 32-byte hex (0x-prefixed)
  chainId: number;        // EVM chain ID
  contract: string;       // USDC contract address
}
```

## Build Status

- TypeScript compilation: PASSED
- ESM build: PASSED (16.54 KB)
- CJS build: PASSED (16.70 KB)
- DTS generation: PASSED (20.63 KB)

---

## Test Engineer Instructions

The following tests should be run to verify the implementation:

### Recommended Test Suite

1. **Unit Tests for ViemSigner (signers/viem-signer.ts)**
   - Test constructor with privateKey
   - Test constructor with account
   - Test constructor throws without privateKey or account
   - Test `getAddress()` returns correct address
   - Test `sign()` returns signature as Uint8Array
   - Test `sign()` throws if account doesn't support signMessage
   - Test `signMessage()` returns hex signature
   - Test `getAccount()` returns the account
   - Test `supportsTypedData()` returns true for signing accounts

2. **Unit Tests for KmsSigner (signers/kms-signer.ts)**
   - Test constructor stores config
   - Test `getAddress()` throws NotImplemented error
   - Test `sign()` throws NotImplemented error
   - Test `signMessage()` throws NotImplemented error
   - Test `getKeyId()` returns configured key ID
   - Test `getRegion()` returns configured region

3. **Unit Tests for EvmX402Payer (x402-payer.ts)**
   - Test `supports()` returns true for x402 protocol on supported chains
   - Test `supports()` returns false for non-x402 protocol
   - Test `supports()` returns false for unsupported chains
   - Test `getAddress()` returns signer address
   - Test `getBalance()` for native ETH
   - Test `getBalance()` for USDC (mocked RPC)
   - Test `pay()` throws for non-x402 protocol
   - Test `pay()` throws InsufficientBalanceError when balance too low
   - Test `pay()` returns x402-signature proof
   - Test `pay()` creates valid EIP-712 signature structure
   - Test signature payload contains all required fields

4. **Unit Tests for Factory Functions (index.ts)**
   - Test `createEvmX402Payer()` creates payer with default options
   - Test `createEvmX402Payer()` accepts custom chains and rpcUrls
   - Test `createEvmX402PayerWithSigner()` uses provided signer

5. **Integration Tests**
   - Test full payment flow: create payer -> pay request -> verify proof
   - Test signature can be parsed and contains valid parameters
   - Test with mock x402 server (if available)

6. **EIP-3009 Signature Verification**
   - Verify signature structure matches EIP-712 typed data
   - Verify domain matches USDC contract (name, version, chainId, verifyingContract)
   - Verify message contains all TransferWithAuthorization fields
   - Verify nonce is 32 bytes
   - Verify validBefore is in the future
   - Verify signature is recoverable to from address

### Test Commands

```bash
cd packages/payer-evm-x402
pnpm test          # Run tests once
pnpm test:watch    # Run tests in watch mode
pnpm typecheck     # Verify TypeScript types
pnpm build         # Verify build succeeds
```

### Mock Data for Tests

```typescript
import { createEvmX402Payer } from "@fluxpointstudios/orynq-sdk-payer-evm-x402";
import type { PaymentRequest } from "@fluxpointstudios/orynq-sdk-core";

// Test private key (DO NOT USE IN PRODUCTION)
const TEST_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Sample payment request
const sampleRequest: PaymentRequest = {
  protocol: "x402",
  chain: "eip155:84532", // Base Sepolia
  asset: "USDC",
  amountUnits: "1000000", // 1 USDC
  payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  timeoutSeconds: 3600,
};

// Create payer for testing
const payer = createEvmX402Payer(TEST_PRIVATE_KEY, {
  chains: ["eip155:84532"],
});

// Test payment
const proof = await payer.pay(sampleRequest);
console.log("Proof kind:", proof.kind);
console.log("Signature (base64):", proof.signature);
```

### USDC Contract Addresses

| Chain | USDC Address |
|-------|--------------|
| Base Mainnet (eip155:8453) | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 |
| Base Sepolia (eip155:84532) | 0x036CbD53842c5426634e7929541eC2318f3dCF7e |

### Notes for Test Engineer

1. **Mocking RPC Calls**: Balance checks and contract reads require RPC access. Use viem's test utilities or mock the publicClient methods.

2. **Signature Verification**: To verify EIP-712 signatures, use viem's `verifyTypedData()` function with the same domain and types.

3. **KMS Signer**: The KMS signer is a stub. Tests should verify it throws appropriate errors indicating implementation is needed.

4. **Cross-Platform**: The package should work in both browser and Node.js. Consider testing base64 encoding in both environments.

5. **Error Cases**: Ensure proper error handling for:
   - Invalid private keys
   - Unsupported chains
   - Unsupported assets
   - Insufficient balance
   - Accounts without signTypedData support

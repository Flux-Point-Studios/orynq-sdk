# orynq-sdk

A dual-protocol commerce layer supporting **x402** (Coinbase standard) for EVM chains and **Flux protocol** (T-Backend style) for Cardano.

## Features

- **Dual Protocol Support** - Seamlessly handle both x402 and Flux payment protocols
- **Multi-Chain** - EVM chains (Ethereum, Base, Polygon, etc.) and Cardano
- **Auto-Pay Client** - Automatic 402 detection, payment, and retry
- **Budget Controls** - Per-request and daily spending limits
- **Server Middleware** - Express/Fastify middleware emitting both protocols
- **Protocol Gateway** - Bridge x402 clients to Flux backends
- **Cross-Language** - TypeScript and Python SDKs with verified compatibility
- **Type-Safe** - Full TypeScript support with strict types

## Installation

```bash
# Core package
pnpm add @fluxpointstudios/orynq-sdk-core

# Client with auto-pay
pnpm add @fluxpointstudios/orynq-sdk-client

# Payer adapters (choose based on your chain)
pnpm add @fluxpointstudios/orynq-sdk-payer-cardano-cip30  # Browser wallets
pnpm add @fluxpointstudios/orynq-sdk-payer-cardano-node   # Server-side Cardano
pnpm add @fluxpointstudios/orynq-sdk-payer-evm-x402       # EIP-3009 gasless
pnpm add @fluxpointstudios/orynq-sdk-payer-evm-direct     # Direct ERC-20 transfers

# Server middleware
pnpm add @fluxpointstudios/orynq-sdk-server-middleware

# Protocol gateway
pnpm add @fluxpointstudios/orynq-sdk-gateway
```

### Python

```bash
pip install orynq-sdk
```

## Quick Start

### Client (TypeScript)

```typescript
import { PoiClient } from '@fluxpointstudios/orynq-sdk-client';
import { createCip30Payer } from '@fluxpointstudios/orynq-sdk-payer-cardano-cip30';

// Create a payer from a CIP-30 wallet
const payer = await createCip30Payer(window.cardano.nami);

// Create client with auto-pay enabled
const client = new PoiClient({
  payer,
  autoPay: true,
  budget: {
    maxPerRequest: '10000000',  // 10 ADA in lovelace
    maxPerDay: '100000000',     // 100 ADA per day
  },
});

// Make requests - payments happen automatically on 402
const response = await client.fetch('https://api.example.com/premium-data');
const data = await response.json();
```

### Client (Python)

```python
from poi_sdk import PoiClient, BudgetConfig

client = PoiClient(
    payer=my_payer,
    auto_pay=True,
    budget=BudgetConfig(
        max_per_request="10000000",
        max_per_day="100000000",
    ),
)

response = await client.fetch("https://api.example.com/premium-data")
data = response.json()
```

### Server Middleware (Express)

```typescript
import express from 'express';
import {
  requirePayment,
  MemoryInvoiceStore,
  CardanoVerifier,
  cors402,
} from '@fluxpointstudios/orynq-sdk-server-middleware';

const app = express();
app.use(express.json());
app.use(require('cors')(cors402()));

const store = new MemoryInvoiceStore();
const verifier = new CardanoVerifier({
  blockfrostProjectId: process.env.BLOCKFROST_KEY!,
});

app.get(
  '/premium',
  requirePayment({
    price: async () => ({
      chain: 'cardano:mainnet',
      asset: 'ADA',
      amountUnits: '1000000', // 1 ADA
    }),
    payTo: 'addr1...',
    storage: store,
    verifiers: [verifier],
    protocols: ['flux', 'x402'],
  }),
  (_req, res) => res.json({ data: 'premium content' })
);
```

> **Note:** The middleware emits both Flux and x402 402 responses, but x402 signature settlement is handled by the gateway, not the middleware directly.

### Protocol Gateway

Bridge x402 clients to Flux backends:

```typescript
import { startGateway } from '@fluxpointstudios/orynq-sdk-gateway';

// Start a standalone gateway server
await startGateway({
  backendUrl: 'https://flux-backend.example.com',
  payTo: '0x742d35Cc6634C0532925a3b844Bc9e7595f9fEDb',
  chains: ['eip155:8453'],
  pricing: async (req) => ({
    chain: 'eip155:8453',
    asset: 'USDC',
    amountUnits: '1000000',  // 1 USDC
  }),
  x402: {
    mode: 'strict',
    facilitatorUrl: 'https://facilitator.example.com',
  },
});
// Gateway is now running and proxying /api/* routes to the backend
```

Or for more control over the Express app:

```typescript
import { createGatewayServer } from '@fluxpointstudios/orynq-sdk-gateway';

const { app } = createGatewayServer({
  backendUrl: 'https://flux-backend.example.com',
  payTo: '0x742d35Cc6634C0532925a3b844Bc9e7595f9fEDb',
  chains: ['eip155:8453'],
  pricing: async (req) => ({
    chain: 'eip155:8453',
    asset: 'USDC',
    amountUnits: '1000000',
  }),
  x402: { mode: 'strict', facilitatorUrl: 'https://facilitator.example.com' },
});

// Gateway protects /api/* routes with payment verification
app.listen(3402);
```

#### Gateway x402 Settlement Modes

The gateway supports the following `x402.mode` values:

| Mode | Behavior |
|------|----------|
| `strict` (default) | Decodes signature, validates against stored invoice (amount/payTo/chain), calls facilitator to settle, marks invoice consumed |
| `verify-precheck` | Currently behaves the same as `strict` (reserved for future crypto pre-verification) |
| `trust` | **Dev only** - Accepts any signature without verification. Blocked in production; requires `ALLOW_INSECURE_TRUST_MODE=true` |

## Packages

| Package | Description |
|---------|-------------|
| `@fluxpointstudios/orynq-sdk-core` | Protocol-neutral types, utilities, and chain definitions |
| `@fluxpointstudios/orynq-sdk-transport-x402` | x402 wire format (parse/apply headers) |
| `@fluxpointstudios/orynq-sdk-transport-flux` | Flux wire format (parse/apply headers) |
| `@fluxpointstudios/orynq-sdk-client` | Auto-pay HTTP client with budget tracking |
| `@fluxpointstudios/orynq-sdk-payer-cardano-cip30` | CIP-30 browser wallet payer |
| `@fluxpointstudios/orynq-sdk-payer-cardano-node` | Server-side Cardano payer (Blockfrost/Koios) |
| `@fluxpointstudios/orynq-sdk-payer-evm-x402` | EIP-3009 gasless EVM payer |
| `@fluxpointstudios/orynq-sdk-payer-evm-direct` | Direct ERC-20 transfer payer |
| `@fluxpointstudios/orynq-sdk-server-middleware` | Express/Fastify payment middleware |
| `@fluxpointstudios/orynq-sdk-gateway` | x402 ↔ Flux protocol bridge |
| `@fluxpointstudios/orynq-sdk-cli` | Command-line interface |
| `orynq-sdk` (Python) | Python SDK with async support |

## Protocol Overview

### x402 (EVM)

The [x402 protocol](https://github.com/coinbase/x402) uses HTTP 402 responses with payment requirements in the `PAYMENT-REQUIRED` header (base64-encoded JSON) and payment proofs in the `PAYMENT-SIGNATURE` header.

> **Important (orynq-sdk invoice binding):** orynq-sdk binds x402 payments to an issued invoice to prevent replay/cross-endpoint abuse. The paid retry **must include**:
> - `X-Invoice-Id` from the initial 402 response body, **or**
> - `X-Idempotency-Key` that was used to generate the invoice
>
> If you send only `PAYMENT-SIGNATURE` without an invoice reference, the gateway will reject it as "No invoice found".

```
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: eyJhbW91bnQiOiIxMDAwMDAwIi4uLn0=
Content-Type: application/json

{"error":"Payment Required","invoiceId":"inv_abc123","protocol":"x402"}

# After payment:
GET /resource
PAYMENT-SIGNATURE: eyJ0eElkIjoiMHguLi4iLi4ufQ==
X-Invoice-Id: inv_abc123
```

### Flux Protocol (Cardano)

The Flux protocol returns payment requirements via `X-*` headers in 402 responses, and accepts payment proofs via the `X-Payment` header.

**Response Headers (402 Payment Required):**
- `X-Invoice-Id` - Unique invoice identifier
- `X-Pay-To` - Recipient address (addr1...)
- `X-Amount` - Payment amount in atomic units (lovelace)
- `X-Asset` - Asset identifier (e.g., "ADA", policy.assetHex)
- `X-Chain` - Blockchain identifier (e.g., "cardano-mainnet")
- `X-Timeout` - Payment timeout in seconds

**Request Headers (Payment Proof):**
- `X-Payment` - JSON payment proof (txHash, cborHex, etc.)
- `X-Invoice-Id` - Invoice being paid
- `X-Wallet-Address` - Payer's wallet address
- `X-Chain` - Blockchain used for payment
- `X-Partner` - Optional partner/referrer ID
- `X-Idempotency-Key` - Request-level idempotency key

```
HTTP/1.1 402 Payment Required
Content-Type: application/json
X-Invoice-Id: inv_abc123
X-Pay-To: addr1...
X-Amount: 1000000
X-Asset: ADA
X-Chain: cardano-mainnet
X-Timeout: 300

# After payment:
GET /resource
X-Payment: {"txHash":"abc123...","outputIndex":0}
X-Invoice-Id: inv_abc123
X-Wallet-Address: addr1...
X-Chain: cardano-mainnet
```

### CORS Configuration

For browser-based clients to read payment headers, your server must expose them:

```typescript
// Express example
app.use((req, res, next) => {
  res.setHeader('Access-Control-Expose-Headers', [
    'X-Invoice-Id',
    'X-Pay-To',
    'X-Amount',
    'X-Asset',
    'X-Chain',
    'X-Timeout',
    'X-Payment-Verified',
    'PAYMENT-REQUIRED',   // x402
    'PAYMENT-SIGNATURE',  // x402
  ].join(', '));
  next();
});
```

## Protocol Comparison

| Aspect | Flux (Cardano) | x402 (EVM) |
|--------|----------------|------------|
| **Payment Header** | `X-Payment` (JSON with txHash) | `PAYMENT-SIGNATURE` (EIP-3009) |
| **Settlement** | On-chain tx already confirmed | Facilitator executes transfer |
| **Verification** | Check tx on Blockfrost/Koios | Check signature + settlement |
| **Replay Protection** | txHash + outputIndex uniqueness | Invoice binding + consumption |
| **Assets** | ADA, native tokens | USDC, ETH, ERC-20 |

### Flux Protocol Flow

```
Client                          Server                      Blockchain
  |                               |                             |
  |  GET /resource                |                             |
  |------------------------------>|                             |
  |                               |                             |
  |  402 + X-Invoice-Id,          |                             |
  |       X-Pay-To, X-Amount      |                             |
  |<------------------------------|                             |
  |                               |                             |
  |  Build & submit tx            |                             |
  |------------------------------------------------------>|    |
  |                               |                             |
  |  <tx confirmed>               |                             |
  |<------------------------------------------------------|    |
  |                               |                             |
  |  GET /resource                |                             |
  |  + X-Payment: {txHash}        |                             |
  |------------------------------>|                             |
  |                               |  Verify tx on-chain         |
  |                               |---------------------------->|
  |                               |<----------------------------|
  |  200 OK + content             |                             |
  |<------------------------------|                             |
```

### x402 Protocol Flow

```
Client                          Server                      Facilitator
  |                               |                             |
  |  GET /resource                |                             |
  |------------------------------>|                             |
  |                               |                             |
  |  402 + PAYMENT-REQUIRED       |                             |
  |  (base64 JSON)                |                             |
  |<------------------------------|                             |
  |                               |                             |
  |  Sign EIP-3009 authorization  |                             |
  |  (no on-chain tx yet)         |                             |
  |                               |                             |
  |  GET /resource                |                             |
  |  + PAYMENT-SIGNATURE          |                             |
  |------------------------------>|                             |
  |                               |  Forward signature          |
  |                               |---------------------------->|
  |                               |  Execute transferWithAuth   |
  |                               |<----------------------------|
  |  200 OK + content             |                             |
  |<------------------------------|                             |
```

## Protocol Support Matrix

| SDK | Flux Protocol | x402 Protocol |
|-----|---------------|---------------|
| TypeScript | Full | Full |
| Python | Full | Not yet |

## Chain Identifiers

The SDK uses [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) chain identifiers internally:

| Chain | CAIP-2 ID |
|-------|-----------|
| Cardano Mainnet | `cardano:mainnet` |
| Cardano Preprod | `cardano:preprod` |
| Cardano Preview | `cardano:preview` |
| Ethereum | `eip155:1` |
| Base | `eip155:8453` |
| Base Sepolia | `eip155:84532` |
| Polygon | `eip155:137` |

## Configuration

### Budget Controls

```typescript
const client = new PoiClient({
  payer,
  budget: {
    maxPerRequest: '5000000',    // Max per single request
    maxPerDay: '50000000',       // Daily spending limit
    store: customBudgetStore,    // Optional: custom persistence
  },
});
```

### Invoice Caching

```typescript
const client = new PoiClient({
  payer,
  invoiceCache: {
    get: async (key) => cache.get(key),
    set: async (key, invoice, ttl) => cache.set(key, invoice, ttl),
  },
});
```

### Custom Signers

For HSM/KMS integration:

```typescript
import { Signer } from '@fluxpointstudios/orynq-sdk-core';

const kmsSigner: Signer = {
  sign: async (message: Uint8Array) => {
    return await kmsClient.sign({ message });
  },
  getPublicKey: async () => {
    return await kmsClient.getPublicKey();
  },
};
```

## Cross-Language Compatibility

The TypeScript and Python SDKs produce identical outputs for:

- **Canonical JSON** (RFC 8785) - Deterministic serialization
- **SHA-256 hashing** - Idempotency keys, invoice hashes
- **Payment request/proof structures**

Verify compatibility with the included test vectors:

```bash
# Generate vectors (TypeScript)
pnpm vectors:generate

# Verify in TypeScript
pnpm vectors:verify

# Verify in Python
pnpm vectors:verify:python

# Verify both
pnpm vectors:verify:all
```

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Run tests with coverage
pnpm test:coverage

# Type checking
pnpm typecheck

# Linting
pnpm lint
pnpm lint:fix
```

### Python Development

```bash
cd python

# Install with dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Run tests with coverage
pytest --cov=poi_sdk
```

## CLI

```bash
# Install globally
pnpm add -g @fluxpointstudios/orynq-sdk-cli

# Generate an invoice
poi invoice --amount 1000000 --currency ADA --recipient addr1...

# Check payment status
poi status --tx-id abc123...

# Make a paid request
poi call https://api.example.com/premium --auto-pay

# Test x402 compatibility
poi test-x402 https://api.example.com
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests (`pnpm test`)
5. Run cross-language verification (`pnpm vectors:verify:all`)
6. Commit your changes (`git commit -m 'Add amazing feature'`)
7. Push to the branch (`git push origin feature/amazing-feature`)
8. Open a Pull Request

## License

[MIT](LICENSE)

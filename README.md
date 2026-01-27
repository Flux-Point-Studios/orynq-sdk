# poi-sdk

A dual-protocol commerce layer supporting **x402 v2** (Coinbase standard) for EVM chains and **Flux protocol** (T-Backend style) for Cardano.

## Features

- **Dual Protocol Support** - Seamlessly handle both x402 v2 and Flux payment protocols
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
pnpm add @poi-sdk/core

# Client with auto-pay
pnpm add @poi-sdk/client

# Payer adapters (choose based on your chain)
pnpm add @poi-sdk/payer-cardano-cip30  # Browser wallets
pnpm add @poi-sdk/payer-cardano-node   # Server-side Cardano
pnpm add @poi-sdk/payer-evm-x402       # EIP-3009 gasless
pnpm add @poi-sdk/payer-evm-direct     # Direct ERC-20 transfers

# Server middleware
pnpm add @poi-sdk/server-middleware

# Protocol gateway
pnpm add @poi-sdk/gateway
```

### Python

```bash
pip install poi-sdk
```

## Quick Start

### Client (TypeScript)

```typescript
import { PoiClient } from '@poi-sdk/client';
import { createCip30Payer } from '@poi-sdk/payer-cardano-cip30';

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
import { createPaymentMiddleware } from '@poi-sdk/server-middleware';

const app = express();

const paymentMiddleware = createPaymentMiddleware({
  pricing: async (req) => ({
    amount: '1000000',  // 1 ADA
    currency: 'ADA',
    recipient: 'addr1...',
  }),
  verify: async (proof) => {
    // Verify payment on-chain
    return { valid: true };
  },
  protocols: ['flux', 'x402'],  // Emit both protocols
});

app.get('/premium', paymentMiddleware, (req, res) => {
  res.json({ data: 'premium content' });
});
```

### Protocol Gateway

Bridge x402 clients to Flux backends:

```typescript
import { createGateway } from '@poi-sdk/gateway';

const gateway = createGateway({
  upstream: 'https://flux-backend.example.com',
  payer: serverSidePayer,
  addVerifiedHeader: true,  // Adds X-Paid-Verified for upstream
});

// x402 clients can now access Flux-only backends
app.use('/api', gateway);
```

## Packages

| Package | Description |
|---------|-------------|
| `@poi-sdk/core` | Protocol-neutral types, utilities, and chain definitions |
| `@poi-sdk/transport-x402` | x402 v2 wire format (parse/apply headers) |
| `@poi-sdk/transport-flux` | Flux wire format (parse/apply headers) |
| `@poi-sdk/client` | Auto-pay HTTP client with budget tracking |
| `@poi-sdk/payer-cardano-cip30` | CIP-30 browser wallet payer |
| `@poi-sdk/payer-cardano-node` | Server-side Cardano payer (Blockfrost/Koios) |
| `@poi-sdk/payer-evm-x402` | EIP-3009 gasless EVM payer |
| `@poi-sdk/payer-evm-direct` | Direct ERC-20 transfer payer |
| `@poi-sdk/server-middleware` | Express/Fastify payment middleware |
| `@poi-sdk/gateway` | x402 ↔ Flux protocol bridge |
| `@poi-sdk/cli` | Command-line interface |
| `poi-sdk` (Python) | Python SDK with async support |

## Protocol Overview

### x402 v2 (EVM)

The [x402 protocol](https://github.com/coinbase/x402) uses HTTP 402 responses with payment requirements in the `PAYMENT-REQUIRED` header (base64-encoded JSON) and payment proofs in the `PAYMENT-SIGNATURE` header.

```
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: eyJhbW91bnQiOiIxMDAwMDAwIi4uLn0=

# After payment:
GET /resource
PAYMENT-SIGNATURE: eyJ0eElkIjoiMHguLi4iLi4ufQ==
```

### Flux Protocol (Cardano)

The Flux protocol returns payment requirements as JSON in the response body with `X-Payment-*` headers, and accepts payment proofs via `X-Paid-*` headers.

```
HTTP/1.1 402 Payment Required
Content-Type: application/json
X-Payment-Address: addr1...
X-Payment-Amount: 1000000

# After payment:
GET /resource
X-Paid-TxId: abc123...
X-Paid-Index: 0
```

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
import { Signer } from '@poi-sdk/core';

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
pnpm add -g @poi-sdk/cli

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

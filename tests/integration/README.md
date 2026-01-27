# Integration Tests

This directory contains end-to-end integration tests for the poi-sdk packages against real testnets.

## Overview

The integration tests verify the complete payment flow across:

- **Cardano Preprod** (testnet magic: 1)
- **Base Sepolia** (chain ID: 84532)

All tests are designed to be skipped gracefully when credentials are not available, making them CI-ready.

## Test Files

| File | Description |
|------|-------------|
| `setup.ts` | Shared utilities, environment loading, and test helpers |
| `cardano.integration.test.ts` | Cardano payment flow tests using BlockfrostProvider |
| `evm.integration.test.ts` | EVM payment tests (direct transfers and x402 signatures) |
| `client-auto-pay.integration.test.ts` | PoiClient auto-pay flow with mock and real payers |
| `server-verification.integration.test.ts` | Server-side payment verification tests |

## Environment Variables

### Required for Cardano Tests

```bash
# Blockfrost API key for Cardano Preprod
# Get one at: https://blockfrost.io
BLOCKFROST_API_KEY=preprodXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

# Hex-encoded Ed25519 private key (64 or 128 characters)
# WARNING: Use only test wallets with testnet funds!
TEST_CARDANO_PRIVATE_KEY=your-hex-private-key
```

### Required for EVM Tests

```bash
# Hex-encoded private key with 0x prefix
# WARNING: Use only test wallets with testnet funds!
TEST_EVM_PRIVATE_KEY=0xyour-private-key

# Optional: Custom RPC URL for Base Sepolia
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
```

## Test Wallet Setup

### Cardano Preprod

1. **Create a Test Wallet**
   - Use [cardano-cli](https://github.com/input-output-hk/cardano-node) to generate keys
   - Or export from a wallet like [Eternl](https://eternl.io) or [Nami](https://namiwallet.io)

2. **Fund the Wallet**
   - Get testnet ADA from the [Cardano Faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/)
   - Need at least 10 ADA for running tests

3. **Export Private Key**
   ```bash
   # Using cardano-cli
   cardano-cli key verification-key --signing-key-file payment.skey --verification-key-file payment.vkey

   # Get hex from the skey file (extract the 'cborHex' and decode)
   ```

### Base Sepolia (EVM)

1. **Create a Test Wallet**
   - Use MetaMask, Rabby, or any EVM wallet
   - Create a new account for testing

2. **Fund the Wallet**
   - Get testnet ETH from [Coinbase Faucet](https://www.coinbase.com/faucets/base-ethereum-goerli-faucet)
   - For USDC tests, bridge some testnet USDC or use a test token faucet

3. **Export Private Key**
   - In MetaMask: Account details > Export private key
   - Must include the `0x` prefix

## Running Tests

### Run All Integration Tests

```bash
# From the repository root
pnpm test tests/integration

# Or with environment variables inline
BLOCKFROST_API_KEY=preprodXXX TEST_CARDANO_PRIVATE_KEY=abc123 pnpm test tests/integration
```

### Run Specific Test File

```bash
# Cardano tests only
pnpm test tests/integration/cardano.integration.test.ts

# EVM tests only
pnpm test tests/integration/evm.integration.test.ts

# Client auto-pay tests
pnpm test tests/integration/client-auto-pay.integration.test.ts

# Server verification tests
pnpm test tests/integration/server-verification.integration.test.ts
```

### Run with Verbose Output

```bash
pnpm test tests/integration -- --reporter=verbose
```

### Run in CI Mode (No Watch)

```bash
pnpm test tests/integration -- --run
```

## GitHub Actions Setup

Create a `.github/workflows/integration-tests.yml`:

```yaml
name: Integration Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  # Allow manual trigger
  workflow_dispatch:

jobs:
  integration-tests:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v2
        with:
          version: 8

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - run: pnpm install

      - run: pnpm build

      - name: Run Integration Tests
        run: pnpm test tests/integration -- --run
        env:
          BLOCKFROST_API_KEY: ${{ secrets.BLOCKFROST_API_KEY }}
          TEST_CARDANO_PRIVATE_KEY: ${{ secrets.TEST_CARDANO_PRIVATE_KEY }}
          TEST_EVM_PRIVATE_KEY: ${{ secrets.TEST_EVM_PRIVATE_KEY }}
          BASE_SEPOLIA_RPC_URL: ${{ secrets.BASE_SEPOLIA_RPC_URL }}
```

### Setting Up GitHub Secrets

1. Go to your repository Settings > Secrets and variables > Actions
2. Add the following secrets:
   - `BLOCKFROST_API_KEY`: Your Blockfrost Preprod API key
   - `TEST_CARDANO_PRIVATE_KEY`: Test wallet private key (Cardano)
   - `TEST_EVM_PRIVATE_KEY`: Test wallet private key (EVM)
   - `BASE_SEPOLIA_RPC_URL`: (Optional) Custom RPC URL

## Test Scenarios

### Cardano Tests

1. **ADA Payment (Server-Side)**
   - Connect to Blockfrost Preprod
   - Fetch UTxOs and protocol parameters
   - Build and submit payment transaction
   - Verify transaction on-chain

2. **Native Token Payment**
   - Similar flow with native assets
   - Currently limited to ADA (native tokens not yet supported)

### EVM Tests

1. **ERC-20 Direct Transfer**
   - Connect to Base Sepolia
   - Execute USDC transfer
   - Verify transaction receipt

2. **EIP-3009 Gasless Signature**
   - Create TransferWithAuthorization signature
   - Verify signature validity
   - Decode and validate authorization

### Client Auto-Pay Tests

1. **Full Auto-Pay Flow**
   - Mock server returns 402
   - Client detects payment required
   - Client executes payment
   - Client retries with proof
   - Verify successful response

2. **Budget Enforcement**
   - Per-request limits
   - Daily spending limits
   - Budget tracking

### Server Verification Tests

1. **Cardano Verification**
   - Verify transaction hash proofs
   - Handle invalid/missing transactions
   - Check amount and recipient

2. **EVM Verification**
   - Verify ERC-20 Transfer events
   - Verify EIP-3009 events
   - Trust facilitator mode for x402

## Test Amounts

The tests use minimal amounts to preserve testnet funds:

| Asset | Amount | Units |
|-------|--------|-------|
| ADA | 1 ADA | 1,000,000 lovelace |
| USDC | 0.01 USDC | 10,000 units |
| ETH | 0.001 ETH | 1,000,000,000,000,000 wei |

## Troubleshooting

### Tests Skipped

If tests show as skipped, check:
1. Environment variables are set correctly
2. API keys are valid
3. Wallet has sufficient funds

### Blockfrost Rate Limits

Free Blockfrost accounts have rate limits. If you see 429 errors:
- Wait a few seconds between test runs
- Consider upgrading your Blockfrost plan

### Insufficient Balance

If balance-related tests fail:
1. Check wallet balance on explorer
2. Request more testnet funds from faucet
3. Ensure you're connected to the correct network

### RPC Connection Issues

For EVM tests, if RPC fails:
1. Try the default public RPC (remove BASE_SEPOLIA_RPC_URL)
2. Use a different RPC provider
3. Check network status

## Security Notes

**IMPORTANT: Never use real private keys or mainnet wallets for testing!**

- Always use dedicated test wallets
- Only fund with testnet tokens
- Never commit private keys to source control
- Use environment variables or secrets management
- The MemorySigner intentionally shows warnings about development-only usage

## Contributing

When adding new integration tests:

1. Follow the existing test structure
2. Use `describe.skipIf()` for conditional test suites
3. Add helpful skip messages for missing credentials
4. Document any new environment variables
5. Use small test amounts to preserve testnet funds
6. Clean up any test state when possible

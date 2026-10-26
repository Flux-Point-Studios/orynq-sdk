# orynq-sdk Python

> **Note:** The Python SDK currently supports **Flux protocol only** (Cardano).
> x402 protocol support for EVM chains is planned for a future release.

Dual-protocol commerce layer for Cardano/EVM payments.

## Installation

```bash
pip install orynq-sdk
```

### Optional Dependencies

```bash
# For Cardano support (pycardano)
pip install orynq-sdk[cardano]

# For AWS KMS signing
pip install orynq-sdk[aws]

# For development
pip install orynq-sdk[dev]
```

## Trace interoperability

Use `json.dumps(bundle.to_dict())` to export a finalized Python trace in the
TypeScript `TraceBundle` wire format. The export includes private events; share
`bundle.public_view` when only public disclosure is intended.

Span hashes include `eventIds` and `childSpanIds`, and empty spans have no
trailing hash separator. These corrections change hashes produced by earlier
Python versions; existing commitments cannot be rewritten. Commands and
observations default to public, while decisions default to private, matching
the TypeScript SDK. Set `visibility` explicitly to choose another policy.

The Python `manifest_hash` is a hash of `bundle.content` (the public view).
It is distinct from the TypeScript storage manifest and is not exported as
`manifestHash`.

For repository development, install `python/.[dev]` and run `pytest python/tests`.
This includes JSON Schema validation and the required shared hash fixtures.
Install workspace Node dependencies with `pnpm install` to also run the actual
TypeScript verifier against Python bundles. Live faucet tests still require
`ORYNQ_RUN_LIVE_TESTS=1`.

## Quick Start

```python
import asyncio
from orynq_sdk import PoiClient, BudgetConfig

async def main():
    # Create a client with auto-pay enabled
    client = PoiClient(
        base_url="https://api.example.com",
        payer=my_payer,  # Your Payer implementation
        partner="my_partner_id",
        budget=BudgetConfig(
            max_per_request="1000000",  # 1 ADA max per request
            max_per_day="10000000",      # 10 ADA max per day
        )
    )

    async with client:
        # Requests automatically handle 402 Payment Required
        result = await client.request(
            "/v1/inference",
            body={"prompt": "Hello, world!"}
        )
        print(result)

asyncio.run(main())
```

## Implementing a Payer

```python
from orynq_sdk import BasePayer, PaymentRequest, PaymentProof

class MyCardanoPayer(BasePayer):
    supported_chains = ["cardano:mainnet", "cardano:preprod"]

    async def get_address(self, chain: str) -> str:
        # Return your wallet address
        return "addr1..."

    async def pay(self, request: PaymentRequest) -> PaymentProof:
        # Build and submit transaction
        tx_hash = await self._submit_payment(request)
        return PaymentProof(
            kind="cardano-txhash",
            tx_hash=tx_hash
        )

    async def get_balance(self, chain: str, asset: str) -> int:
        # Query wallet balance
        return 5000000  # 5 ADA in lovelace
```

## Features

- **Auto-pay**: Automatically handles 402 Payment Required responses
- **Budget tracking**: Per-request and daily spending limits
- **Invoice caching**: Prevents double-payment
- **Streaming**: NDJSON streaming support for long-running requests
- **Signers**: Memory (dev) and KMS (prod) signer implementations

## Version & Protocol Support

**v0.1.0**

| Protocol | Status |
|----------|--------|
| Flux (Cardano) | Supported |
| x402 (EVM) | Not yet supported |

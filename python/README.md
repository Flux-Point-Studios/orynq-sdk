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

## Quick Start

```python
import asyncio
from poi_sdk import PoiClient, BudgetConfig

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
from poi_sdk import BasePayer, PaymentRequest, PaymentProof

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

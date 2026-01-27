# Python poi-sdk Implementation Summary

## Overview

This document summarizes the implementation of the Python poi-sdk v1 (Flux protocol only) and provides test recommendations for the test engineer.

## Implementation Details

### Files Created

| File | Location | Purpose |
|------|----------|---------|
| `pyproject.toml` | `python/pyproject.toml` | Package configuration with dependencies |
| `types.py` | `python/poi_sdk/types.py` | Pydantic models for all data structures |
| `transport_flux.py` | `python/poi_sdk/transport_flux.py` | Flux wire format parsing and header management |
| `payer.py` | `python/poi_sdk/payer.py` | Payer and Signer protocols + BasePayer class |
| `budget.py` | `python/poi_sdk/budget.py` | Budget tracking with daily/per-request limits |
| `invoice_cache.py` | `python/poi_sdk/invoice_cache.py` | Invoice caching to prevent double-pay |
| `stream.py` | `python/poi_sdk/stream.py` | NDJSON streaming utilities |
| `client.py` | `python/poi_sdk/client.py` | Main PoiClient with auto-pay functionality |
| `__init__.py` | `python/poi_sdk/__init__.py` | Package exports |
| `signers/__init__.py` | `python/poi_sdk/signers/__init__.py` | Signers package exports |
| `signers/memory.py` | `python/poi_sdk/signers/memory.py` | Dev-only in-memory signer |
| `signers/kms.py` | `python/poi_sdk/signers/kms.py` | AWS KMS signer stub |
| `README.md` | `python/README.md` | Package documentation |

### Key Features Implemented

1. **Pydantic Models** - All types use string amounts to prevent precision loss
2. **Flux Protocol Support** - Complete parsing and header handling for Flux 402 responses
3. **Budget Tracking** - Per-request and daily limits with configurable reset hour
4. **Invoice Caching** - Prevents double-payment with idempotency key support
5. **Async Client** - Full async/await support with httpx
6. **NDJSON Streaming** - Support for streaming API responses
7. **Signer Stubs** - MemorySigner (dev) and KmsSigner (prod) with clear NotImplementedError messages

### Dependencies

- **Required**: `httpx>=0.25.0`, `pydantic>=2.0.0`
- **Optional cardano**: `pycardano>=0.10.0`
- **Optional aws**: `boto3>=1.34.0`
- **Optional dev**: `pytest>=7.0.0`, `pytest-asyncio>=0.21.0`

---

## Recommended Tests

### 1. Unit Tests for Types (`test_types.py`)

```python
import pytest
from poi_sdk.types import PaymentRequest, PaymentProof, BudgetConfig, SplitConfig, SplitOutput

class TestPaymentRequest:
    def test_basic_creation(self):
        """Test creating a PaymentRequest with required fields."""
        req = PaymentRequest(
            chain="cardano:mainnet",
            asset="ADA",
            amount_units="1000000",
            pay_to="addr1..."
        )
        assert req.amount_units == "1000000"
        assert req.protocol == "flux"

    def test_alias_fields(self):
        """Test that aliased fields work with camelCase."""
        req = PaymentRequest(
            chain="cardano:mainnet",
            asset="ADA",
            amountUnits="1000000",  # Using alias
            payTo="addr1...",
            invoiceId="inv_123"
        )
        assert req.amount_units == "1000000"
        assert req.invoice_id == "inv_123"

    def test_string_amounts_preserved(self):
        """Test that large amounts are preserved as strings."""
        req = PaymentRequest(
            chain="cardano:mainnet",
            asset="ADA",
            amount_units="999999999999999999",
            pay_to="addr1..."
        )
        assert req.amount_units == "999999999999999999"

class TestSplitConfig:
    def test_split_creation(self):
        """Test creating split configuration."""
        split = SplitConfig(
            mode="inclusive",
            outputs=[
                SplitOutput(to="addr1...", amount_units="100000", role="platform_fee")
            ]
        )
        assert split.mode == "inclusive"
        assert len(split.outputs) == 1
```

### 2. Unit Tests for Transport (`test_transport_flux.py`)

```python
import pytest
from unittest.mock import MagicMock
from poi_sdk.transport_flux import is_flux_402, parse_flux_invoice, apply_payment_headers
from poi_sdk.types import PaymentProof

class TestIsFlux402:
    def test_valid_flux_402(self):
        """Test detection of valid Flux 402 response."""
        response = MagicMock()
        response.status_code = 402
        response.headers = {"content-type": "application/json"}
        assert is_flux_402(response) is True

    def test_not_402(self):
        """Test that non-402 returns False."""
        response = MagicMock()
        response.status_code = 200
        response.headers = {"content-type": "application/json"}
        assert is_flux_402(response) is False

    def test_x402_protocol(self):
        """Test that x402 responses are not detected as Flux."""
        response = MagicMock()
        response.status_code = 402
        response.headers = {
            "content-type": "application/json",
            "payment-required": "some-value"
        }
        assert is_flux_402(response) is False

class TestParseFluxInvoice:
    def test_basic_parsing(self):
        """Test parsing a basic Flux invoice."""
        data = {
            "invoiceId": "inv_123",
            "chain": "cardano-mainnet",
            "currency": "ADA",
            "amount": "1000000",
            "payTo": "addr1..."
        }
        req = parse_flux_invoice(data)
        assert req.invoice_id == "inv_123"
        assert req.chain == "cardano:mainnet"  # Converted to CAIP-2
        assert req.amount_units == "1000000"

    def test_split_parsing(self):
        """Test parsing invoice with splits."""
        data = {
            "chain": "cardano-preprod",
            "currency": "ADA",
            "amount": "2000000",
            "payTo": "addr1...",
            "splitMode": "additional",
            "splits": [
                {"to": "addr2...", "amount": "100000", "role": "platform_fee"}
            ]
        }
        req = parse_flux_invoice(data)
        assert req.splits is not None
        assert req.splits.mode == "additional"
        assert len(req.splits.outputs) == 1

class TestApplyPaymentHeaders:
    def test_cardano_txhash(self):
        """Test applying Cardano tx hash payment headers."""
        proof = PaymentProof(kind="cardano-txhash", tx_hash="abc123")
        headers = apply_payment_headers({}, "inv_123", proof)
        assert headers["X-Invoice-Id"] == "inv_123"
        assert headers["X-Payment"] == "abc123"
```

### 3. Unit Tests for Budget (`test_budget.py`)

```python
import pytest
from poi_sdk.budget import BudgetTracker, MemoryBudgetStore, BudgetExceededError
from poi_sdk.types import BudgetConfig

@pytest.fixture
def budget_store():
    return MemoryBudgetStore()

class TestBudgetTracker:
    @pytest.mark.asyncio
    async def test_per_request_limit(self, budget_store):
        """Test per-request limit enforcement."""
        config = BudgetConfig(max_per_request="1000000")
        tracker = BudgetTracker(config, budget_store)

        # Should pass
        await tracker.check_budget("cardano:mainnet", "ADA", 500000)

        # Should fail
        with pytest.raises(BudgetExceededError):
            await tracker.check_budget("cardano:mainnet", "ADA", 2000000)

    @pytest.mark.asyncio
    async def test_daily_limit(self, budget_store):
        """Test daily limit enforcement."""
        config = BudgetConfig(max_per_day="5000000")
        tracker = BudgetTracker(config, budget_store)

        # First spend
        await tracker.check_budget("cardano:mainnet", "ADA", 3000000)
        await tracker.record_spend("cardano:mainnet", "ADA", 3000000)

        # Second spend should fail
        with pytest.raises(BudgetExceededError):
            await tracker.check_budget("cardano:mainnet", "ADA", 3000000)

    @pytest.mark.asyncio
    async def test_remaining_budget(self, budget_store):
        """Test remaining budget calculation."""
        config = BudgetConfig(max_per_day="10000000")
        tracker = BudgetTracker(config, budget_store)

        await tracker.record_spend("cardano:mainnet", "ADA", 3000000)
        remaining = await tracker.get_remaining_budget("cardano:mainnet", "ADA")
        assert remaining == 7000000
```

### 4. Unit Tests for Invoice Cache (`test_invoice_cache.py`)

```python
import pytest
from poi_sdk.invoice_cache import MemoryInvoiceCache
from poi_sdk.types import PaymentProof

class TestMemoryInvoiceCache:
    @pytest.mark.asyncio
    async def test_set_and_get(self):
        """Test basic set and get operations."""
        cache = MemoryInvoiceCache()
        proof = PaymentProof(kind="cardano-txhash", tx_hash="abc123")

        await cache.set_paid("inv_123", proof)
        result = await cache.get_paid("inv_123")

        assert result is not None
        assert result.tx_hash == "abc123"

    @pytest.mark.asyncio
    async def test_idempotency_key(self):
        """Test idempotency key lookup."""
        cache = MemoryInvoiceCache()
        proof = PaymentProof(kind="cardano-txhash", tx_hash="abc123")

        await cache.set_paid("inv_123", proof, idempotency_key="key_abc")
        result = await cache.get_by_idempotency_key("key_abc")

        assert result is not None
        assert result.tx_hash == "abc123"

    @pytest.mark.asyncio
    async def test_not_found(self):
        """Test that missing invoices return None."""
        cache = MemoryInvoiceCache()
        result = await cache.get_paid("nonexistent")
        assert result is None
```

### 5. Integration Tests for Client (`test_client.py`)

```python
import pytest
import json
from unittest.mock import AsyncMock, MagicMock, patch
from poi_sdk import PoiClient, BasePayer, PaymentRequest, PaymentProof, BudgetConfig

class MockPayer(BasePayer):
    supported_chains = ["cardano:mainnet"]

    async def get_address(self, chain: str) -> str:
        return "addr1_mock"

    async def pay(self, request: PaymentRequest) -> PaymentProof:
        return PaymentProof(kind="cardano-txhash", tx_hash="mock_tx_hash")

    async def get_balance(self, chain: str, asset: str) -> int:
        return 10000000

class TestPoiClient:
    @pytest.mark.asyncio
    async def test_simple_request(self):
        """Test request that doesn't require payment."""
        payer = MockPayer()

        with patch("httpx.AsyncClient") as mock_client_class:
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = {"result": "success"}

            mock_client = AsyncMock()
            mock_client.request.return_value = mock_response
            mock_client.aclose = AsyncMock()
            mock_client_class.return_value = mock_client

            async with PoiClient("https://api.example.com", payer) as client:
                result = await client.request("/v1/test", body={"data": "test"})
                assert result == {"result": "success"}

    @pytest.mark.asyncio
    async def test_402_auto_pay(self):
        """Test automatic payment on 402 response."""
        payer = MockPayer()

        with patch("httpx.AsyncClient") as mock_client_class:
            # First response: 402
            mock_402_response = MagicMock()
            mock_402_response.status_code = 402
            mock_402_response.headers = {"content-type": "application/json"}
            mock_402_response.json.return_value = {
                "invoiceId": "inv_123",
                "chain": "cardano-mainnet",
                "currency": "ADA",
                "amount": "1000000",
                "payTo": "addr1..."
            }

            # Second response: 200 (after payment)
            mock_200_response = MagicMock()
            mock_200_response.status_code = 200
            mock_200_response.json.return_value = {"result": "paid"}
            mock_200_response.raise_for_status = MagicMock()

            mock_client = AsyncMock()
            mock_client.request.side_effect = [mock_402_response, mock_200_response]
            mock_client.aclose = AsyncMock()
            mock_client_class.return_value = mock_client

            async with PoiClient("https://api.example.com", payer) as client:
                result = await client.request("/v1/test")
                assert result == {"result": "paid"}
                # Verify payment was made
                assert mock_client.request.call_count == 2
```

---

## Test Execution Instructions

### Setup

```bash
cd D:\fluxPoint\PoI\poi-sdk\python

# Create virtual environment
python -m venv venv
venv\Scripts\activate  # Windows
# source venv/bin/activate  # Linux/Mac

# Install package with dev dependencies
pip install -e ".[dev]"
```

### Run Tests

```bash
# Run all tests
pytest tests/ -v

# Run with coverage
pytest tests/ -v --cov=poi_sdk --cov-report=html

# Run specific test file
pytest tests/test_types.py -v

# Run async tests
pytest tests/ -v --asyncio-mode=auto
```

### Test File Structure

Create the following test structure:
```
python/
├── tests/
│   ├── __init__.py
│   ├── test_types.py
│   ├── test_transport_flux.py
│   ├── test_budget.py
│   ├── test_invoice_cache.py
│   ├── test_stream.py
│   └── test_client.py
```

---

## Notes for Test Engineer

1. **All amounts are strings** - This is intentional to prevent JavaScript/Python number precision issues with large blockchain amounts. Tests should verify string handling.

2. **Async operations** - All client and cache methods are async. Use `pytest-asyncio` with `@pytest.mark.asyncio` decorator.

3. **Mock httpx carefully** - The client uses `httpx.AsyncClient` with context managers. Mocking requires careful setup of both sync and async methods.

4. **Budget reset hour** - The budget tracker supports daily reset at a configurable hour. Tests should mock `datetime.now()` to test edge cases around reset time.

5. **Signers raise NotImplementedError** - This is expected. The stubs require optional dependencies (pycardano, boto3) that may not be installed during testing.

6. **CAIP-2 chain format** - The transport layer converts simple chain names (e.g., "cardano-mainnet") to CAIP-2 format (e.g., "cardano:mainnet"). Tests should verify this conversion.

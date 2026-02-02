"""
Tests for poi_sdk.client module.

Tests the PoiClient class with mock-based testing for HTTP requests
and payment handling.
"""

import json
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

from poi_sdk.client import PoiClient
from poi_sdk.types import (
    PaymentRequest,
    PaymentProof,
    BudgetConfig,
)
from poi_sdk.budget import BudgetExceededError


class TestPoiClientInit:
    """Tests for PoiClient initialization."""

    def test_basic_init(self, mock_payer):
        """Test basic client initialization."""
        client = PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
        )
        assert client.base_url == "https://api.example.com"
        assert client.payer == mock_payer
        assert client.partner is None
        assert client.timeout == 120.0

    def test_removes_trailing_slash(self, mock_payer):
        """Test that trailing slash is removed from base_url."""
        client = PoiClient(
            base_url="https://api.example.com/",
            payer=mock_payer,
        )
        assert client.base_url == "https://api.example.com"

    def test_with_partner(self, mock_payer):
        """Test initialization with partner."""
        client = PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
            partner="my_partner_id",
        )
        assert client.partner == "my_partner_id"

    def test_with_custom_timeout(self, mock_payer):
        """Test initialization with custom timeout."""
        client = PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
            timeout=30.0,
        )
        assert client.timeout == 30.0

    def test_with_default_headers(self, mock_payer):
        """Test initialization with default headers."""
        headers = {"Authorization": "Bearer token123"}
        client = PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
            headers=headers,
        )
        assert client.default_headers == headers

    def test_with_budget_config(self, mock_payer):
        """Test initialization with budget configuration."""
        budget = BudgetConfig(
            max_per_request="2000000",
            max_per_day="10000000",
        )
        client = PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
            budget=budget,
        )
        assert client._budget_tracker is not None

    def test_without_budget_config(self, mock_payer):
        """Test initialization without budget configuration."""
        client = PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
        )
        assert client._budget_tracker is None


class TestPoiClientContextManager:
    """Tests for PoiClient async context manager."""

    async def test_async_context_manager(self, mock_payer):
        """Test using client as async context manager."""
        async with PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
        ) as client:
            assert client is not None

    async def test_close_method(self, mock_payer):
        """Test explicit close method."""
        client = PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
        )
        # Should not raise
        await client.close()


class TestPoiClientRequest:
    """Tests for PoiClient.request method."""

    @pytest.fixture
    def client(self, mock_payer):
        """Create a client for testing."""
        return PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
            partner="test_partner",
        )

    async def test_successful_request(self, client):
        """Test a successful request without payment."""
        expected_response = {"result": "success", "data": [1, 2, 3]}

        with patch.object(client._http, "request") as mock_request:
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = expected_response
            mock_response.raise_for_status = MagicMock()
            mock_request.return_value = mock_response

            result = await client.request("/v1/data", body={"query": "test"})

            assert result == expected_response
            mock_request.assert_called_once()

    async def test_request_with_402_payment(self, client, sample_invoice):
        """Test request that triggers 402 and automatic payment."""
        # First response is 402, second is success
        expected_response = {"result": "paid_content"}

        with patch.object(client._http, "request") as mock_request:
            # Create 402 response
            flux_response = MagicMock()
            flux_response.status_code = 402
            flux_response.headers = {"content-type": "application/json"}
            flux_response.json.return_value = sample_invoice

            # Create success response
            success_response = MagicMock()
            success_response.status_code = 200
            success_response.json.return_value = expected_response
            success_response.raise_for_status = MagicMock()

            mock_request.side_effect = [flux_response, success_response]

            result = await client.request("/v1/paid", body={"prompt": "test"})

            assert result == expected_response
            # Should have made two requests: initial and retry with payment
            assert mock_request.call_count == 2

            # Verify payment was called
            client.payer.pay.assert_called_once()

    async def test_request_budget_exceeded(self, mock_payer, sample_invoice):
        """Test that budget exceeded error is raised."""
        budget = BudgetConfig(max_per_request="1000000")  # Less than invoice amount
        client = PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
            budget=budget,
        )

        with patch.object(client._http, "request") as mock_request:
            flux_response = MagicMock()
            flux_response.status_code = 402
            flux_response.headers = {"content-type": "application/json"}
            flux_response.json.return_value = sample_invoice  # 2000000 amount
            mock_request.return_value = flux_response

            with pytest.raises(BudgetExceededError):
                await client.request("/v1/paid")

    async def test_request_uses_cached_payment(self, client, sample_invoice):
        """Test that cached payment proofs are reused."""
        # Pre-populate invoice cache
        proof = PaymentProof(kind="cardano-txhash", tx_hash="cached_tx_hash")
        await client._invoice_cache.set_paid(sample_invoice["invoiceId"], proof)

        expected_response = {"result": "from_cache"}

        with patch.object(client._http, "request") as mock_request:
            # First response is 402
            flux_response = MagicMock()
            flux_response.status_code = 402
            flux_response.headers = {"content-type": "application/json"}
            flux_response.json.return_value = sample_invoice

            # Success response
            success_response = MagicMock()
            success_response.status_code = 200
            success_response.json.return_value = expected_response
            success_response.raise_for_status = MagicMock()

            mock_request.side_effect = [flux_response, success_response]

            result = await client.request("/v1/paid")

            assert result == expected_response
            # Payment should NOT have been called (used cached proof)
            client.payer.pay.assert_not_called()

    async def test_request_post_default_method(self, client):
        """Test that POST is the default HTTP method."""
        with patch.object(client._http, "request") as mock_request:
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = {}
            mock_response.raise_for_status = MagicMock()
            mock_request.return_value = mock_response

            await client.request("/v1/data")

            call_args = mock_request.call_args
            assert call_args[0][0] == "POST"

    async def test_request_custom_method(self, client):
        """Test request with custom HTTP method."""
        with patch.object(client._http, "request") as mock_request:
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = {}
            mock_response.raise_for_status = MagicMock()
            mock_request.return_value = mock_response

            await client.request("/v1/data", method="GET")

            call_args = mock_request.call_args
            assert call_args[0][0] == "GET"

    async def test_request_custom_headers(self, client):
        """Test request with custom headers."""
        with patch.object(client._http, "request") as mock_request:
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = {}
            mock_response.raise_for_status = MagicMock()
            mock_request.return_value = mock_response

            await client.request(
                "/v1/data",
                headers={"X-Custom-Header": "custom_value"}
            )

            call_args = mock_request.call_args
            headers = call_args[1]["headers"]
            assert headers["X-Custom-Header"] == "custom_value"


class TestPoiClientIdempotency:
    """Tests for idempotency key generation."""

    def test_idempotency_key_is_deterministic(self, mock_payer):
        """Test that same request generates same idempotency key."""
        client = PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
        )

        key1 = client._generate_idempotency_key(
            "POST",
            "https://api.example.com/v1/data",
            {"prompt": "test"}
        )
        key2 = client._generate_idempotency_key(
            "POST",
            "https://api.example.com/v1/data",
            {"prompt": "test"}
        )

        assert key1 == key2

    def test_different_bodies_different_keys(self, mock_payer):
        """Test that different request bodies generate different keys."""
        client = PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
        )

        key1 = client._generate_idempotency_key(
            "POST",
            "https://api.example.com/v1/data",
            {"prompt": "test1"}
        )
        key2 = client._generate_idempotency_key(
            "POST",
            "https://api.example.com/v1/data",
            {"prompt": "test2"}
        )

        assert key1 != key2

    def test_different_urls_different_keys(self, mock_payer):
        """Test that different URLs generate different keys."""
        client = PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
        )

        key1 = client._generate_idempotency_key(
            "POST",
            "https://api.example.com/v1/data",
            {"prompt": "test"}
        )
        key2 = client._generate_idempotency_key(
            "POST",
            "https://api.example.com/v2/data",
            {"prompt": "test"}
        )

        assert key1 != key2

    def test_different_methods_different_keys(self, mock_payer):
        """Test that different HTTP methods generate different keys."""
        client = PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
        )

        key1 = client._generate_idempotency_key(
            "POST",
            "https://api.example.com/v1/data",
            {"prompt": "test"}
        )
        key2 = client._generate_idempotency_key(
            "PUT",
            "https://api.example.com/v1/data",
            {"prompt": "test"}
        )

        assert key1 != key2

    def test_key_length(self, mock_payer):
        """Test that idempotency key has expected length."""
        client = PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
        )

        key = client._generate_idempotency_key(
            "POST",
            "https://api.example.com/v1/data",
            {"prompt": "test"}
        )

        assert len(key) == 32


class TestPoiClientConvenienceMethods:
    """Tests for convenience methods."""

    async def test_get_wallet_address(self, mock_payer):
        """Test get_wallet_address method."""
        client = PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
        )

        address = await client.get_wallet_address("cardano:mainnet")

        assert address == "addr_test1..."
        mock_payer.get_address.assert_called_once_with("cardano:mainnet")

    async def test_get_balance(self, mock_payer):
        """Test get_balance method."""
        client = PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
        )

        balance = await client.get_balance("cardano:mainnet", "ADA")

        assert balance == 100_000_000
        mock_payer.get_balance.assert_called_once_with("cardano:mainnet", "ADA")

    async def test_get_remaining_budget(self, mock_payer):
        """Test get_remaining_budget method."""
        budget = BudgetConfig(max_per_day="10000000")
        client = PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
            budget=budget,
        )

        remaining = await client.get_remaining_budget("cardano:mainnet", "ADA")

        assert remaining == 10000000

    async def test_get_remaining_budget_no_budget_config(self, mock_payer):
        """Test get_remaining_budget returns None when no budget configured."""
        client = PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
        )

        remaining = await client.get_remaining_budget("cardano:mainnet", "ADA")

        assert remaining is None


class TestPoiClientX402Detection:
    """Tests for x402 vs Flux protocol detection."""

    async def test_ignores_x402_response(self, mock_payer):
        """Test that x402 responses are not treated as Flux."""
        client = PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
        )

        with patch.object(client._http, "request") as mock_request:
            # x402 response (has payment-required header)
            x402_response = MagicMock()
            x402_response.status_code = 402
            x402_response.headers = {
                "content-type": "application/json",
                "payment-required": "base64_encoded_data"
            }

            # Make raise_for_status actually raise an error for 402
            def raise_for_status():
                raise httpx.HTTPStatusError(
                    "402 Payment Required",
                    request=MagicMock(),
                    response=x402_response
                )
            x402_response.raise_for_status = raise_for_status

            mock_request.return_value = x402_response

            # Should raise because it's not handled as Flux 402
            with pytest.raises(httpx.HTTPStatusError):
                await client.request("/v1/data")


class TestPoiClientBudgetTracking:
    """Tests for budget tracking integration."""

    async def test_records_spending_after_payment(self, mock_payer, sample_invoice):
        """Test that spending is recorded after successful payment."""
        budget = BudgetConfig(max_per_day="100000000")
        client = PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
            budget=budget,
        )

        with patch.object(client._http, "request") as mock_request:
            # 402 response
            flux_response = MagicMock()
            flux_response.status_code = 402
            flux_response.headers = {"content-type": "application/json"}
            flux_response.json.return_value = sample_invoice

            # Success response
            success_response = MagicMock()
            success_response.status_code = 200
            success_response.json.return_value = {"result": "success"}
            success_response.raise_for_status = MagicMock()

            mock_request.side_effect = [flux_response, success_response]

            await client.request("/v1/paid")

        # Check that budget was reduced
        remaining = await client.get_remaining_budget("cardano:mainnet", "ADA")
        assert remaining == 100000000 - 2000000  # Invoice amount was 2000000

    async def test_does_not_record_spending_on_budget_exceeded(
        self, mock_payer, sample_invoice
    ):
        """Test that spending is not recorded when budget is exceeded."""
        budget = BudgetConfig(max_per_request="1000000")  # Less than invoice
        client = PoiClient(
            base_url="https://api.example.com",
            payer=mock_payer,
            budget=budget,
        )

        with patch.object(client._http, "request") as mock_request:
            flux_response = MagicMock()
            flux_response.status_code = 402
            flux_response.headers = {"content-type": "application/json"}
            flux_response.json.return_value = sample_invoice
            mock_request.return_value = flux_response

            with pytest.raises(BudgetExceededError):
                await client.request("/v1/paid")

        # Payment should not have been called
        mock_payer.pay.assert_not_called()

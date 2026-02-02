"""
Tests for poi_sdk.transport_flux module.

Tests Flux wire format parsing, 402 response detection, chain mapping,
and payment header application.
"""

import pytest
from unittest.mock import MagicMock

from poi_sdk.transport_flux import (
    is_flux_402,
    parse_flux_invoice,
    apply_payment_headers,
    FLUX_HEADERS,
    CHAIN_MAPPING,
)
from poi_sdk.types import PaymentProof


class MockResponse:
    """Mock httpx.Response for testing."""

    def __init__(self, status_code, headers=None, content_type="application/json"):
        self.status_code = status_code
        self.headers = headers or {}
        if content_type:
            self.headers["content-type"] = content_type


class TestIsFlux402:
    """Tests for is_flux_402 function."""

    def test_detects_flux_402(self):
        """Test detection of valid Flux 402 response."""
        response = MockResponse(402, content_type="application/json")
        assert is_flux_402(response) is True

    def test_detects_flux_402_with_charset(self):
        """Test detection with charset in content-type."""
        response = MockResponse(402, content_type="application/json; charset=utf-8")
        assert is_flux_402(response) is True

    def test_rejects_non_402(self):
        """Test rejection of non-402 status codes."""
        for status_code in [200, 201, 400, 401, 403, 404, 500]:
            response = MockResponse(status_code, content_type="application/json")
            assert is_flux_402(response) is False

    def test_rejects_x402(self):
        """Test rejection of x402 protocol (uses PAYMENT-REQUIRED header)."""
        response = MockResponse(
            402,
            headers={"payment-required": "base64..."},
            content_type="application/json",
        )
        assert is_flux_402(response) is False

    def test_rejects_non_json(self):
        """Test rejection of non-JSON content types."""
        for content_type in ["text/plain", "text/html", "application/xml"]:
            response = MockResponse(402, content_type=content_type)
            assert is_flux_402(response) is False

    def test_rejects_no_content_type(self):
        """Test rejection when content-type is missing."""
        response = MockResponse(402, content_type=None)
        # headers won't have content-type key
        response.headers = {}
        assert is_flux_402(response) is False


class TestParseFluxInvoice:
    """Tests for parse_flux_invoice function."""

    def test_parses_basic_invoice(self, sample_invoice):
        """Test parsing a basic Flux invoice."""
        request = parse_flux_invoice(sample_invoice)

        assert request.protocol == "flux"
        assert request.invoice_id == "inv_test123"
        assert request.chain == "cardano:mainnet"  # Converted to CAIP-2
        assert request.asset == "ADA"
        assert request.amount_units == "2000000"
        assert request.pay_to == sample_invoice["payTo"]
        assert request.partner == "test_partner"

    def test_parses_invoice_with_splits(self, sample_invoice_with_splits):
        """Test parsing invoice with split payments."""
        request = parse_flux_invoice(sample_invoice_with_splits)

        assert request.splits is not None
        assert request.splits.mode == "inclusive"
        assert len(request.splits.outputs) == 2

        # Check first split
        assert request.splits.outputs[0].to == "addr_partner..."
        assert request.splits.outputs[0].amount_units == "500000"
        assert request.splits.outputs[0].role == "partner"

        # Check second split
        assert request.splits.outputs[1].to == "addr_treasury..."
        assert request.splits.outputs[1].amount_units == "500000"
        assert request.splits.outputs[1].role == "treasury"

    def test_converts_cardano_mainnet_chain(self):
        """Test chain format conversion for cardano-mainnet."""
        invoice = {
            "invoiceId": "test",
            "amount": "1000000",
            "currency": "ADA",
            "payTo": "addr...",
            "chain": "cardano-mainnet",
        }
        request = parse_flux_invoice(invoice)
        assert request.chain == "cardano:mainnet"

    def test_converts_cardano_preprod_chain(self):
        """Test chain format conversion for cardano-preprod."""
        invoice = {
            "invoiceId": "test",
            "amount": "1000000",
            "currency": "ADA",
            "payTo": "addr...",
            "chain": "cardano-preprod",
        }
        request = parse_flux_invoice(invoice)
        assert request.chain == "cardano:preprod"

    def test_converts_base_mainnet_chain(self):
        """Test chain format conversion for base-mainnet."""
        invoice = {
            "invoiceId": "test",
            "amount": "1000000",
            "currency": "USDC",
            "payTo": "0x...",
            "chain": "base-mainnet",
        }
        request = parse_flux_invoice(invoice)
        assert request.chain == "eip155:8453"

    def test_converts_base_sepolia_chain(self):
        """Test chain format conversion for base-sepolia."""
        invoice = {
            "invoiceId": "test",
            "amount": "1000000",
            "currency": "USDC",
            "payTo": "0x...",
            "chain": "base-sepolia",
        }
        request = parse_flux_invoice(invoice)
        assert request.chain == "eip155:84532"

    def test_preserves_unknown_chain_format(self):
        """Test that unknown chain formats are preserved."""
        invoice = {
            "invoiceId": "test",
            "amount": "1000000",
            "currency": "ADA",
            "payTo": "addr...",
            "chain": "unknown:chain",
        }
        request = parse_flux_invoice(invoice)
        assert request.chain == "unknown:chain"

    def test_defaults_currency_to_ada(self):
        """Test that missing currency defaults to ADA."""
        invoice = {
            "invoiceId": "test",
            "amount": "1000000",
            "payTo": "addr...",
            "chain": "cardano-mainnet",
        }
        request = parse_flux_invoice(invoice)
        assert request.asset == "ADA"

    def test_preserves_decimals(self):
        """Test that decimals field is preserved."""
        invoice = {
            "invoiceId": "test",
            "amount": "1000000",
            "currency": "USDC",
            "payTo": "0x...",
            "chain": "base-mainnet",
            "decimals": 6,
        }
        request = parse_flux_invoice(invoice)
        assert request.decimals == 6

    def test_stores_raw_data(self):
        """Test that raw invoice data is stored."""
        invoice = {
            "invoiceId": "test",
            "amount": "1000000",
            "currency": "ADA",
            "payTo": "addr...",
            "chain": "cardano-mainnet",
            "customField": "customValue",
        }
        request = parse_flux_invoice(invoice)
        assert request.raw == invoice
        assert request.raw["customField"] == "customValue"

    def test_handles_split_with_currency(self):
        """Test splits with currency field."""
        invoice = {
            "invoiceId": "test",
            "amount": "3000000",
            "currency": "ADA",
            "payTo": "addr...",
            "chain": "cardano-mainnet",
            "splitMode": "additional",
            "splits": [
                {"to": "addr_fee...", "amount": "100000", "currency": "ADA"},
            ],
        }
        request = parse_flux_invoice(invoice)
        assert request.splits.outputs[0].asset == "ADA"

    def test_handles_empty_splits(self):
        """Test that empty splits list results in None."""
        invoice = {
            "invoiceId": "test",
            "amount": "1000000",
            "currency": "ADA",
            "payTo": "addr...",
            "chain": "cardano-mainnet",
            "splits": [],
        }
        request = parse_flux_invoice(invoice)
        assert request.splits is None

    def test_amount_converted_to_string(self):
        """Test that numeric amounts are converted to strings."""
        invoice = {
            "invoiceId": "test",
            "amount": 1000000,  # numeric
            "currency": "ADA",
            "payTo": "addr...",
            "chain": "cardano-mainnet",
        }
        request = parse_flux_invoice(invoice)
        assert request.amount_units == "1000000"
        assert isinstance(request.amount_units, str)


class TestApplyPaymentHeaders:
    """Tests for apply_payment_headers function."""

    def test_applies_invoice_id_and_payment(self):
        """Test that invoice ID and payment headers are applied."""
        proof = PaymentProof(kind="cardano-txhash", tx_hash="abc123")
        headers = apply_payment_headers({}, "inv_123", proof)

        assert headers[FLUX_HEADERS["INVOICE_ID"]] == "inv_123"
        assert headers[FLUX_HEADERS["PAYMENT"]] == "abc123"

    def test_applies_cardano_txhash_proof(self):
        """Test Cardano txhash proof is applied correctly."""
        proof = PaymentProof(kind="cardano-txhash", tx_hash="tx_hash_123")
        headers = apply_payment_headers({}, "inv_123", proof)

        assert headers[FLUX_HEADERS["PAYMENT"]] == "tx_hash_123"

    def test_applies_cardano_signed_cbor_proof(self):
        """Test Cardano signed CBOR proof is applied correctly."""
        proof = PaymentProof(kind="cardano-signed-cbor", cbor_hex="84a4...")
        headers = apply_payment_headers({}, "inv_123", proof)

        assert headers[FLUX_HEADERS["PAYMENT"]] == "84a4..."

    def test_applies_evm_txhash_proof(self):
        """Test EVM txhash proof is applied correctly."""
        proof = PaymentProof(kind="evm-txhash", tx_hash="0x123abc...")
        headers = apply_payment_headers({}, "inv_123", proof)

        assert headers[FLUX_HEADERS["PAYMENT"]] == "0x123abc..."

    def test_applies_optional_partner(self):
        """Test that partner header is applied when provided."""
        proof = PaymentProof(kind="cardano-txhash", tx_hash="abc123")
        headers = apply_payment_headers({}, "inv_123", proof, partner="my_partner")

        assert headers[FLUX_HEADERS["PARTNER"]] == "my_partner"

    def test_applies_optional_wallet_address(self):
        """Test that wallet address header is applied when provided."""
        proof = PaymentProof(kind="cardano-txhash", tx_hash="abc123")
        headers = apply_payment_headers(
            {}, "inv_123", proof, wallet_address="addr_test1..."
        )

        assert headers[FLUX_HEADERS["WALLET_ADDRESS"]] == "addr_test1..."

    def test_applies_optional_chain(self):
        """Test that chain header is applied when provided."""
        proof = PaymentProof(kind="cardano-txhash", tx_hash="abc123")
        headers = apply_payment_headers(
            {}, "inv_123", proof, chain="cardano:mainnet"
        )

        assert headers[FLUX_HEADERS["CHAIN"]] == "cardano:mainnet"

    def test_applies_optional_idempotency_key(self):
        """Test that idempotency key header is applied when provided."""
        proof = PaymentProof(kind="cardano-txhash", tx_hash="abc123")
        headers = apply_payment_headers(
            {}, "inv_123", proof, idempotency_key="key123"
        )

        assert headers[FLUX_HEADERS["IDEMPOTENCY_KEY"]] == "key123"

    def test_applies_all_optional_headers(self):
        """Test applying all optional headers at once."""
        proof = PaymentProof(kind="cardano-txhash", tx_hash="abc123")
        headers = apply_payment_headers(
            {},
            "inv_123",
            proof,
            partner="my_partner",
            wallet_address="addr...",
            chain="cardano:mainnet",
            idempotency_key="key123",
        )

        assert headers[FLUX_HEADERS["INVOICE_ID"]] == "inv_123"
        assert headers[FLUX_HEADERS["PAYMENT"]] == "abc123"
        assert headers[FLUX_HEADERS["PARTNER"]] == "my_partner"
        assert headers[FLUX_HEADERS["WALLET_ADDRESS"]] == "addr..."
        assert headers[FLUX_HEADERS["CHAIN"]] == "cardano:mainnet"
        assert headers[FLUX_HEADERS["IDEMPOTENCY_KEY"]] == "key123"

    def test_preserves_existing_headers(self):
        """Test that existing headers are preserved."""
        existing_headers = {
            "Content-Type": "application/json",
            "Authorization": "Bearer token123",
        }
        proof = PaymentProof(kind="cardano-txhash", tx_hash="abc123")
        headers = apply_payment_headers(existing_headers, "inv_123", proof)

        assert headers["Content-Type"] == "application/json"
        assert headers["Authorization"] == "Bearer token123"
        assert headers[FLUX_HEADERS["INVOICE_ID"]] == "inv_123"

    def test_does_not_modify_original_headers(self):
        """Test that original headers dict is not modified."""
        existing_headers = {"Content-Type": "application/json"}
        proof = PaymentProof(kind="cardano-txhash", tx_hash="abc123")
        headers = apply_payment_headers(existing_headers, "inv_123", proof)

        # Original should be unchanged
        assert FLUX_HEADERS["INVOICE_ID"] not in existing_headers
        # New dict should have the header
        assert FLUX_HEADERS["INVOICE_ID"] in headers

    def test_handles_none_tx_hash(self):
        """Test handling of None tx_hash (edge case)."""
        proof = PaymentProof(kind="cardano-txhash", tx_hash=None)
        headers = apply_payment_headers({}, "inv_123", proof)

        assert headers[FLUX_HEADERS["PAYMENT"]] == ""

    def test_handles_none_cbor_hex(self):
        """Test handling of None cbor_hex (edge case)."""
        proof = PaymentProof(kind="cardano-signed-cbor", cbor_hex=None)
        headers = apply_payment_headers({}, "inv_123", proof)

        assert headers[FLUX_HEADERS["PAYMENT"]] == ""


class TestChainMapping:
    """Tests for CHAIN_MAPPING constant."""

    def test_cardano_mainnet(self):
        """Test cardano-mainnet mapping."""
        assert CHAIN_MAPPING["cardano-mainnet"] == "cardano:mainnet"

    def test_cardano_preprod(self):
        """Test cardano-preprod mapping."""
        assert CHAIN_MAPPING["cardano-preprod"] == "cardano:preprod"

    def test_base_mainnet(self):
        """Test base-mainnet mapping."""
        assert CHAIN_MAPPING["base-mainnet"] == "eip155:8453"

    def test_base_sepolia(self):
        """Test base-sepolia mapping."""
        assert CHAIN_MAPPING["base-sepolia"] == "eip155:84532"

    def test_all_expected_chains_present(self):
        """Test that all expected chains are in the mapping."""
        expected_chains = [
            "cardano-mainnet",
            "cardano-preprod",
            "base-mainnet",
            "base-sepolia",
        ]
        for chain in expected_chains:
            assert chain in CHAIN_MAPPING


class TestFluxHeaders:
    """Tests for FLUX_HEADERS constant."""

    def test_invoice_id_header(self):
        """Test invoice ID header name."""
        assert FLUX_HEADERS["INVOICE_ID"] == "X-Invoice-Id"

    def test_payment_header(self):
        """Test payment header name."""
        assert FLUX_HEADERS["PAYMENT"] == "X-Payment"

    def test_partner_header(self):
        """Test partner header name."""
        assert FLUX_HEADERS["PARTNER"] == "X-Partner"

    def test_wallet_address_header(self):
        """Test wallet address header name."""
        assert FLUX_HEADERS["WALLET_ADDRESS"] == "X-Wallet-Address"

    def test_chain_header(self):
        """Test chain header name."""
        assert FLUX_HEADERS["CHAIN"] == "X-Chain"

    def test_idempotency_key_header(self):
        """Test idempotency key header name."""
        assert FLUX_HEADERS["IDEMPOTENCY_KEY"] == "X-Idempotency-Key"

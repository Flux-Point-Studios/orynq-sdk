"""
Tests for poi_sdk.types module.

Tests Pydantic models for PaymentRequest, PaymentProof, PaymentStatus,
BudgetConfig, and split-related models. Verifies serialization, alias
handling, and type coercion.
"""

import pytest
from pydantic import ValidationError

from poi_sdk.types import (
    PaymentRequest,
    PaymentProof,
    PaymentStatus,
    BudgetConfig,
    SplitConfig,
    SplitOutput,
)


class TestSplitOutput:
    """Tests for SplitOutput model."""

    def test_basic_creation(self):
        """Test creating a basic split output."""
        output = SplitOutput(
            to="addr_partner...",
            amount_units="500000",
        )
        assert output.to == "addr_partner..."
        assert output.amount_units == "500000"
        assert output.role is None
        assert output.asset is None

    def test_with_optional_fields(self):
        """Test split output with all optional fields."""
        output = SplitOutput(
            to="addr_partner...",
            amount_units="500000",
            role="platform_fee",
            asset="USDC",
        )
        assert output.role == "platform_fee"
        assert output.asset == "USDC"

    def test_camel_case_alias(self):
        """Test that camelCase JSON works via alias."""
        data = {
            "to": "addr_partner...",
            "amountUnits": "500000",
        }
        output = SplitOutput.model_validate(data)
        assert output.amount_units == "500000"

    def test_serialization_uses_alias(self):
        """Test that serialization uses camelCase by alias."""
        output = SplitOutput(
            to="addr_partner...",
            amount_units="500000",
        )
        json_data = output.model_dump(by_alias=True)
        assert "amountUnits" in json_data
        assert json_data["amountUnits"] == "500000"


class TestSplitConfig:
    """Tests for SplitConfig model."""

    def test_inclusive_mode(self):
        """Test split config with inclusive mode."""
        config = SplitConfig(
            mode="inclusive",
            outputs=[
                SplitOutput(to="addr1", amount_units="100000"),
                SplitOutput(to="addr2", amount_units="200000"),
            ],
        )
        assert config.mode == "inclusive"
        assert len(config.outputs) == 2

    def test_additional_mode(self):
        """Test split config with additional mode."""
        config = SplitConfig(
            mode="additional",
            outputs=[SplitOutput(to="addr1", amount_units="100000")],
        )
        assert config.mode == "additional"

    def test_invalid_mode_rejected(self):
        """Test that invalid modes are rejected."""
        with pytest.raises(ValidationError):
            SplitConfig(
                mode="invalid",  # type: ignore
                outputs=[],
            )


class TestPaymentRequest:
    """Tests for PaymentRequest model."""

    def test_basic_request(self):
        """Test creating a basic payment request."""
        request = PaymentRequest(
            protocol="flux",
            chain="cardano:mainnet",
            asset="ADA",
            amount_units="2000000",
            pay_to="addr_test1...",
        )
        assert request.protocol == "flux"
        assert request.chain == "cardano:mainnet"
        assert request.asset == "ADA"
        assert request.amount_units == "2000000"
        assert request.pay_to == "addr_test1..."

    def test_default_protocol(self):
        """Test that protocol defaults to flux."""
        request = PaymentRequest(
            chain="cardano:mainnet",
            asset="ADA",
            amount_units="1000000",
            pay_to="addr...",
        )
        assert request.protocol == "flux"

    def test_request_with_alias(self):
        """Test that camelCase JSON works via aliases."""
        data = {
            "protocol": "flux",
            "invoiceId": "inv_123",
            "chain": "cardano:mainnet",
            "asset": "ADA",
            "amountUnits": "1000000",
            "payTo": "addr...",
            "timeoutSeconds": 300,
        }
        request = PaymentRequest.model_validate(data)
        assert request.invoice_id == "inv_123"
        assert request.amount_units == "1000000"
        assert request.pay_to == "addr..."
        assert request.timeout_seconds == 300

    def test_request_with_splits(self):
        """Test payment request with split configuration."""
        request = PaymentRequest(
            protocol="flux",
            chain="cardano:mainnet",
            asset="ADA",
            amount_units="3000000",
            pay_to="addr_primary...",
            splits=SplitConfig(
                mode="inclusive",
                outputs=[
                    SplitOutput(to="addr_partner...", amount_units="500000"),
                    SplitOutput(to="addr_treasury...", amount_units="500000"),
                ],
            ),
        )
        assert request.splits is not None
        assert request.splits.mode == "inclusive"
        assert len(request.splits.outputs) == 2

    def test_amount_must_be_string(self):
        """Verify amounts are always strings, not numbers."""
        request = PaymentRequest(
            protocol="flux",
            chain="cardano:mainnet",
            asset="ADA",
            amount_units="999999999999999",
            pay_to="addr...",
        )
        assert request.amount_units == "999999999999999"
        assert isinstance(request.amount_units, str)

    def test_large_amount_precision(self):
        """Test that large amounts preserve precision as strings."""
        large_amount = "12345678901234567890"
        request = PaymentRequest(
            chain="cardano:mainnet",
            asset="ADA",
            amount_units=large_amount,
            pay_to="addr...",
        )
        assert request.amount_units == large_amount
        # Ensure no precision loss
        assert len(request.amount_units) == 20

    def test_optional_fields_default_to_none(self):
        """Test that optional fields default to None."""
        request = PaymentRequest(
            chain="cardano:mainnet",
            asset="ADA",
            amount_units="1000000",
            pay_to="addr...",
        )
        assert request.invoice_id is None
        assert request.decimals is None
        assert request.timeout_seconds is None
        assert request.splits is None
        assert request.partner is None
        assert request.raw is None

    def test_raw_data_preservation(self):
        """Test that raw data can be stored for debugging."""
        raw = {"invoiceId": "inv_123", "extra_field": "value"}
        request = PaymentRequest(
            chain="cardano:mainnet",
            asset="ADA",
            amount_units="1000000",
            pay_to="addr...",
            raw=raw,
        )
        assert request.raw == raw
        assert request.raw["extra_field"] == "value"

    def test_evm_chain_format(self):
        """Test EVM chain identifier format."""
        request = PaymentRequest(
            chain="eip155:8453",
            asset="USDC",
            amount_units="1000000",
            pay_to="0x1234567890123456789012345678901234567890",
            decimals=6,
        )
        assert request.chain == "eip155:8453"
        assert request.decimals == 6

    def test_x402_protocol(self):
        """Test x402 protocol type."""
        request = PaymentRequest(
            protocol="x402",
            chain="cardano:mainnet",
            asset="ADA",
            amount_units="1000000",
            pay_to="addr...",
        )
        assert request.protocol == "x402"


class TestPaymentProof:
    """Tests for PaymentProof model."""

    def test_cardano_txhash(self):
        """Test Cardano transaction hash proof."""
        proof = PaymentProof(kind="cardano-txhash", tx_hash="abc123...")
        assert proof.kind == "cardano-txhash"
        assert proof.tx_hash == "abc123..."
        assert proof.cbor_hex is None

    def test_cardano_txhash_with_alias(self):
        """Test Cardano txhash with camelCase alias."""
        data = {"kind": "cardano-txhash", "txHash": "abc123..."}
        proof = PaymentProof.model_validate(data)
        assert proof.tx_hash == "abc123..."

    def test_cardano_signed_cbor(self):
        """Test Cardano signed CBOR proof."""
        proof = PaymentProof(kind="cardano-signed-cbor", cbor_hex="84a4...")
        assert proof.kind == "cardano-signed-cbor"
        assert proof.cbor_hex == "84a4..."
        assert proof.tx_hash is None

    def test_cardano_signed_cbor_with_alias(self):
        """Test signed CBOR with camelCase alias."""
        data = {"kind": "cardano-signed-cbor", "cborHex": "84a4..."}
        proof = PaymentProof.model_validate(data)
        assert proof.cbor_hex == "84a4..."

    def test_evm_txhash(self):
        """Test EVM transaction hash proof."""
        proof = PaymentProof(kind="evm-txhash", tx_hash="0x123...")
        assert proof.kind == "evm-txhash"
        assert proof.tx_hash == "0x123..."

    def test_invalid_kind_rejected(self):
        """Test that invalid proof kinds are rejected."""
        with pytest.raises(ValidationError):
            PaymentProof(kind="invalid-kind", tx_hash="abc")  # type: ignore


class TestPaymentStatus:
    """Tests for PaymentStatus model."""

    def test_pending_status(self):
        """Test pending payment status."""
        status = PaymentStatus(
            invoice_id="inv_123",
            status="pending",
        )
        assert status.invoice_id == "inv_123"
        assert status.status == "pending"
        assert status.tx_hash is None
        assert status.error is None

    def test_confirmed_status(self):
        """Test confirmed payment status with tx hash."""
        status = PaymentStatus(
            invoice_id="inv_123",
            status="confirmed",
            tx_hash="abc123...",
            settled_at="2024-01-15T10:30:00Z",
        )
        assert status.status == "confirmed"
        assert status.tx_hash == "abc123..."
        assert status.settled_at == "2024-01-15T10:30:00Z"

    def test_failed_status(self):
        """Test failed payment status with error."""
        status = PaymentStatus(
            invoice_id="inv_123",
            status="failed",
            error="Insufficient funds",
        )
        assert status.status == "failed"
        assert status.error == "Insufficient funds"

    def test_all_valid_statuses(self):
        """Test all valid status values."""
        valid_statuses = ["pending", "submitted", "confirmed", "consumed", "expired", "failed"]
        for status_value in valid_statuses:
            status = PaymentStatus(
                invoice_id="inv_123",
                status=status_value,  # type: ignore
            )
            assert status.status == status_value

    def test_invalid_status_rejected(self):
        """Test that invalid statuses are rejected."""
        with pytest.raises(ValidationError):
            PaymentStatus(
                invoice_id="inv_123",
                status="invalid_status",  # type: ignore
            )

    def test_camel_case_aliases(self):
        """Test all camelCase aliases work."""
        data = {
            "invoiceId": "inv_123",
            "status": "confirmed",
            "txHash": "abc123...",
            "settledAt": "2024-01-15T10:30:00Z",
        }
        status = PaymentStatus.model_validate(data)
        assert status.invoice_id == "inv_123"
        assert status.tx_hash == "abc123..."
        assert status.settled_at == "2024-01-15T10:30:00Z"


class TestBudgetConfig:
    """Tests for BudgetConfig model."""

    def test_budget_with_limits(self):
        """Test budget config with all limits."""
        config = BudgetConfig(
            max_per_request="2000000",
            max_per_day="100000000",
            daily_reset_hour=0,
        )
        assert config.max_per_request == "2000000"
        assert config.max_per_day == "100000000"
        assert config.daily_reset_hour == 0

    def test_budget_with_aliases(self):
        """Test budget config with camelCase aliases."""
        data = {
            "maxPerRequest": "2000000",
            "maxPerDay": "100000000",
            "dailyResetHour": 12,
        }
        config = BudgetConfig.model_validate(data)
        assert config.max_per_request == "2000000"
        assert config.max_per_day == "100000000"
        assert config.daily_reset_hour == 12

    def test_default_reset_hour(self):
        """Test that daily reset hour defaults to 0."""
        config = BudgetConfig(
            max_per_request="1000000",
        )
        assert config.daily_reset_hour == 0

    def test_optional_limits(self):
        """Test that limits are optional."""
        config = BudgetConfig()
        assert config.max_per_request is None
        assert config.max_per_day is None

    def test_per_request_limit_only(self):
        """Test with only per-request limit."""
        config = BudgetConfig(max_per_request="5000000")
        assert config.max_per_request == "5000000"
        assert config.max_per_day is None

    def test_per_day_limit_only(self):
        """Test with only per-day limit."""
        config = BudgetConfig(max_per_day="50000000")
        assert config.max_per_request is None
        assert config.max_per_day == "50000000"

    def test_large_budget_amounts(self):
        """Test that large budget amounts preserve precision."""
        large_amount = "999999999999999999"
        config = BudgetConfig(
            max_per_request=large_amount,
            max_per_day=large_amount,
        )
        assert config.max_per_request == large_amount
        assert config.max_per_day == large_amount

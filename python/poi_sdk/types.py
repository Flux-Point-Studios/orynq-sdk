"""
Location: python/poi_sdk/types.py

Summary:
    Pydantic models for the poi-sdk. Defines all the data structures used
    throughout the SDK including PaymentRequest, PaymentProof, PaymentStatus,
    BudgetConfig, and split-related models.

Usage:
    These models are imported and used by client.py, transport_flux.py,
    budget.py, and invoice_cache.py for type-safe data handling.
    All monetary amounts are represented as strings to prevent precision
    loss with large values.

Example:
    from poi_sdk.types import PaymentRequest, PaymentProof

    request = PaymentRequest(
        chain="cardano:mainnet",
        asset="ADA",
        amount_units="1000000",
        pay_to="addr1..."
    )
"""

from typing import Literal, Optional
from pydantic import BaseModel, Field


class SplitOutput(BaseModel):
    """
    Represents a single output in a split payment configuration.

    Attributes:
        to: The recipient address for this split
        amount_units: The amount in smallest units (as string for precision)
        role: Optional role identifier (e.g., "platform_fee", "royalty")
        asset: Optional asset identifier, defaults to parent payment asset
    """
    to: str
    amount_units: str = Field(alias="amountUnits")
    role: Optional[str] = None
    asset: Optional[str] = None

    model_config = {"populate_by_name": True}


class SplitConfig(BaseModel):
    """
    Configuration for split payments.

    Attributes:
        mode: "inclusive" means splits are taken from the main amount,
              "additional" means splits are added on top
        outputs: List of split outputs
    """
    mode: Literal["inclusive", "additional"]
    outputs: list[SplitOutput]


class PaymentRequest(BaseModel):
    """
    Represents a payment request parsed from a 402 response.

    All amounts are stored as strings to prevent precision loss
    with large values common in blockchain transactions.

    Attributes:
        protocol: Payment protocol ("flux" or "x402"), defaults to "flux"
        invoice_id: Unique identifier for this invoice
        chain: CAIP-2 chain identifier (e.g., "cardano:mainnet", "eip155:8453")
        asset: Asset identifier (e.g., "ADA", "USDC")
        amount_units: Amount in smallest units as string
        decimals: Number of decimal places for the asset
        pay_to: Recipient address
        timeout_seconds: Seconds until invoice expires
        splits: Optional split payment configuration
        partner: Optional partner identifier for attribution
        raw: Original raw invoice data for debugging
    """
    protocol: Literal["flux", "x402"] = "flux"
    invoice_id: Optional[str] = Field(None, alias="invoiceId")
    chain: str
    asset: str
    amount_units: str = Field(alias="amountUnits")
    decimals: Optional[int] = None
    pay_to: str = Field(alias="payTo")
    timeout_seconds: Optional[int] = Field(None, alias="timeoutSeconds")
    splits: Optional[SplitConfig] = None
    partner: Optional[str] = None
    raw: Optional[dict] = None

    model_config = {"populate_by_name": True}


class PaymentProof(BaseModel):
    """
    Proof of payment to be sent back to the server.

    Attributes:
        kind: Type of proof - "cardano-txhash" for submitted tx,
              "cardano-signed-cbor" for pre-signed tx, "evm-txhash" for EVM
        tx_hash: Transaction hash (for txhash kinds)
        cbor_hex: Signed CBOR hex (for cardano-signed-cbor kind)
    """
    kind: Literal["cardano-txhash", "cardano-signed-cbor", "evm-txhash"]
    tx_hash: Optional[str] = Field(None, alias="txHash")
    cbor_hex: Optional[str] = Field(None, alias="cborHex")

    model_config = {"populate_by_name": True}


class PaymentStatus(BaseModel):
    """
    Status of a payment after submission.

    Attributes:
        invoice_id: The invoice identifier
        status: Current status of the payment
        tx_hash: Transaction hash if submitted
        error: Error message if failed
        settled_at: ISO timestamp when payment was settled
    """
    invoice_id: str = Field(alias="invoiceId")
    status: Literal["pending", "submitted", "confirmed", "consumed", "expired", "failed"]
    tx_hash: Optional[str] = Field(None, alias="txHash")
    error: Optional[str] = None
    settled_at: Optional[str] = Field(None, alias="settledAt")

    model_config = {"populate_by_name": True}


class BudgetConfig(BaseModel):
    """
    Configuration for budget limits.

    Attributes:
        max_per_request: Maximum amount per single request (string for precision)
        max_per_day: Maximum total amount per day (string for precision)
        daily_reset_hour: Hour (0-23 UTC) when daily budget resets
    """
    max_per_request: Optional[str] = Field(None, alias="maxPerRequest")
    max_per_day: Optional[str] = Field(None, alias="maxPerDay")
    daily_reset_hour: int = Field(0, alias="dailyResetHour")

    model_config = {"populate_by_name": True}

"""
Location: python/poi_sdk/transport_flux.py

Summary:
    Flux wire format transport layer. Handles parsing Flux 402 responses
    and applying payment headers for retry requests.

Usage:
    Used by client.py to detect Flux 402 responses, parse invoice data
    into PaymentRequest objects, and add payment proof headers.

Example:
    from poi_sdk.transport_flux import is_flux_402, parse_flux_invoice

    if is_flux_402(response):
        request = parse_flux_invoice(response.json())
"""

from typing import Optional, TYPE_CHECKING
import httpx

if TYPE_CHECKING:
    from .types import PaymentProof

from .types import PaymentRequest, SplitConfig, SplitOutput


# Flux protocol header names
FLUX_HEADERS = {
    "INVOICE_ID": "X-Invoice-Id",
    "PAYMENT": "X-Payment",
    "PARTNER": "X-Partner",
    "WALLET_ADDRESS": "X-Wallet-Address",
    "CHAIN": "X-Chain",
    "IDEMPOTENCY_KEY": "X-Idempotency-Key",
}

# Mapping from simple chain names to CAIP-2 format
CHAIN_MAPPING = {
    "cardano-mainnet": "cardano:mainnet",
    "cardano-preprod": "cardano:preprod",
    "base-mainnet": "eip155:8453",
    "base-sepolia": "eip155:84532",
}


def is_flux_402(response: httpx.Response) -> bool:
    """
    Check if response is a Flux protocol 402 Payment Required.

    Flux 402 responses have:
    - Status code 402
    - Content-Type: application/json
    - No PAYMENT-REQUIRED header (that's x402)

    Args:
        response: The httpx response to check

    Returns:
        True if this is a Flux 402 response
    """
    if response.status_code != 402:
        return False

    content_type = response.headers.get("content-type", "")
    if "application/json" not in content_type:
        return False

    # x402 uses PAYMENT-REQUIRED header to distinguish
    if "payment-required" in response.headers:
        return False

    return True


def parse_flux_invoice(data: dict) -> PaymentRequest:
    """
    Parse Flux invoice JSON to PaymentRequest model.

    Converts chain names to CAIP-2 format and normalizes
    the split configuration structure.

    Args:
        data: Raw invoice JSON data from Flux 402 response

    Returns:
        PaymentRequest model with normalized data
    """
    chain = data.get("chain", "")
    caip_chain = CHAIN_MAPPING.get(chain, chain)

    splits = None
    if "splits" in data and data["splits"]:
        splits = SplitConfig(
            mode=data.get("splitMode", "additional"),
            outputs=[
                SplitOutput(
                    to=s["to"],
                    amount_units=str(s["amount"]),
                    role=s.get("role"),
                    asset=s.get("currency"),
                )
                for s in data["splits"]
            ]
        )

    return PaymentRequest(
        protocol="flux",
        invoice_id=data.get("invoiceId"),
        chain=caip_chain,
        asset=data.get("currency", "ADA"),
        amount_units=str(data.get("amount", "0")),
        decimals=data.get("decimals"),
        pay_to=data.get("payTo", ""),
        timeout_seconds=_calculate_timeout(data.get("expiresAt")),
        partner=data.get("partner"),
        splits=splits,
        raw=data,
    )


def _calculate_timeout(expires_at: Optional[str]) -> Optional[int]:
    """
    Calculate remaining timeout in seconds from expiration timestamp.

    Args:
        expires_at: ISO 8601 timestamp string

    Returns:
        Seconds until expiration, or None if not specified
    """
    if not expires_at:
        return None

    from datetime import datetime

    try:
        expires = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        now = datetime.now(expires.tzinfo)
        return max(0, int((expires - now).total_seconds()))
    except (ValueError, TypeError):
        return None


def apply_payment_headers(
    headers: dict,
    invoice_id: str,
    proof: "PaymentProof",
    partner: Optional[str] = None,
    wallet_address: Optional[str] = None,
    chain: Optional[str] = None,
    idempotency_key: Optional[str] = None,
) -> dict:
    """
    Add Flux payment headers to a request.

    Args:
        headers: Existing headers dict to extend
        invoice_id: The invoice being paid
        proof: Payment proof with tx hash or signed CBOR
        partner: Optional partner identifier
        wallet_address: Optional wallet address for attribution
        chain: Optional chain identifier
        idempotency_key: Optional idempotency key

    Returns:
        New headers dict with payment headers added
    """
    headers = dict(headers)
    headers[FLUX_HEADERS["INVOICE_ID"]] = invoice_id

    # Set payment proof based on kind
    if proof.kind == "cardano-txhash":
        headers[FLUX_HEADERS["PAYMENT"]] = proof.tx_hash or ""
    elif proof.kind == "cardano-signed-cbor":
        headers[FLUX_HEADERS["PAYMENT"]] = proof.cbor_hex or ""
    elif proof.kind == "evm-txhash":
        headers[FLUX_HEADERS["PAYMENT"]] = proof.tx_hash or ""

    if partner:
        headers[FLUX_HEADERS["PARTNER"]] = partner
    if wallet_address:
        headers[FLUX_HEADERS["WALLET_ADDRESS"]] = wallet_address
    if chain:
        headers[FLUX_HEADERS["CHAIN"]] = chain
    if idempotency_key:
        headers[FLUX_HEADERS["IDEMPOTENCY_KEY"]] = idempotency_key

    return headers

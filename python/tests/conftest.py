"""
Shared pytest fixtures for poi-sdk tests.

This module provides common fixtures used across all test files,
including sample invoice data and cross-language hash vectors.
"""

import json
from pathlib import Path

import pytest


@pytest.fixture
def sample_invoice():
    """Sample Flux invoice response."""
    return {
        "invoiceId": "inv_test123",
        "amount": "2000000",
        "currency": "ADA",
        "payTo": "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp",
        "chain": "cardano-mainnet",
        "expiresAt": "2024-12-31T23:59:59Z",
        "partner": "test_partner",
    }


@pytest.fixture
def sample_invoice_with_splits():
    """Invoice with split payments."""
    return {
        "invoiceId": "inv_split123",
        "amount": "3000000",
        "currency": "ADA",
        "payTo": "addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp",
        "chain": "cardano-mainnet",
        "splitMode": "inclusive",
        "splits": [
            {"to": "addr_partner...", "amount": "500000", "role": "partner"},
            {"to": "addr_treasury...", "amount": "500000", "role": "treasury"},
        ],
    }


@pytest.fixture
def sample_invoice_preprod():
    """Invoice for preprod network."""
    return {
        "invoiceId": "inv_preprod123",
        "amount": "1000000",
        "currency": "ADA",
        "payTo": "addr_test1qz...",
        "chain": "cardano-preprod",
    }


@pytest.fixture
def sample_invoice_base():
    """Invoice for Base mainnet."""
    return {
        "invoiceId": "inv_base123",
        "amount": "1000000",
        "currency": "USDC",
        "payTo": "0x1234567890123456789012345678901234567890",
        "chain": "base-mainnet",
        "decimals": 6,
    }


@pytest.fixture
def hash_vectors():
    """Load cross-language hash vectors from fixtures."""
    # Try multiple possible paths
    possible_paths = [
        Path(__file__).parent.parent.parent / "orynq-backend" / "contracts" / "fixtures" / "hash" / "hash_vectors.json",
        Path(__file__).parent.parent.parent / "fixtures" / "hash-vectors.json",
    ]

    for vectors_path in possible_paths:
        if vectors_path.exists():
            with open(vectors_path, encoding='utf-8') as f:
                data = json.load(f)
                return data.get("vectors", [])

    return []


@pytest.fixture
def mock_payer():
    """Create a mock payer for testing."""
    from unittest.mock import AsyncMock, MagicMock
    from poi_sdk.types import PaymentProof

    payer = MagicMock()
    payer.supported_chains = ["cardano:mainnet", "cardano:preprod"]
    payer.supports = MagicMock(return_value=True)
    payer.get_address = AsyncMock(return_value="addr_test1...")
    payer.get_balance = AsyncMock(return_value=100_000_000)
    payer.pay = AsyncMock(return_value=PaymentProof(
        kind="cardano-txhash",
        tx_hash="abc123def456789012345678901234567890123456789012345678901234"
    ))
    return payer

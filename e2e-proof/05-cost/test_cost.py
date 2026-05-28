"""Hermetic tests for the cost computer.

Asserts the math:

  T1. `expected_cardano_tx_lovelace` uses the protocol formula
      `min_fee_b + min_fee_a * tx_bytes` for live network parameters.
  T2. `compute_cost_table` zeros the MATRA fee for sponsored networks.
  T3. `compute_cost_table` leaves `usd_per_observation` as None when
      ADA/USD spot is unavailable or the network is preprod (no market).
  T4. Markdown table emits the correct one-line-per-network shape.

No network access in these tests.
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from compute import (
    ANCHOR_TX_BYTES,
    compute_cost_table,
    expected_cardano_tx_lovelace,
    to_markdown,
)


def test_t1_cardano_fee_formula():
    params = {"min_fee_a": 44, "min_fee_b": 155381}
    # 155381 + 44 * 700 = 155381 + 30800 = 186181 lovelace
    assert expected_cardano_tx_lovelace(params, tx_bytes=700) == 186181
    # Also test a smaller tx
    assert expected_cardano_tx_lovelace(params, tx_bytes=200) == 155381 + 44 * 200


def test_t2_sponsored_zeroes_matra_fee():
    materios = {
        "rpc_url": "ws://example",
        "receipt_submission_fee_base": 1_000_000,
        "receipt_submission_fee_display": 1.0,
        "token_decimals": 6,
        "token_symbol": "MATRA",
    }
    cardano = {"min_fee_a": 44, "min_fee_b": 155381}
    table = compute_cost_table(
        network="preprod",
        materios_fee=materios,
        cardano_params=cardano,
        ada_usd=None,
        sponsored=True,
    )
    assert table["materios"]["matra_paid_by_observer"] == 0.0
    assert table["materios"]["sponsored"] is True


def test_t3_preprod_or_no_price_yields_none_usd():
    materios = {
        "rpc_url": "ws://example",
        "receipt_submission_fee_base": 1_000_000,
        "receipt_submission_fee_display": 1.0,
        "token_decimals": 6,
        "token_symbol": "MATRA",
    }
    cardano = {"min_fee_a": 44, "min_fee_b": 155381}
    # Preprod with no ADA price.
    pre = compute_cost_table(
        network="preprod",
        materios_fee=materios,
        cardano_params=cardano,
        ada_usd=None,
        sponsored=True,
    )
    assert pre["totals"]["usd_per_observation"] is None
    # Mainnet but with no ADA price feed yields None too.
    mn = compute_cost_table(
        network="mainnet",
        materios_fee=materios,
        cardano_params=cardano,
        ada_usd=None,
        sponsored=False,
    )
    assert mn["totals"]["usd_per_observation"] is None
    # Mainnet with price set yields a positive number.
    mn2 = compute_cost_table(
        network="mainnet",
        materios_fee=materios,
        cardano_params=cardano,
        ada_usd=0.50,
        sponsored=False,
    )
    assert mn2["totals"]["usd_per_observation"] is not None
    assert mn2["totals"]["usd_per_observation"] > 0


def test_t4_markdown_shape():
    materios = {
        "rpc_url": "ws://example",
        "receipt_submission_fee_base": 1_000_000,
        "receipt_submission_fee_display": 1.0,
        "token_decimals": 6,
        "token_symbol": "MATRA",
    }
    cardano = {"min_fee_a": 44, "min_fee_b": 155381}
    rows = {
        "preprod": compute_cost_table(
            network="preprod",
            materios_fee=materios,
            cardano_params=cardano,
            ada_usd=None,
            sponsored=True,
        ),
        "mainnet": compute_cost_table(
            network="mainnet",
            materios_fee=materios,
            cardano_params=cardano,
            ada_usd=0.50,
            sponsored=False,
        ),
    }
    md = to_markdown(rows)
    assert "| Network | Sponsored |" in md
    assert "| preprod | yes |" in md
    assert "| mainnet | no |" in md
    assert "n/a (sponsored)" in md


def test_t5_tx_bytes_estimate_is_documented():
    """The default tx_bytes constant must be a positive integer."""
    assert isinstance(ANCHOR_TX_BYTES, int)
    assert ANCHOR_TX_BYTES > 0
    assert ANCHOR_TX_BYTES < 16_384  # well below Cardano's 16 KB tx cap

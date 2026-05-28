"""Hermetic tests for demo 4 — independent verification.

Validates the pure-Python verification logic using a pinned fixture:

  T1. `compute_checkpoint_leaf` is byte-identical to the formula used by
      cert-daemon. Replays the fixture's chain/receipt/cert into the
      pinned leaf and asserts equality.
  T2. `step6_match_anchor` accepts a candidate whose `blocks` range
      covers the receipt block AND whose `chain` matches.
  T3. `step6_match_anchor` REJECTS a candidate whose `chain` does not
      match (no cross-chain confusion).
  T4. `step6_match_anchor` REJECTS a candidate whose `blocks` range
      excludes the receipt block.
  T5. `step6_match_anchor` REJECTS a candidate with `p != "materios"`
      or `v != 2` (label 8746 is shared space with other v/protocol).

No network access in these tests.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))

from verify import compute_checkpoint_leaf, step6_match_anchor

FIXTURE = json.loads(
    (HERE / "fixtures" / "lineage-sample.json").read_text(encoding="utf-8")
)


def test_t1_checkpoint_leaf_matches_pinned():
    leaf = compute_checkpoint_leaf(
        FIXTURE["chain_id_hex"],
        FIXTURE["receipt_id_hex"],
        FIXTURE["cert_hash_hex"],
    )
    assert leaf == FIXTURE["expected_leaf_hex"], (
        f"checkpoint-leaf formula drifted: got {leaf}, expected "
        f"{FIXTURE['expected_leaf_hex']}"
    )


def test_t2_match_anchor_accepts_in_range_same_chain():
    candidates = [{"json_metadata": FIXTURE["sample_anchor_metadata"], "tx_hash": "txhash_a"}]
    match = step6_match_anchor(
        candidates,
        expected_chain=FIXTURE["chain_id_hex"],
        receipt_block_num=FIXTURE["sample_receipt_block_number_in_range"],
    )
    assert match is not None
    assert match["tx_hash"] == "txhash_a"
    assert match["metadata"]["root"] == FIXTURE["sample_anchor_metadata"]["root"]


def test_t3_match_anchor_rejects_wrong_chain():
    bad = dict(FIXTURE["sample_anchor_metadata"])
    bad["chain"] = "f" * 64
    candidates = [{"json_metadata": bad, "tx_hash": "wrong_chain"}]
    match = step6_match_anchor(
        candidates,
        expected_chain=FIXTURE["chain_id_hex"],
        receipt_block_num=FIXTURE["sample_receipt_block_number_in_range"],
    )
    assert match is None


def test_t4_match_anchor_rejects_out_of_range_block():
    candidates = [{"json_metadata": FIXTURE["sample_anchor_metadata"], "tx_hash": "out_of_range"}]
    match = step6_match_anchor(
        candidates,
        expected_chain=FIXTURE["chain_id_hex"],
        receipt_block_num=FIXTURE["sample_receipt_block_number_out_of_range"],
    )
    assert match is None


def test_t5_match_anchor_rejects_wrong_protocol_or_version():
    wrong_proto = dict(FIXTURE["sample_anchor_metadata"])
    wrong_proto["p"] = "some-other-chain"
    wrong_ver = dict(FIXTURE["sample_anchor_metadata"])
    wrong_ver["v"] = 99
    candidates = [
        {"json_metadata": wrong_proto, "tx_hash": "wrong_proto"},
        {"json_metadata": wrong_ver, "tx_hash": "wrong_ver"},
    ]
    match = step6_match_anchor(
        candidates,
        expected_chain=FIXTURE["chain_id_hex"],
        receipt_block_num=FIXTURE["sample_receipt_block_number_in_range"],
    )
    assert match is None


def test_t6_match_anchor_picks_first_matching():
    """When multiple anchors qualify (e.g. overlapping batches), return
    the first one — Blockfrost orders newest-first."""
    a = dict(FIXTURE["sample_anchor_metadata"])
    b = dict(FIXTURE["sample_anchor_metadata"])
    b["root"] = "b" * 64
    candidates = [
        {"json_metadata": a, "tx_hash": "first"},
        {"json_metadata": b, "tx_hash": "second"},
    ]
    match = step6_match_anchor(
        candidates,
        expected_chain=FIXTURE["chain_id_hex"],
        receipt_block_num=FIXTURE["sample_receipt_block_number_in_range"],
    )
    assert match is not None
    assert match["tx_hash"] == "first"

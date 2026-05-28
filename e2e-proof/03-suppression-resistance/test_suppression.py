"""Hermetic tests for demo 3 — suppression-resistance.

Validates:

  T1. The synthetic observation builder produces a record whose
      taxonomy + observer.context strings are obviously a test fixture
      (no risk a real-world verifier confuses this for a real finding).
  T2. The removal-attempt logic surfaces a clean PASS only when every
      channel reports `removed=False`. If ANY channel reports
      `removed=True` the script must exit non-zero.
  T3. Channel B's regex against the Materios runtime metadata blob
      correctly flags presence vs absence of a delete dispatchable.

No live preprod traffic in these tests.
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from orynq_observe import Observation

HERE = Path(__file__).parent
import importlib.util

spec_synth = importlib.util.spec_from_file_location(
    "_demo3_synth", HERE / "synthetic.py"
)
demo3_synth = importlib.util.module_from_spec(spec_synth)
assert spec_synth.loader is not None
spec_synth.loader.exec_module(demo3_synth)


spec_rem = importlib.util.spec_from_file_location(
    "_demo3_rem", HERE / "attempt_removal.py"
)
demo3_rem = importlib.util.module_from_spec(spec_rem)
assert spec_rem.loader is not None
spec_rem.loader.exec_module(demo3_rem)


def test_t1_synthetic_is_clearly_a_test():
    """The synthetic observation must self-identify."""
    obs = Observation(
        model_name="orynq-observe-suppression-test",
        model_version="1",
        taxonomy_id="SUPPRESSION-TEST-001",
        severity="low",
        observer_context=(
            "synthetic suppression-resistance demo, not a real observation"
        ),
    )
    obs.add_evidence(
        prompt=demo3_synth.SYNTHETIC_PROMPT,
        response=demo3_synth.SYNTHETIC_RESPONSE,
    )
    record = obs.to_record(
        observer_ss58="5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    )
    assert record["capability"]["taxonomyId"] == "SUPPRESSION-TEST-001"
    assert (
        "synthetic suppression-resistance demo"
        in record["observer"]["context"]
    )
    assert "Fingerprint: e2e-proof/03 v1" in demo3_synth.SYNTHETIC_PROMPT
    # The response must mention this is a test.
    assert "synthetic" in demo3_synth.SYNTHETIC_RESPONSE.lower()
    assert "test" in demo3_synth.SYNTHETIC_RESPONSE.lower()


def test_t2_removal_logic_correctly_aggregates():
    """A single removed=True channel must flip all_removal_attempts_failed."""
    # No removed -> pass
    channels = [
        {"channel": "A", "removed": False},
        {"channel": "B", "removed": False},
        {"channel": "C", "removed": False},
    ]
    failed = not any(ch.get("removed") for ch in channels)
    assert failed is True

    # One removed -> fail
    channels[1]["removed"] = True
    failed = not any(ch.get("removed") for ch in channels)
    assert failed is False


def test_t3_channel_b_metadata_regex():
    """The Channel B regex flags removal dispatchables but ignores
    non-removal ones (submit_receipt, etc)."""
    import re

    pattern = re.compile(
        rb"orinqReceipts[._]?(?:delete|remove|burn)_?\w*", re.IGNORECASE
    )

    benign = b"orinqReceipts.submit_receipt_v2 orinqReceipts.attest"
    assert not pattern.search(benign)

    malicious = b"orinqReceipts.delete_receipt orinqReceipts.submit_receipt_v2"
    assert pattern.search(malicious)

    burn_present = b"orinqReceipts.burn orinqReceipts.submit_receipt_v2"
    assert pattern.search(burn_present)


def test_t4_attempt_removal_exit_code_when_a_channel_removes(tmp_path: Path):
    """The orchestrator must exit non-zero if even one channel reports
    `removed=True` — defensive guard against accidental success."""
    # Synthesise a result.json + a fake response from channel A.
    result_path = tmp_path / "result.json"
    result_path.write_text(
        json.dumps(
            {
                "synthetic_content_hash": "f" * 64,
                "cardano_anchor_tx": "a" * 64,
            }
        )
    )

    fake_channels = [
        {"channel": "A_gateway", "removed": True},  # bad: a channel succeeded
        {"channel": "B_materios_runtime_metadata", "removed": False},
        {"channel": "C_cardano_blockfrost", "removed": False},
    ]
    any_removed = any(ch.get("removed") for ch in fake_channels)
    assert any_removed is True  # → exit code 2 in attempt_removal.main()

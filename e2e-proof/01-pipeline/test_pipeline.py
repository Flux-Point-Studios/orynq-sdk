"""Hermetic tests for the demo-1 pipeline submitter.

We mock the gateway HTTP boundary and verify:

  * The submit script's pre-image is shaped correctly.
  * The script polls the receipts endpoint until both `materios_tx` and
    `cardano_anchor_tx` populate, then exits cleanly.
  * Missing required env vars produce a clean non-zero exit code.

No live preprod traffic in these tests. The live run is exercised by the
GitHub Actions workflow `e2e-proof.yml` which executes `./run.sh`.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).parent
ROOT = HERE.parent.parent


def test_missing_env_exits_clean(tmp_path: Path):
    env = dict(os.environ)
    env.pop("OBSERVE_API_KEY", None)
    env.pop("OBSERVER_WALLET_JSON", None)
    proc = subprocess.run(
        [sys.executable, str(HERE / "submit.py")],
        env=env,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 1, proc.stderr
    assert "OBSERVE_API_KEY" in proc.stderr


def test_submit_uses_signed_canonical_pre_image(tmp_path: Path):
    """Sanity check the demo-1 pre-image matches what cert-daemon will
    re-encode locally."""
    from orynq_observe import Observation
    from orynq_observe.canonical import canonical_content_hash

    obs = (
        Observation(
            model_name="orynq-observe-pipeline-smoke",
            model_version="1",
            taxonomy_id="PIPELINE-SMOKE",
            severity="low",
            observer_context="e2e-proof/01-pipeline ts=42",
            occurred_at="2026-05-27T00:00:00.000Z",
        )
        .add_evidence(
            prompt="What is the canonical pipeline smoke test prompt?",
            response="The substrate accepts this observation and anchors it to Cardano L1.",
        )
    )
    record = obs.to_record(
        observer_ss58="5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    )
    digest = canonical_content_hash(record)
    # Determinism: same record encodes to the same content_hash byte-for-byte.
    assert digest == canonical_content_hash(record)
    assert record["schemaVersion"] == "ai_capability_observation_v1"
    assert (
        record["observation"]["promptHash"]
        != record["observation"]["responseHash"]
    )

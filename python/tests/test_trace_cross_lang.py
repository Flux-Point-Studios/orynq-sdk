"""Send deterministic Python traces through the real TypeScript verifier.

Run after `pnpm install`.
Python-only environments skip this explicit Node integration, while the hash
regressions in test_trace.py always run.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from itertools import count
from pathlib import Path

import pytest

import orynq_sdk.trace as trace

REPO_ROOT = Path(__file__).resolve().parents[2]


def _verify(bundle):
    tsx = shutil.which("tsx") or REPO_ROOT / "node_modules" / ".bin" / "tsx"
    if not Path(tsx).exists():
        pytest.skip("Install workspace Node dependencies to run TS trace verification")
    proc = subprocess.run(
        [str(tsx), "--tsconfig", str(Path(__file__).with_name("tsconfig.trace-parity.json")),
         str(Path(__file__).with_name("_trace_ts_verifier.mts"))],
        input=json.dumps(bundle), capture_output=True, text=True,
        cwd=REPO_ROOT, timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


@pytest.fixture
def fixed_clock_and_ids(monkeypatch):
    ids = iter(f"00000000-0000-4000-8000-{i:012d}" for i in range(50))
    ticks = count()
    monkeypatch.setattr(trace.uuid, "uuid4", lambda: next(ids))
    monkeypatch.setattr(trace, "_now_iso", lambda: (
        datetime(2026, 10, 26, tzinfo=timezone.utc) + timedelta(milliseconds=1001 * next(ticks))
    ).isoformat(timespec="milliseconds").replace("+00:00", "Z"))


@pytest.mark.parametrize("shape", ["empty", "empty-span", "nested", "odd", "redacted"])
def test_python_bundle_verifies_in_typescript(shape, fixed_clock_and_ids):
    run = trace.create_trace(agent_id="python-parity")
    if shape != "empty":
        parent = trace.add_span(run, name="parent", visibility="public", metadata={"z": 1, "a": None})
        if shape not in ("empty-span",):
            for kind in ("command", "observation", "decision"):
                trace.add_event(run, parent.id, kind=kind, **{kind: "hello"})
        if shape == "nested":
            child = trace.add_span(run, name="child", parent_span_id=parent.id, visibility="public", metadata={})
            trace.add_event(run, child.id, kind="custom", visibility="public", data={"b": 2, "a": 1})
            trace.close_span(run, child.id)
        if shape in ("odd", "redacted"):
            for index in range(2):
                other = trace.add_span(run, name=f"other-{index}", visibility="private" if shape == "redacted" else "public")
                trace.add_event(run, other.id, kind="output", output="private output")
                trace.close_span(run, other.id)
        trace.close_span(run, parent.id)
    bundle = trace.finalize_trace(run)
    wire = bundle.to_dict()
    actual = _verify(wire)
    assert actual["report"]["valid"], actual["report"]
    assert actual["eventHashes"] == [e.hash for e in run.events]
    assert actual["spanHashes"] == [s.hash for s in run.spans]
    assert actual["rollingHash"] == run.rolling_hash
    assert actual["rootHash"] == bundle.root_hash
    assert actual["publicView"] == bundle.public_view
    assert actual["contentHash"] == bundle.manifest_hash
    for event in run.events:
        if event.kind != "custom":  # The custom event above explicitly opts into public.
            assert event.visibility == actual["defaults"][event.kind]

    if run.events:
        tampered = deepcopy(wire)
        tampered["privateRun"]["events"][0]["command"] = "tampered"
        assert not _verify(tampered)["report"]["valid"]
    if shape == "nested":
        tampered = deepcopy(wire)
        tampered["privateRun"]["spans"][0]["childSpanIds"] = []
        assert not _verify(tampered)["report"]["valid"]

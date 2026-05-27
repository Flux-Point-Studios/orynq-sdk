"""Cross-language byte-pinning tests for ai_capability_observation_v1.

Real bytes — not mocks. For each fixed test vector:

  1. Python encoder produces canonical CBOR via `canonical_cbor_pre_image`.
  2. The TS encoder is invoked via `tsx` against the same JSON input.
  3. Outputs are asserted byte-identical (hex-equal).

If these tests fail, the schema contract has drifted between languages and
downstream verifiers (cert-daemon committee, anchor-worker, SDK consumers)
will disagree on which records are valid.

Six fixed vectors cover:

  V1: Fully-populated baseline (every optional field present).
  V2: All optional sub-trees set to null (3× CBOR null primitive).
  V3: Worker / observer context with multi-byte UTF-8 chars.
  V4: Long TEE evidence (1 KiB) — exercises CBOR major-2 length head growth.
  V5: Minimal-length artifactRef + minimal-context observer.
  V6: Edge severity / tier combinations (lowest severity, "build" TEE tier).

Skips gracefully if `tsx` is not on PATH.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, List

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from orynq_sdk.schemas.ai_capability_observation_v1 import (  # noqa: E402
    SCHEMA_HASH_HEX,
    canonical_cbor_pre_image,
    canonical_content_hash,
)


HARNESS_PATH = (
    Path(__file__).resolve().parent / "_ai_capability_observation_v1_ts_encoder.mts"
)
REPO_ROOT = Path(__file__).resolve().parents[2]


def _tsx_command() -> List[str] | None:
    """Resolve a runnable `tsx <script>` command, or return None to skip.

    Two paths are accepted: tsx on PATH, or the workspace's
    `node_modules/.bin/tsx`. Python-only CI jobs that skip `pnpm install`
    lack both and the test skips cleanly.
    """
    if shutil.which("tsx") is not None:
        return ["tsx"]
    local = REPO_ROOT / "node_modules" / ".bin" / "tsx"
    if local.exists():
        return [str(local)]
    return None


def _run_ts_harness(record: Dict) -> Dict[str, str]:
    base = _tsx_command()
    if base is None:
        pytest.skip(
            "tsx not reachable — install node deps (pnpm install) to run cross-lang tests"
        )
    cmd: List[str] = [*base, str(HARNESS_PATH)]

    proc = subprocess.run(
        cmd,
        input=json.dumps(record),
        capture_output=True,
        text=True,
        cwd=str(REPO_ROOT),
        timeout=60,
    )
    if proc.returncode != 0:
        raise AssertionError(
            f"TS harness failed (exit {proc.returncode}):\n"
            f"stderr:\n{proc.stderr}\n"
            f"stdout:\n{proc.stdout}\n"
        )
    out: Dict[str, str] = {}
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        head, _, rest = line.partition(" ")
        out[head.strip()] = rest.strip()
    for required in ("PRE_IMAGE_HEX", "CONTENT_HASH", "SCHEMA_HASH"):
        if required not in out:
            raise AssertionError(
                f"TS harness output missing {required}:\n{proc.stdout}"
            )
    return out


# ---------------------------------------------------------------------------
# Fixed test vectors
# ---------------------------------------------------------------------------

PROMPT_HASH = "a" * 64
RESPONSE_HASH = "b" * 64
MODEL_HASH = "c" * 64
TEE_EVIDENCE_HEX = "de" * 48
OBSERVER_SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"

VECTOR_V1_BASELINE = {
    "schemaVersion": "ai_capability_observation_v1",
    "model": {
        "name": "claude-opus-4-7",
        "version": "20260201",
        "hash": MODEL_HASH,
    },
    "capability": {
        "taxonomyId": "AUTO-MONEY-001",
        "severity": "high",
    },
    "observation": {
        "promptHash": PROMPT_HASH,
        "responseHash": RESPONSE_HASH,
        "artifactRef": "ipfs://QmSomeCidHere",
        "occurredAt": "2026-01-15T12:34:56Z",
    },
    "observer": {
        "ss58": OBSERVER_SS58,
        "context": "scripted regression run",
        "teeAttestation": {
            "tier": "Acurast",
            "evidence": TEE_EVIDENCE_HEX,
        },
    },
}

VECTOR_V2_ALL_NULLS = {
    "schemaVersion": "ai_capability_observation_v1",
    "model": {"name": "anon-model", "version": "v0", "hash": None},
    "capability": {"taxonomyId": "TEST-001", "severity": "low"},
    "observation": {
        "promptHash": PROMPT_HASH,
        "responseHash": RESPONSE_HASH,
        "artifactRef": None,
        "occurredAt": "2026-05-27T00:00:00Z",
    },
    "observer": {
        "ss58": OBSERVER_SS58,
        "context": "no tee, no artifact, no model hash",
        "teeAttestation": None,
    },
}

# Multi-byte UTF-8: 1/2/3-byte chars to stress CBOR major-3 text length head.
VECTOR_V3_UTF8 = {
    "schemaVersion": "ai_capability_observation_v1",
    "model": {
        "name": "modèle-世界",
        "version": "20260201-héllo",
        "hash": MODEL_HASH,
    },
    "capability": {
        "taxonomyId": "MULTI-LINGUAL-001",
        "severity": "medium",
    },
    "observation": {
        "promptHash": PROMPT_HASH,
        "responseHash": RESPONSE_HASH,
        "artifactRef": "ipfs://QmHéllo-世界",
        "occurredAt": "2026-01-15T12:34:56.789Z",
    },
    "observer": {
        "ss58": OBSERVER_SS58,
        "context": "héllo-世界 context",
        "teeAttestation": {
            "tier": "ARM-TZ",
            "evidence": TEE_EVIDENCE_HEX,
        },
    },
}

# 1 KiB of TEE evidence — pushes CBOR length head past 1 byte.
VECTOR_V4_LONG_EVIDENCE = {
    "schemaVersion": "ai_capability_observation_v1",
    "model": {
        "name": "long-evidence-model",
        "version": "1.0.0",
        "hash": MODEL_HASH,
    },
    "capability": {
        "taxonomyId": "LONG-EVIDENCE",
        "severity": "critical",
    },
    "observation": {
        "promptHash": PROMPT_HASH,
        "responseHash": RESPONSE_HASH,
        "artifactRef": "https://example.com/transcripts/abc.txt",
        "occurredAt": "2026-03-10T08:15:30Z",
    },
    "observer": {
        "ss58": OBSERVER_SS58,
        "context": "long-evidence soak test",
        "teeAttestation": {
            "tier": "SEV-SNP",
            "evidence": "ab" * 512,  # 1 024 hex chars = 512 bytes
        },
    },
}

# Minimal-length fields where every optional present is at its smallest.
VECTOR_V5_MINIMAL = {
    "schemaVersion": "ai_capability_observation_v1",
    "model": {
        "name": "m",
        "version": "v",
        "hash": MODEL_HASH,
    },
    "capability": {
        "taxonomyId": "X",
        "severity": "low",
    },
    "observation": {
        "promptHash": PROMPT_HASH,
        "responseHash": RESPONSE_HASH,
        "artifactRef": "x",
        "occurredAt": "2026-01-01T00:00:00Z",
    },
    "observer": {
        "ss58": OBSERVER_SS58,
        "context": "x",
        "teeAttestation": {
            "tier": "build",
            "evidence": "00",
        },
    },
}

# Boundary severity / tier combinations.
VECTOR_V6_BOUNDARY = {
    "schemaVersion": "ai_capability_observation_v1",
    "model": {
        "name": "boundary",
        "version": "2026.5.27",
        "hash": MODEL_HASH,
    },
    "capability": {
        "taxonomyId": "BOUND_CASE_-_42",
        "severity": "critical",
    },
    "observation": {
        "promptHash": PROMPT_HASH,
        "responseHash": RESPONSE_HASH,
        "artifactRef": None,
        "occurredAt": "2026-12-31T23:59:59.999Z",
    },
    "observer": {
        "ss58": OBSERVER_SS58,
        "context": "x" * 280,  # exact context-length cap
        "teeAttestation": {
            "tier": "build",
            "evidence": TEE_EVIDENCE_HEX,
        },
    },
}

ALL_VECTORS = [
    ("V1_baseline", VECTOR_V1_BASELINE),
    ("V2_all_nulls", VECTOR_V2_ALL_NULLS),
    ("V3_utf8", VECTOR_V3_UTF8),
    ("V4_long_evidence", VECTOR_V4_LONG_EVIDENCE),
    ("V5_minimal", VECTOR_V5_MINIMAL),
    ("V6_boundary", VECTOR_V6_BOUNDARY),
]


@pytest.mark.parametrize(
    "name,vector",
    ALL_VECTORS,
    ids=lambda x: x if isinstance(x, str) else "vec",
)
def test_cross_lang_pre_image_byte_equal(name: str, vector: Dict) -> None:
    """Python and TS produce byte-identical canonical CBOR pre-images."""
    py_bytes = canonical_cbor_pre_image(vector)
    ts_out = _run_ts_harness(vector)
    assert ts_out["PRE_IMAGE_HEX"] == py_bytes.hex(), (
        f"[{name}] pre-image bytes differ between TS and Python"
    )


@pytest.mark.parametrize(
    "name,vector",
    ALL_VECTORS,
    ids=lambda x: x if isinstance(x, str) else "vec",
)
def test_cross_lang_content_hash_equal(name: str, vector: Dict) -> None:
    """Python and TS produce the same content_hash (sha256 of pre-image)."""
    py_hash = canonical_content_hash(vector)
    ts_out = _run_ts_harness(vector)
    assert ts_out["CONTENT_HASH"] == py_hash, (
        f"[{name}] content_hash differs: TS={ts_out['CONTENT_HASH']}, "
        f"Python={py_hash}"
    )


def test_cross_lang_schema_hash_constant() -> None:
    """SCHEMA_HASH_HEX is identical TS-side and Python-side."""
    ts_out = _run_ts_harness(VECTOR_V1_BASELINE)
    assert ts_out["SCHEMA_HASH"] == SCHEMA_HASH_HEX

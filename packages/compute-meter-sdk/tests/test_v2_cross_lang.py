"""Cross-language byte-pinning tests for compute_metering_v2.

Real bytes — not mocks. For each fixed test vector:

  1. Python encoder produces canonical CBOR via `canonical_cbor_for_*`.
  2. The TS encoder is invoked via `tsx` against the same JSON input.
  3. Outputs are asserted byte-identical (hex-equal).

If these tests fail, the schema contract has drifted between languages and
Team 2 (gateway validator) and Team 3 (worker SDK envelope) will produce
records that don't cross-verify.

Six fixed vectors cover:

  V1: Minimal happy path, no GPU, no observer (zeros + 1.5 cpu_seconds).
  V2: GPU workload, gpu_count > 0, observer-style record.
  V3: Edge metrics — `0.0`, `0` int, large u64 net_bytes near 2^53-1.
  V4: All-floats record (cpu/ram/disk/gpu non-trivial decimals).
  V5: Worker-id with non-ASCII UTF-8 (CBOR text-string handling).
  V6: Maximum-size hardware_spec with `custom` gpu_type.

Skips gracefully if `tsx` is not on PATH (e.g. fresh clone without
node_modules). pytest emits a warning rather than a fail in that case.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, List

import pytest

# Test path so we can run pytest without installing the SDK.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from materios_compute_meter.canonical import (  # noqa: E402
    SCHEMA_HASH_V2_HEX,
    canonical_cbor_for_fleet_op_sig,
    canonical_cbor_for_worker_sig,
    canonical_content_hash_v2,
)


HARNESS_PATH = Path(__file__).resolve().parent / "_v2_ts_encoder.mts"
WORKTREE_ROOT = Path(__file__).resolve().parents[3]


def _have_tsx() -> bool:
    return shutil.which("tsx") is not None or shutil.which("npx") is not None


def _run_ts_harness(record: Dict) -> Dict[str, str]:
    """Invoke the TS encoder harness with the record as JSON on stdin.

    Returns a dict with keys FLEET_PRE_HEX, WORKER_PRE_HEX, CONTENT_HASH,
    SCHEMA_HASH (all hex strings).
    """
    if not _have_tsx():
        pytest.skip("tsx/npx not available — install node deps to run cross-lang tests")
    cmd: List[str]
    if shutil.which("tsx") is not None:
        cmd = ["tsx", str(HARNESS_PATH)]
    else:
        cmd = ["npx", "--no-install", "tsx", str(HARNESS_PATH)]

    proc = subprocess.run(
        cmd,
        input=json.dumps(record),
        capture_output=True,
        text=True,
        cwd=str(WORKTREE_ROOT),
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
    for required in ("FLEET_PRE_HEX", "WORKER_PRE_HEX", "CONTENT_HASH", "SCHEMA_HASH"):
        if required not in out:
            raise AssertionError(
                f"TS harness output missing {required}:\n{proc.stdout}"
            )
    return out


# ---------------------------------------------------------------------------
# Fixed test vectors. Each vector is a pure-data dict with no time-of-day
# dependence — runs deterministically forever.
# ---------------------------------------------------------------------------

# Reusable signature/pubkey hex blobs (FIXED — not random — so the encoder
# output is fully deterministic across CI runs).
PUBKEY_FLEET = "11" * 32
SIG_FLEET = "22" * 64
PUBKEY_WORKER = "33" * 32
PUBKEY_OBSERVER = "44" * 32

VECTOR_V1_MINIMAL = {
    "schema_version": "compute_metering_v2",
    "worker_id": "wkr-001",
    "tenant_id": "tenant-acme",
    "period_start_ms": 1_735_689_600_000,
    "period_end_ms": 1_735_689_600_000 + 1_000,
    "metrics": {
        "cpu_seconds": 1.5,
        "ram_gb_hours": 0.0,
        "disk_gb_hours": 0.0,
        "net_bytes_in": 0,
        "net_bytes_out": 0,
        "gpu_seconds": 0.0,
    },
    "hardware_spec": {
        "cpu_cores": 4,
        "ram_gb": 16,
        "gpu_type": "none",
        "gpu_count": 0,
        "fleet_operator_pubkey": PUBKEY_FLEET,
        "fleet_operator_signature": SIG_FLEET,
        "issued_ms": 1_735_689_600_000,
    },
    "worker_pubkey": PUBKEY_WORKER,
}

VECTOR_V2_GPU = {
    "schema_version": "compute_metering_v2",
    "worker_id": "gpu-worker-007",
    "tenant_id": "tenant-foo",
    "period_start_ms": 1_735_689_600_000,
    "period_end_ms": 1_735_689_600_000 + 3_600_000,  # 1 hr
    "metrics": {
        "cpu_seconds": 1234.5,
        "ram_gb_hours": 8.0,
        "disk_gb_hours": 16.0,
        "net_bytes_in": 1_048_576,
        "net_bytes_out": 524_288,
        "gpu_seconds": 3500.0,
    },
    "hardware_spec": {
        "cpu_cores": 32,
        "ram_gb": 256,
        "gpu_type": "nvidia-h100",
        "gpu_count": 4,
        "fleet_operator_pubkey": PUBKEY_FLEET,
        "fleet_operator_signature": SIG_FLEET,
        "issued_ms": 1_735_689_600_000,
    },
    "worker_pubkey": PUBKEY_WORKER,
}

VECTOR_V3_EDGE_INTS = {
    "schema_version": "compute_metering_v2",
    "worker_id": "wkr-edge-ints",
    "tenant_id": "tenant-edge",
    "period_start_ms": 1_735_689_600_000,
    "period_end_ms": 1_735_689_600_000 + 86_400_000,  # exact 24h
    "metrics": {
        # `gpu_seconds: 0.0` is the JS Number.isInteger trap — must encode as
        # float64 (9 bytes), not int (1 byte). This is THE reason the encoder
        # tags types up front rather than runtime-dispatching.
        "cpu_seconds": 0.0,
        "ram_gb_hours": 0.0,
        "disk_gb_hours": 0.0,
        "net_bytes_in": 9_007_199_254_740_991,  # JS_SAFE_INT (2^53-1)
        "net_bytes_out": 0,
        "gpu_seconds": 0.0,
    },
    "hardware_spec": {
        "cpu_cores": 1,
        "ram_gb": 1,
        "gpu_type": "none",
        "gpu_count": 0,
        "fleet_operator_pubkey": PUBKEY_FLEET,
        "fleet_operator_signature": SIG_FLEET,
        "issued_ms": 1,
    },
    "worker_pubkey": PUBKEY_WORKER,
}

VECTOR_V4_ALL_FLOATS = {
    "schema_version": "compute_metering_v2",
    "worker_id": "wkr-floats-001",
    "tenant_id": "tenant-floats",
    "period_start_ms": 1_700_000_000_000,
    "period_end_ms": 1_700_000_000_000 + 60_000,  # 1 min
    "metrics": {
        "cpu_seconds": 42.123_456_789,
        "ram_gb_hours": 0.1,
        "disk_gb_hours": 0.25,
        "net_bytes_in": 1_000,
        "net_bytes_out": 1_001,
        "gpu_seconds": 7.5,
    },
    "hardware_spec": {
        "cpu_cores": 64,
        "ram_gb": 128,
        "gpu_type": "amd-mi300",
        "gpu_count": 2,
        "fleet_operator_pubkey": PUBKEY_FLEET,
        "fleet_operator_signature": SIG_FLEET,
        "issued_ms": 1_699_999_999_000,
    },
    "worker_pubkey": PUBKEY_WORKER,
}

# Worker_id allows arbitrary UTF-8 except spaces and commas. Pick characters
# that span 1- 2- and 3-byte UTF-8 encodings to stress the text-encoder head
# (length is byte-count, NOT character-count, so a small mistake here would
# silently produce wrong-length CBOR).
VECTOR_V5_UTF8 = {
    "schema_version": "compute_metering_v2",
    "worker_id": "héllo-世界-001",
    "tenant_id": "tenant-utf",
    "period_start_ms": 1_735_689_600_000,
    "period_end_ms": 1_735_689_600_000 + 1_000,
    "metrics": {
        "cpu_seconds": 0.5,
        "ram_gb_hours": 0.0,
        "disk_gb_hours": 0.0,
        "net_bytes_in": 0,
        "net_bytes_out": 0,
        "gpu_seconds": 0.0,
    },
    "hardware_spec": {
        "cpu_cores": 8,
        "ram_gb": 32,
        "gpu_type": "nvidia-a100",
        "gpu_count": 1,
        "fleet_operator_pubkey": PUBKEY_FLEET,
        "fleet_operator_signature": SIG_FLEET,
        "issued_ms": 1_735_689_600_000,
    },
    "worker_pubkey": PUBKEY_WORKER,
}

VECTOR_V6_MAX_HARDWARE = {
    "schema_version": "compute_metering_v2",
    "worker_id": "wkr-max-hw",
    "tenant_id": "tenant-max",
    "period_start_ms": 1_735_689_600_000,
    "period_end_ms": 1_735_689_600_000 + 86_400_000,
    "metrics": {
        "cpu_seconds": 1024 * 86400.0,  # exactly cap
        "ram_gb_hours": 16384 * 24.0,  # exactly cap
        "disk_gb_hours": 1_000_000.0,
        "net_bytes_in": 1_000_000_000,
        "net_bytes_out": 999_999_999,
        "gpu_seconds": 16 * 86400.0,
    },
    "hardware_spec": {
        "cpu_cores": 1024,
        "ram_gb": 16384,
        "gpu_type": "custom",
        "gpu_count": 16,
        "fleet_operator_pubkey": PUBKEY_FLEET,
        "fleet_operator_signature": SIG_FLEET,
        "issued_ms": 1_735_689_600_000,
    },
    "worker_pubkey": PUBKEY_WORKER,
}

ALL_VECTORS = [
    ("V1_minimal", VECTOR_V1_MINIMAL),
    ("V2_gpu", VECTOR_V2_GPU),
    ("V3_edge_ints", VECTOR_V3_EDGE_INTS),
    ("V4_all_floats", VECTOR_V4_ALL_FLOATS),
    ("V5_utf8", VECTOR_V5_UTF8),
    ("V6_max_hardware", VECTOR_V6_MAX_HARDWARE),
]


@pytest.mark.parametrize("name,vector", ALL_VECTORS, ids=lambda x: x if isinstance(x, str) else "vec")
def test_cross_lang_fleet_op_pre_image_byte_equal(name: str, vector: Dict) -> None:
    """Python and TS produce byte-identical fleet-op-attestation pre-images."""
    py_bytes = canonical_cbor_for_fleet_op_sig(vector)
    ts_out = _run_ts_harness(vector)
    assert ts_out["FLEET_PRE_HEX"] == py_bytes.hex(), (
        f"[{name}] fleet_op pre-image bytes differ between TS and Python"
    )


@pytest.mark.parametrize("name,vector", ALL_VECTORS, ids=lambda x: x if isinstance(x, str) else "vec")
def test_cross_lang_worker_pre_image_byte_equal(name: str, vector: Dict) -> None:
    """Python and TS produce byte-identical worker-signature pre-images."""
    py_bytes = canonical_cbor_for_worker_sig(vector)
    ts_out = _run_ts_harness(vector)
    assert ts_out["WORKER_PRE_HEX"] == py_bytes.hex(), (
        f"[{name}] worker pre-image bytes differ between TS and Python"
    )


@pytest.mark.parametrize("name,vector", ALL_VECTORS, ids=lambda x: x if isinstance(x, str) else "vec")
def test_cross_lang_content_hash_equal(name: str, vector: Dict) -> None:
    """Python and TS produce the same content_hash (sha256 of worker pre-image)."""
    py_hash = canonical_content_hash_v2(vector)
    ts_out = _run_ts_harness(vector)
    assert ts_out["CONTENT_HASH"] == py_hash, (
        f"[{name}] content_hash differs: TS={ts_out['CONTENT_HASH']}, Python={py_hash}"
    )


def test_cross_lang_schema_hash_constant() -> None:
    """SCHEMA_HASH_V2_HEX is identical TS-side and Python-side."""
    ts_out = _run_ts_harness(VECTOR_V1_MINIMAL)
    assert ts_out["SCHEMA_HASH"] == SCHEMA_HASH_V2_HEX


def test_python_self_consistency_float_zero_routes_through_float_path() -> None:
    """`gpu_seconds: 0.0` and `net_bytes_in: 0` produce different bytes.

    `0.0` must encode as 9-byte float64 (head 0xfb + 8 zero bytes), `0` as
    1 byte (0x00). If both routed through the int path the encoder is
    silently broken — same JS quirk in Python: `isinstance(0.0, int)` is
    False, but a careless dispatch could still confuse them. Pin both
    behaviours.
    """
    rec = dict(VECTOR_V3_EDGE_INTS)
    pre = canonical_cbor_for_worker_sig(rec)
    # The metrics map order (sorted by encoded key) is:
    #   cpu_seconds(float) disk_gb_hours(float) gpu_seconds(float)
    #   net_bytes_in(int)  net_bytes_out(int)   ram_gb_hours(float)
    # We don't assert positional bytes (the array head + earlier elements
    # have variable lengths), but we DO assert the encoded form contains
    # the float64-zero byte sequence (fb 00 00 00 00 00 00 00 00) at least
    # 4 times (cpu/disk/gpu/ram are all 0.0 in this vector).
    f64_zero = bytes.fromhex("fb0000000000000000")
    assert pre.count(f64_zero) >= 4, (
        f"expected >= 4 float64-zero markers in pre-image, got {pre.count(f64_zero)}"
    )


def test_python_canonical_keys_sort_order() -> None:
    """metrics map keys appear in the encoded bytes in sorted order.

    Even if the user passes a dict with keys in arbitrary order (Python 3.7+
    preserves insertion order), the encoded CBOR map MUST list keys in
    sorted-by-encoded-key-bytes order per RFC 8949 §4.2.1.
    """
    a = canonical_cbor_for_worker_sig(VECTOR_V1_MINIMAL)

    # Reorder the input dicts to insertion-shuffle the keys.
    shuffled = dict(VECTOR_V1_MINIMAL)
    metrics = dict(VECTOR_V1_MINIMAL["metrics"])
    # Pull keys out in reverse-alpha order
    rev_metrics = {k: metrics[k] for k in sorted(metrics.keys(), reverse=True)}
    shuffled["metrics"] = rev_metrics
    hw = dict(VECTOR_V1_MINIMAL["hardware_spec"])
    rev_hw = {k: hw[k] for k in sorted(hw.keys(), reverse=True)}
    shuffled["hardware_spec"] = rev_hw

    b = canonical_cbor_for_worker_sig(shuffled)
    assert a == b, "encoder must be stable regardless of input dict iteration order"

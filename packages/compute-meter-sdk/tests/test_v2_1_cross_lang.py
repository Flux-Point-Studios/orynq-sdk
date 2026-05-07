"""Cross-language byte-pinning tests for compute_metering_v2.1.

Same harness pattern as `test_v2_cross_lang.py`: each fixed vector is
encoded by the Python encoder AND by the TS encoder (via tsx subprocess),
and the resulting bytes are asserted byte-identical.

Three sets of cases:

  1. Pure-v2 backwards compat — empty/absent attestation_evidence MUST
     produce v2-identical bytes (no schema flip).
  2. v2.1 vectors V21_2 / V21_3 / V21_4 — single + two + four entries.
     Each pinned spec hash is captured below; if either encoder drifts the
     test catches it on first PR.
  3. Empty-evidence-vec hash sanity (sha256 of CBOR `0x80`).

Skips gracefully if `tsx` is not on PATH.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, List

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from materios_compute_meter.canonical import (  # noqa: E402
    EVIDENCE_TYPE_DISCRIMINANT,
    EVIDENCE_TYPES,
    SCHEMA_HASH_V2_1_HEX,
    SCHEMA_VERSION_V2_1,
    attestation_evidence_hash,
    canonical_cbor_for_worker_sig,
    canonical_content_hash_v2,
    derive_evidence_nonce,
)


HARNESS_PATH = Path(__file__).resolve().parent / "_v2_1_ts_encoder.mts"
WORKTREE_ROOT = Path(__file__).resolve().parents[3]


def _have_tsx() -> bool:
    return shutil.which("tsx") is not None or shutil.which("npx") is not None


def _run_ts_harness(record: Dict, evidence) -> Dict[str, str]:
    """Invoke the TS encoder harness with the record + evidence as JSON.

    Returns a dict with keys WORKER_PRE_HEX, CONTENT_HASH, EV_HASH,
    SCHEMA_HASH_V2_1.
    """
    if not _have_tsx():
        pytest.skip("tsx/npx not available — install node deps to run cross-lang tests")
    cmd: List[str]
    if shutil.which("tsx") is not None:
        cmd = ["tsx", str(HARNESS_PATH)]
    else:
        cmd = ["npx", "--no-install", "tsx", str(HARNESS_PATH)]

    payload = {"record": record, "evidence": evidence}
    proc = subprocess.run(
        cmd,
        input=json.dumps(payload),
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
    for required in (
        "WORKER_PRE_HEX",
        "CONTENT_HASH",
        "EV_HASH",
        "SCHEMA_HASH_V2_1",
    ):
        if required not in out:
            raise AssertionError(
                f"TS harness output missing {required}:\n{proc.stdout}"
            )
    return out


# ---------------------------------------------------------------------------
# Fixed test vectors. Pubkeys/sigs are deterministic synthetic bytes so the
# encoder output is reproducible across runs.
# ---------------------------------------------------------------------------

PUBKEY_FLEET = "11" * 32
SIG_FLEET = "22" * 64
PUBKEY_WORKER = "33" * 32

BASE_RECORD = {
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

# Pinned content_hash of the BASE_RECORD when no evidence is present. This
# is the input to all evidence-nonce derivations below — change here will
# cascade into every vector hash.
BASE_V2_CONTENT_HASH = (
    "14fe18164cca4778b0166b00d06845547ead5ab99a31a1edd30f7c78f8defc0e"
)


def _vector_v21_1():
    """Pure backwards-compat: explicit empty evidence == v2 content_hash."""
    return BASE_RECORD, []


def _vector_v21_2():
    """Single ArmTrustZone evidence entry."""
    payload = {
        "device_model": "Pixel-8",
        "security_level": "TrustedEnvironment",
        "key_attestation_chain_b64": "AAECAw==",
        "processor_pubkey_b64": "AAECAwQFBgc=",
    }
    evidence = [
        {
            "evidence_type": "arm_trustzone",
            "nonce": derive_evidence_nonce(BASE_V2_CONTENT_HASH, "arm_trustzone"),
            "payload": payload,
        }
    ]
    return BASE_RECORD, evidence


def _vector_v21_3():
    """Two entries (ArmTrustZone + ReproducibleBuild). Tests sort path."""
    evidence = [
        # Insert in reverse discriminant order.
        {
            "evidence_type": "reproducible_build",
            "nonce": derive_evidence_nonce(BASE_V2_CONTENT_HASH, "reproducible_build"),
            "payload": {"nar_hash_b64": "AAECAw=="},
        },
        {
            "evidence_type": "arm_trustzone",
            "nonce": derive_evidence_nonce(BASE_V2_CONTENT_HASH, "arm_trustzone"),
            "payload": {"device_model": "Pixel-8"},
        },
    ]
    return BASE_RECORD, evidence


def _vector_v21_4():
    """Four entries: full silicon-vendor + reproducible-build coverage."""
    evidence = [
        {
            "evidence_type": "reproducible_build",
            "nonce": derive_evidence_nonce(BASE_V2_CONTENT_HASH, "reproducible_build"),
            "payload": {
                "nar_hash_b64": "ERERERERERERERERERERERERERERERERERERERERERE=",
                "builder_count": 3,
            },
        },
        {
            "evidence_type": "arm_trustzone",
            "nonce": derive_evidence_nonce(BASE_V2_CONTENT_HASH, "arm_trustzone"),
            "payload": {
                "device_model": "Pixel-8",
                "security_level": "TrustedEnvironment",
                "key_attestation_chain_b64": "AAECAw==",
            },
        },
        {
            "evidence_type": "intel_tdx",
            "nonce": derive_evidence_nonce(BASE_V2_CONTENT_HASH, "intel_tdx"),
            "payload": {"quote_b64": "AAECAwQFBgc=", "qe_id": "abcd1234"},
        },
        {
            "evidence_type": "amd_sev_snp",
            "nonce": derive_evidence_nonce(BASE_V2_CONTENT_HASH, "amd_sev_snp"),
            "payload": {"report_b64": "AAECAwQFBgc=", "tcb_version": 42},
        },
    ]
    return BASE_RECORD, evidence


ALL_VECTORS = [
    ("V21_1_empty_evidence", _vector_v21_1),
    ("V21_2_single_arm", _vector_v21_2),
    ("V21_3_two_arm_build", _vector_v21_3),
    ("V21_4_four_full", _vector_v21_4),
]


# ---------------------------------------------------------------------------
# Pinned spec hashes — once these land in main, they're the canonical test
# vectors that downstream consumers depend on.
# ---------------------------------------------------------------------------

EMPTY_EVIDENCE_HASH = (
    "76be8b528d0075f7aae98d6fa57a6d3c83ae480a8469e668d7b0af968995ac71"
)

PINNED_CONTENT_HASHES = {
    # Backwards compat — empty evidence MUST give the v2 content_hash.
    "V21_1_empty_evidence": BASE_V2_CONTENT_HASH,
    "V21_2_single_arm":
        "761cd5a2c7006d6a06e1b94cd7a349d9215478126b227015d75a06858266c83f",
    "V21_3_two_arm_build":
        "1890fd91981068b92579c0405dae1e251fe147e87d7cee3594bb85b316702839",
    "V21_4_four_full":
        "f9c99103679a0108bb44af49bfdfc262b7549777dc91203232c51153e586f9f2",
}

PINNED_EV_HASHES = {
    "V21_1_empty_evidence": EMPTY_EVIDENCE_HASH,
    "V21_2_single_arm":
        "a1417cb2bc2193258b54fa482f7a5859a1800b63e27cd2c11762e154d30ad30c",
    "V21_3_two_arm_build":
        "5730e81c668fec41c1bf72513fa75d099476ae0c3f134f946746d6e2af92599f",
    "V21_4_four_full":
        "4cd2e759dcb82d7d6821d39439c3136ec17de216a35fce6e4e2a34eaa5a2aa93",
}


# ===========================================================================
# Python self-tests — verify the Python encoder hits the pinned vectors.
# ===========================================================================


@pytest.mark.parametrize("name,builder", ALL_VECTORS)
def test_python_content_hash_pinned(name, builder):
    record, evidence = builder()
    actual = canonical_content_hash_v2(record, evidence)
    assert actual == PINNED_CONTENT_HASHES[name], (
        f"[{name}] content_hash drift: expected {PINNED_CONTENT_HASHES[name]}, "
        f"got {actual}"
    )


@pytest.mark.parametrize("name,builder", ALL_VECTORS)
def test_python_evidence_hash_pinned(name, builder):
    _record, evidence = builder()
    actual = attestation_evidence_hash(evidence)
    assert actual == PINNED_EV_HASHES[name], (
        f"[{name}] evidence_hash drift: expected {PINNED_EV_HASHES[name]}, "
        f"got {actual}"
    )


def test_empty_evidence_hash_is_sha256_of_cbor_empty_array():
    """The empty-vec hash is sha256 of the single CBOR byte 0x80, NOT zeros."""
    expected = hashlib.sha256(bytes([0x80])).hexdigest()
    assert attestation_evidence_hash([]) == expected
    assert attestation_evidence_hash([]) == EMPTY_EVIDENCE_HASH


def test_python_v2_backwards_compat_no_evidence_keeps_v2_bytes():
    """A v2 record + None evidence == v2 record + empty list == v2-only."""
    only_v2 = canonical_cbor_for_worker_sig(BASE_RECORD)
    explicit_none = canonical_cbor_for_worker_sig(BASE_RECORD, None)
    explicit_empty = canonical_cbor_for_worker_sig(BASE_RECORD, [])
    assert only_v2 == explicit_none == explicit_empty


def test_python_evidence_sort_by_discriminant_not_alpha():
    """ReproducibleBuild(3) MUST come AFTER ArmTrustZone(2), regardless of
    input order. The sort key is the discriminant index, not the name."""
    evidence_a = [
        {
            "evidence_type": "reproducible_build",
            "nonce": "ff" * 32,
            "payload": {},
        },
        {
            "evidence_type": "arm_trustzone",
            "nonce": "ff" * 32,
            "payload": {},
        },
    ]
    evidence_b = list(reversed(evidence_a))
    h_a = attestation_evidence_hash(evidence_a)
    h_b = attestation_evidence_hash(evidence_b)
    assert h_a == h_b


def test_evidence_type_discriminant_pinned():
    """The discriminant indices are load-bearing — pinned across TS+Python+pallet."""
    assert EVIDENCE_TYPES == (
        "amd_sev_snp",
        "intel_tdx",
        "arm_trustzone",
        "reproducible_build",
        "zkvm_execution",
    )
    assert EVIDENCE_TYPE_DISCRIMINANT == {
        "amd_sev_snp": 0,
        "intel_tdx": 1,
        "arm_trustzone": 2,
        "reproducible_build": 3,
        "zkvm_execution": 4,
    }


# ===========================================================================
# Cross-language tests — Python encoder vs TS encoder via tsx harness.
# ===========================================================================


@pytest.mark.parametrize("name,builder", ALL_VECTORS)
def test_cross_lang_worker_pre_image_byte_equal(name, builder):
    record, evidence = builder()
    py_bytes = canonical_cbor_for_worker_sig(record, evidence)
    ts_out = _run_ts_harness(record, evidence)
    assert ts_out["WORKER_PRE_HEX"] == py_bytes.hex(), (
        f"[{name}] worker pre-image bytes differ between TS and Python"
    )


@pytest.mark.parametrize("name,builder", ALL_VECTORS)
def test_cross_lang_content_hash_equal(name, builder):
    record, evidence = builder()
    py_hash = canonical_content_hash_v2(record, evidence)
    ts_out = _run_ts_harness(record, evidence)
    assert ts_out["CONTENT_HASH"] == py_hash, (
        f"[{name}] content_hash differs: TS={ts_out['CONTENT_HASH']}, "
        f"Python={py_hash}"
    )


@pytest.mark.parametrize("name,builder", ALL_VECTORS)
def test_cross_lang_evidence_hash_equal(name, builder):
    record, evidence = builder()
    py_ev = attestation_evidence_hash(evidence)
    ts_out = _run_ts_harness(record, evidence)
    assert ts_out["EV_HASH"] == py_ev, (
        f"[{name}] evidence_hash differs: TS={ts_out['EV_HASH']}, Python={py_ev}"
    )


def test_cross_lang_schema_hash_v2_1_constant():
    ts_out = _run_ts_harness(*_vector_v21_2())
    assert ts_out["SCHEMA_HASH_V2_1"] == SCHEMA_HASH_V2_1_HEX

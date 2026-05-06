"""Python-side validation + signature tests for compute_metering_v2.

Exercises the Python encoders against the SAME spec rules as the TS-side
test file (`services/blob-gateway/src/schemas/__tests__/compute_metering_v2.test.ts`):

  - The Python encoder produces a deterministic worker pre-image.
  - Real sr25519 keypairs sign the pre-image and verify against it.
  - Tampering with the record breaks signature verification.
  - The pre-image format mirrors the spec (array head, sorted maps, byte
    pubkeys, etc.).

The Python side does NOT validate structural rules (range / regex / period)
— that's the gateway's job (TS-side). What it MUST guarantee is that the
canonical-CBOR pre-image bytes match TS exactly AND that round-trip signing
works. Those are the cross-language invariants the worker SDK relies on
to produce a record the gateway will accept.

No mocks for crypto — uses `Keypair.create_from_uri('//URI')` for
reproducibility.
"""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path
from typing import Dict

import pytest
from substrateinterface import Keypair, KeypairType

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from materios_compute_meter.canonical import (  # noqa: E402
    SCHEMA_HASH_V2_HEX,
    SCHEMA_VERSION_V2,
    canonical_cbor_for_fleet_op_sig,
    canonical_cbor_for_worker_sig,
    canonical_content_hash_v2,
)


def _keypair(uri: str) -> Keypair:
    return Keypair.create_from_uri(uri, crypto_type=KeypairType.SR25519, ss58_format=42)


def _build_record(
    *,
    worker_uri: str = "//ComputeWorker0",
    fleet_uri: str = "//FleetOperator0",
    observer_uri: str | None = None,
    period_start_ms: int = 1_735_689_600_000,
    period_end_ms: int = 1_735_689_600_000 + 3_600_000,
    metrics_overrides: Dict | None = None,
    hardware_overrides: Dict | None = None,
    worker_id: str = "worker-001",
    tenant_id: str = "tenant-acme",
) -> Dict:
    """Build a fully-signed valid record and return it as a dict."""
    fleet = _keypair(fleet_uri)
    worker = _keypair(worker_uri)

    metrics = {
        "cpu_seconds": 60.5,
        "ram_gb_hours": 0.5,
        "disk_gb_hours": 1.25,
        "net_bytes_in": 1_048_576,
        "net_bytes_out": 524_288,
        "gpu_seconds": 0.0,
    }
    if metrics_overrides:
        metrics.update(metrics_overrides)

    base_spec = {
        "cpu_cores": 4,
        "ram_gb": 16,
        "gpu_type": "none",
        "gpu_count": 0,
        "issued_ms": period_start_ms,
        "fleet_operator_pubkey": fleet.public_key.hex(),
    }
    if hardware_overrides:
        base_spec.update(hardware_overrides)

    # Sign the fleet-op pre-image (which excludes the signature field).
    pre_for_fleet = canonical_cbor_for_fleet_op_sig(
        {
            "worker_id": worker_id,
            # The function ignores fleet_operator_signature — pass placeholder.
            "hardware_spec": {**base_spec, "fleet_operator_signature": "00" * 64},
        }
    )
    fleet_sig = fleet.sign(pre_for_fleet)
    hardware_spec = {**base_spec, "fleet_operator_signature": fleet_sig.hex()}

    record = {
        "schema_version": SCHEMA_VERSION_V2,
        "worker_id": worker_id,
        "tenant_id": tenant_id,
        "period_start_ms": period_start_ms,
        "period_end_ms": period_end_ms,
        "metrics": metrics,
        "hardware_spec": hardware_spec,
        "worker_pubkey": worker.public_key.hex(),
    }
    pre_for_worker = canonical_cbor_for_worker_sig(record)
    record["worker_signature"] = worker.sign(pre_for_worker).hex()

    if observer_uri:
        observer = _keypair(observer_uri)
        observer_sig = observer.sign(pre_for_worker)
        record["observer"] = {
            "observer_pubkey": observer.public_key.hex(),
            "observer_signature": observer_sig.hex(),
        }
    return record


# ---------------------------------------------------------------------------
# Schema constants
# ---------------------------------------------------------------------------


def test_schema_hash_is_sha256_of_version_string() -> None:
    expected = hashlib.sha256(SCHEMA_VERSION_V2.encode("utf-8")).hexdigest()
    assert SCHEMA_HASH_V2_HEX == expected


def test_schema_hash_v2_differs_from_v1() -> None:
    v1 = hashlib.sha256(b"compute_metering_v1").hexdigest()
    assert SCHEMA_HASH_V2_HEX != v1


# ---------------------------------------------------------------------------
# Pre-image structure (rule 8 byte-pinning)
# ---------------------------------------------------------------------------


def test_worker_pre_image_starts_with_array_head_8_elements() -> None:
    """The worker pre-image is an 8-element CBOR array. Major type 4,
    8 elements ≤ 23 → first byte = (4 << 5) | 8 = 0x88.
    """
    rec = _build_record()
    pre = canonical_cbor_for_worker_sig(rec)
    assert pre[0] == 0x88, f"expected 0x88 (array of 8), got {pre[0]:#04x}"


def test_fleet_pre_image_starts_with_array_head_4_elements() -> None:
    """Fleet-op pre-image is a 4-element CBOR array → 0x84."""
    rec = _build_record()
    pre = canonical_cbor_for_fleet_op_sig(rec)
    assert pre[0] == 0x84, f"expected 0x84 (array of 4), got {pre[0]:#04x}"


def test_worker_pre_image_contains_schema_version_text() -> None:
    """The schema version string 'compute_metering_v2' must appear (in
    UTF-8) right after the array head."""
    rec = _build_record()
    pre = canonical_cbor_for_worker_sig(rec)
    assert b"compute_metering_v2" in pre


def test_fleet_pre_image_contains_fleet_op_tag() -> None:
    rec = _build_record()
    pre = canonical_cbor_for_fleet_op_sig(rec)
    assert b"fleet_op_attestation_v1" in pre


# ---------------------------------------------------------------------------
# Round-trip signing (rule 7, 8, 9 — Python side)
# ---------------------------------------------------------------------------


def test_fleet_sig_verifies_against_fleet_pubkey() -> None:
    rec = _build_record()
    fleet_pre = canonical_cbor_for_fleet_op_sig(rec)
    fleet_pk = bytes.fromhex(rec["hardware_spec"]["fleet_operator_pubkey"])
    fleet_sig = bytes.fromhex(rec["hardware_spec"]["fleet_operator_signature"])
    verifier = Keypair(public_key=fleet_pk, crypto_type=KeypairType.SR25519, ss58_format=42)
    assert verifier.verify(fleet_pre, fleet_sig) is True


def test_worker_sig_verifies_against_worker_pubkey() -> None:
    rec = _build_record()
    worker_pre = canonical_cbor_for_worker_sig(rec)
    worker_pk = bytes.fromhex(rec["worker_pubkey"])
    worker_sig = bytes.fromhex(rec["worker_signature"])
    verifier = Keypair(public_key=worker_pk, crypto_type=KeypairType.SR25519, ss58_format=42)
    assert verifier.verify(worker_pre, worker_sig) is True


def test_observer_sig_verifies_against_observer_pubkey_over_worker_pre_image() -> None:
    """Observer signs the EXACT SAME bytes as worker. Verifier reconstructs
    the worker pre-image and runs sr25519::verify under observer_pubkey.
    """
    rec = _build_record(observer_uri="//Observer0")
    worker_pre = canonical_cbor_for_worker_sig(rec)
    obs_pk = bytes.fromhex(rec["observer"]["observer_pubkey"])
    obs_sig = bytes.fromhex(rec["observer"]["observer_signature"])
    verifier = Keypair(public_key=obs_pk, crypto_type=KeypairType.SR25519, ss58_format=42)
    assert verifier.verify(worker_pre, obs_sig) is True


# ---------------------------------------------------------------------------
# Tampering breaks verify (negative tests)
# ---------------------------------------------------------------------------


def test_tampering_metrics_breaks_worker_sig_verify() -> None:
    rec = _build_record()
    rec["metrics"]["cpu_seconds"] += 1
    new_pre = canonical_cbor_for_worker_sig(rec)
    worker_pk = bytes.fromhex(rec["worker_pubkey"])
    worker_sig = bytes.fromhex(rec["worker_signature"])
    verifier = Keypair(public_key=worker_pk, crypto_type=KeypairType.SR25519, ss58_format=42)
    assert verifier.verify(new_pre, worker_sig) is False


def test_tampering_hardware_spec_breaks_both_sigs() -> None:
    """Bumping cpu_cores breaks fleet-op sig (different fleet pre-image)
    AND breaks worker sig (different worker pre-image, since it embeds
    the full hardware_spec including fleet sig)."""
    rec = _build_record()
    fleet_pre_orig = canonical_cbor_for_fleet_op_sig(rec)
    worker_pre_orig = canonical_cbor_for_worker_sig(rec)
    fleet_sig = bytes.fromhex(rec["hardware_spec"]["fleet_operator_signature"])
    worker_sig = bytes.fromhex(rec["worker_signature"])
    fleet_pk = bytes.fromhex(rec["hardware_spec"]["fleet_operator_pubkey"])
    worker_pk = bytes.fromhex(rec["worker_pubkey"])

    # Sanity: original sigs verify against original pre-images.
    fv = Keypair(public_key=fleet_pk, crypto_type=KeypairType.SR25519, ss58_format=42)
    wv = Keypair(public_key=worker_pk, crypto_type=KeypairType.SR25519, ss58_format=42)
    assert fv.verify(fleet_pre_orig, fleet_sig) is True
    assert wv.verify(worker_pre_orig, worker_sig) is True

    # Bump cpu_cores. Both pre-images now differ.
    rec["hardware_spec"]["cpu_cores"] = 8
    fleet_pre_new = canonical_cbor_for_fleet_op_sig(rec)
    worker_pre_new = canonical_cbor_for_worker_sig(rec)
    assert fleet_pre_new != fleet_pre_orig
    assert worker_pre_new != worker_pre_orig
    assert fv.verify(fleet_pre_new, fleet_sig) is False
    assert wv.verify(worker_pre_new, worker_sig) is False


def test_swapping_fleet_pubkey_breaks_fleet_sig_verify() -> None:
    rec = _build_record()
    other_fleet = _keypair("//FleetOperator1")
    rec["hardware_spec"]["fleet_operator_pubkey"] = other_fleet.public_key.hex()
    # Fleet pre-image now references the new pubkey, but sig was made by
    # FleetOperator0. Verifying under FleetOperator1's key fails.
    new_pre = canonical_cbor_for_fleet_op_sig(rec)
    sig = bytes.fromhex(rec["hardware_spec"]["fleet_operator_signature"])
    verifier = Keypair(
        public_key=other_fleet.public_key,
        crypto_type=KeypairType.SR25519,
        ss58_format=42,
    )
    assert verifier.verify(new_pre, sig) is False


def test_observer_signing_wrong_bytes_breaks_observer_verify() -> None:
    rec = _build_record(observer_uri="//Observer0")
    # Observer signed bytes(b'wrong') instead of the worker pre-image.
    observer = _keypair("//Observer0")
    bogus_sig = observer.sign(b"wrong").hex()
    rec["observer"]["observer_signature"] = bogus_sig

    worker_pre = canonical_cbor_for_worker_sig(rec)
    obs_pk = bytes.fromhex(rec["observer"]["observer_pubkey"])
    verifier = Keypair(public_key=obs_pk, crypto_type=KeypairType.SR25519, ss58_format=42)
    assert verifier.verify(worker_pre, bytes.fromhex(bogus_sig)) is False


# ---------------------------------------------------------------------------
# Encoder negative path — types, NaN, infinity
# ---------------------------------------------------------------------------


def test_encoder_rejects_nan_in_metrics() -> None:
    rec = _build_record()
    rec["metrics"]["cpu_seconds"] = float("nan")
    with pytest.raises(TypeError, match="NaN"):
        canonical_cbor_for_worker_sig(rec)


def test_encoder_rejects_infinity_in_metrics() -> None:
    rec = _build_record()
    rec["metrics"]["cpu_seconds"] = float("inf")
    with pytest.raises(TypeError, match="Infinity"):
        canonical_cbor_for_worker_sig(rec)


def test_encoder_rejects_bool_where_int_expected() -> None:
    """`True` is `int` in Python — the encoder must NOT silently encode it
    as the integer 1. (TS encoder also blocks bool implicitly because
    typeof True === 'boolean', not 'number'.)"""
    rec = _build_record()
    rec["metrics"]["net_bytes_in"] = True  # type: ignore[assignment]
    with pytest.raises(TypeError):
        canonical_cbor_for_worker_sig(rec)


# ---------------------------------------------------------------------------
# Float-zero quirk: gpu_seconds=0.0 must encode as float64, not int
# ---------------------------------------------------------------------------


def test_gpu_seconds_zero_float_encodes_as_float64() -> None:
    """Schema-typed float fields ALWAYS emit float64 even when the runtime
    value is an integer-valued float. Mirrors the JS quirk
    `Number.isInteger(0.0) === true`. Verifies via direct byte inspection
    of the metrics map.
    """
    rec = _build_record(metrics_overrides={"gpu_seconds": 0.0})
    pre = canonical_cbor_for_worker_sig(rec)
    # The metrics map keys (sorted by encoded-key bytes) are:
    #   cpu_seconds disk_gb_hours gpu_seconds net_bytes_in net_bytes_out ram_gb_hours
    # Since cpu_seconds=60.5 is a non-trivial float in the default record,
    # we expect at least 4 occurrences of the float64-zero pattern (disk,
    # gpu, ram are 0.0 here in the default record? No — disk=1.25 in default.
    # Use a fresh all-zero record).
    rec_zeros = _build_record(
        metrics_overrides={
            "cpu_seconds": 0.0,
            "ram_gb_hours": 0.0,
            "disk_gb_hours": 0.0,
            "gpu_seconds": 0.0,
        }
    )
    pre_zeros = canonical_cbor_for_worker_sig(rec_zeros)
    f64_zero_marker = bytes.fromhex("fb0000000000000000")
    # 4 floats are exactly 0.0 in this vector (cpu/ram/disk/gpu).
    assert pre_zeros.count(f64_zero_marker) == 4, (
        f"expected 4 float64-zero markers, got {pre_zeros.count(f64_zero_marker)}; "
        f"pre[hex]={pre_zeros.hex()}"
    )
    # And `pre` must not silently encode gpu_seconds=0.0 as int (which would
    # be just a single 0x00 byte and would NOT contain the f64 marker for
    # that field).
    assert pre.count(f64_zero_marker) >= 1


# ---------------------------------------------------------------------------
# content_hash matches sha256(worker pre-image)
# ---------------------------------------------------------------------------


def test_content_hash_matches_sha256_of_worker_pre_image() -> None:
    rec = _build_record()
    pre = canonical_cbor_for_worker_sig(rec)
    expected = hashlib.sha256(pre).hexdigest()
    assert canonical_content_hash_v2(rec) == expected


# ---------------------------------------------------------------------------
# Determinism across input dict iteration order
# ---------------------------------------------------------------------------


def test_worker_pre_image_stable_under_dict_reordering() -> None:
    rec_a = _build_record()
    # Reverse-sort metrics + hardware_spec key order on the way in.
    rec_b = dict(rec_a)
    rec_b["metrics"] = {
        k: rec_a["metrics"][k] for k in sorted(rec_a["metrics"].keys(), reverse=True)
    }
    rec_b["hardware_spec"] = {
        k: rec_a["hardware_spec"][k]
        for k in sorted(rec_a["hardware_spec"].keys(), reverse=True)
    }
    assert canonical_cbor_for_worker_sig(rec_a) == canonical_cbor_for_worker_sig(rec_b)

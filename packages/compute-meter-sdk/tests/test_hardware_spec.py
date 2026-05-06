"""Tests for HardwareSpec — the FPS-fleet-operator-signed hardware
attestation that pins a worker to a specific machine spec.

Real on-disk JSON round-trips. Real sr25519 signatures.  Mocks are NOT
allowed in this file (per the brief's TDD bar).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from materios_compute_meter.canonical import canonical_cbor_for_fleet_op_sig
from materios_compute_meter.exceptions import InvalidHardwareSpecError
from materios_compute_meter.hardware_spec import (
    HardwareSpec,
    sign_hardware_spec,
)
from materios_compute_meter.keypair import WorkerKeypair


# Deterministic seeds for reproducible tests. NEVER reused outside tests.
_FLEET_SEED_HEX = "0x" + "01" * 32
_OTHER_FLEET_SEED_HEX = "0x" + "02" * 32

_WORKER_ID = "worker-fixture-001"


def _fleet_kp() -> WorkerKeypair:
    """Return a deterministic 'fleet operator' keypair for tests."""
    return WorkerKeypair.from_seed_hex(_FLEET_SEED_HEX)


def _other_fleet_kp() -> WorkerKeypair:
    return WorkerKeypair.from_seed_hex(_OTHER_FLEET_SEED_HEX)


def _make_signed_spec(
    *,
    worker_id: str = _WORKER_ID,
    cpu_cores: int = 8,
    ram_gb: int = 32,
    gpu_type: str = "none",
    gpu_count: int = 0,
    issued_ms: int = 1_700_000_000_000,
) -> HardwareSpec:
    """Build a hardware spec and sign it with the deterministic fleet key."""
    fleet = _fleet_kp()
    return sign_hardware_spec(
        worker_id=worker_id,
        cpu_cores=cpu_cores,
        ram_gb=ram_gb,
        gpu_type=gpu_type,
        gpu_count=gpu_count,
        issued_ms=issued_ms,
        fleet_operator_keypair=fleet,
    )


# --- construction + sign round trip --------------------------------------


def test_sign_hardware_spec_returns_immutable_spec_with_valid_sig() -> None:
    spec = _make_signed_spec()
    assert spec.cpu_cores == 8
    assert spec.ram_gb == 32
    assert spec.gpu_type == "none"
    assert spec.gpu_count == 0
    assert len(spec.fleet_operator_pubkey) == 32
    assert len(spec.fleet_operator_signature) == 64
    assert spec.issued_ms == 1_700_000_000_000

    # Verifies against worker_id used at sign-time.
    assert spec.verify(_WORKER_ID) is True


def test_hardware_spec_is_frozen_dataclass() -> None:
    """Mutating a field after construction raises; the fleet_operator_signature
    would be invalidated and we don't want silent drift."""
    spec = _make_signed_spec()
    with pytest.raises((AttributeError, Exception)):
        spec.cpu_cores = 16  # type: ignore[misc]


def test_verify_returns_false_for_wrong_worker_id() -> None:
    """The signature is bound to a specific worker_id; any other worker_id
    must fail verification."""
    spec = _make_signed_spec(worker_id="worker-A")
    assert spec.verify("worker-A") is True
    assert spec.verify("worker-B") is False


def test_verify_returns_false_when_hardware_spec_tampered() -> None:
    """Tampering with the spec's fields (after the fact) breaks the sig."""
    spec = _make_signed_spec()
    # Build a tampered copy by rebuilding the dataclass with a different cpu_cores.
    tampered = HardwareSpec(
        cpu_cores=999,  # tampered
        ram_gb=spec.ram_gb,
        gpu_type=spec.gpu_type,
        gpu_count=spec.gpu_count,
        fleet_operator_pubkey=spec.fleet_operator_pubkey,
        fleet_operator_signature=spec.fleet_operator_signature,
        issued_ms=spec.issued_ms,
    )
    assert tampered.verify(_WORKER_ID) is False


def test_verify_returns_false_when_signed_by_different_key() -> None:
    """A spec signed with key A must NOT verify against key B's pubkey."""
    a_spec = _make_signed_spec()
    b_kp = _other_fleet_kp()
    bad = HardwareSpec(
        cpu_cores=a_spec.cpu_cores,
        ram_gb=a_spec.ram_gb,
        gpu_type=a_spec.gpu_type,
        gpu_count=a_spec.gpu_count,
        fleet_operator_pubkey=bytes.fromhex(b_kp.public_hex),  # wrong pubkey
        fleet_operator_signature=a_spec.fleet_operator_signature,
        issued_ms=a_spec.issued_ms,
    )
    assert bad.verify(_WORKER_ID) is False


# --- on-disk JSON round trip (REAL files; not in-memory) ------------------


def test_save_load_round_trip_via_real_file(tmp_path: Path) -> None:
    spec = _make_signed_spec()
    p = tmp_path / "fleet-sig.json"
    spec.save(str(p))
    loaded = HardwareSpec.load(str(p))
    assert loaded == spec
    assert loaded.verify(_WORKER_ID) is True


def test_load_real_json_with_fleet_operator_pubkey_hex_keys(tmp_path: Path) -> None:
    """The on-disk JSON schema (per the brief) uses hex-string fields for the
    bytes blobs: `fleet_operator_pubkey_hex`, `fleet_operator_signature_hex`."""
    spec = _make_signed_spec()
    p = tmp_path / "fleet.json"
    p.write_text(
        json.dumps(
            {
                "cpu_cores": spec.cpu_cores,
                "ram_gb": spec.ram_gb,
                "gpu_type": spec.gpu_type,
                "gpu_count": spec.gpu_count,
                "fleet_operator_pubkey_hex": spec.fleet_operator_pubkey.hex(),
                "fleet_operator_signature_hex": spec.fleet_operator_signature.hex(),
                "issued_ms": spec.issued_ms,
            }
        )
    )
    loaded = HardwareSpec.load(str(p))
    assert loaded == spec


def test_save_writes_human_readable_json(tmp_path: Path) -> None:
    spec = _make_signed_spec()
    p = tmp_path / "spec.json"
    spec.save(str(p))
    blob = json.loads(p.read_text())
    # All seven fields present + hex keys.
    assert blob["cpu_cores"] == 8
    assert blob["ram_gb"] == 32
    assert blob["gpu_type"] == "none"
    assert blob["gpu_count"] == 0
    assert blob["issued_ms"] == 1_700_000_000_000
    assert blob["fleet_operator_pubkey_hex"] == spec.fleet_operator_pubkey.hex()
    assert blob["fleet_operator_signature_hex"] == spec.fleet_operator_signature.hex()


# --- malformed input rejection -------------------------------------------


def test_load_rejects_missing_field(tmp_path: Path) -> None:
    p = tmp_path / "missing.json"
    p.write_text(
        json.dumps(
            {
                "cpu_cores": 8,
                "ram_gb": 32,
                # missing gpu_type, gpu_count, etc.
            }
        )
    )
    with pytest.raises(InvalidHardwareSpecError):
        HardwareSpec.load(str(p))


def test_load_rejects_unsupported_gpu_type(tmp_path: Path) -> None:
    p = tmp_path / "bad_gpu.json"
    p.write_text(
        json.dumps(
            {
                "cpu_cores": 8,
                "ram_gb": 32,
                "gpu_type": "tpu-v5",  # not in allowlist
                "gpu_count": 1,
                "fleet_operator_pubkey_hex": "ab" * 32,
                "fleet_operator_signature_hex": "cd" * 64,
                "issued_ms": 1_700_000_000_000,
            }
        )
    )
    with pytest.raises(InvalidHardwareSpecError):
        HardwareSpec.load(str(p))


def test_load_rejects_negative_cpu_cores(tmp_path: Path) -> None:
    p = tmp_path / "neg.json"
    p.write_text(
        json.dumps(
            {
                "cpu_cores": -1,
                "ram_gb": 32,
                "gpu_type": "none",
                "gpu_count": 0,
                "fleet_operator_pubkey_hex": "ab" * 32,
                "fleet_operator_signature_hex": "cd" * 64,
                "issued_ms": 1_700_000_000_000,
            }
        )
    )
    with pytest.raises(InvalidHardwareSpecError):
        HardwareSpec.load(str(p))


def test_load_rejects_pubkey_wrong_length(tmp_path: Path) -> None:
    p = tmp_path / "bad_pub.json"
    p.write_text(
        json.dumps(
            {
                "cpu_cores": 8,
                "ram_gb": 32,
                "gpu_type": "none",
                "gpu_count": 0,
                "fleet_operator_pubkey_hex": "ab" * 16,  # 16 bytes, not 32
                "fleet_operator_signature_hex": "cd" * 64,
                "issued_ms": 1_700_000_000_000,
            }
        )
    )
    with pytest.raises(InvalidHardwareSpecError):
        HardwareSpec.load(str(p))


def test_load_rejects_signature_wrong_length(tmp_path: Path) -> None:
    p = tmp_path / "bad_sig.json"
    p.write_text(
        json.dumps(
            {
                "cpu_cores": 8,
                "ram_gb": 32,
                "gpu_type": "none",
                "gpu_count": 0,
                "fleet_operator_pubkey_hex": "ab" * 32,
                "fleet_operator_signature_hex": "cd" * 32,  # 32 bytes, not 64
                "issued_ms": 1_700_000_000_000,
            }
        )
    )
    with pytest.raises(InvalidHardwareSpecError):
        HardwareSpec.load(str(p))


def test_load_rejects_non_hex_pubkey(tmp_path: Path) -> None:
    p = tmp_path / "non_hex.json"
    p.write_text(
        json.dumps(
            {
                "cpu_cores": 8,
                "ram_gb": 32,
                "gpu_type": "none",
                "gpu_count": 0,
                "fleet_operator_pubkey_hex": "zz" * 32,
                "fleet_operator_signature_hex": "cd" * 64,
                "issued_ms": 1_700_000_000_000,
            }
        )
    )
    with pytest.raises(InvalidHardwareSpecError):
        HardwareSpec.load(str(p))


def test_load_rejects_missing_file(tmp_path: Path) -> None:
    with pytest.raises(InvalidHardwareSpecError):
        HardwareSpec.load(str(tmp_path / "nonexistent.json"))


def test_load_rejects_malformed_json(tmp_path: Path) -> None:
    p = tmp_path / "bad.json"
    p.write_text("{not json at all]")
    with pytest.raises(InvalidHardwareSpecError):
        HardwareSpec.load(str(p))


def test_load_rejects_root_not_object(tmp_path: Path) -> None:
    p = tmp_path / "list.json"
    p.write_text(json.dumps([1, 2, 3]))
    with pytest.raises(InvalidHardwareSpecError):
        HardwareSpec.load(str(p))


def test_load_rejects_gpu_count_zero_when_gpu_type_present(tmp_path: Path) -> None:
    """gpu_type=='nvidia-h100' with gpu_count==0 is incoherent and rejected."""
    p = tmp_path / "incoherent.json"
    p.write_text(
        json.dumps(
            {
                "cpu_cores": 8,
                "ram_gb": 32,
                "gpu_type": "nvidia-h100",
                "gpu_count": 0,  # incoherent
                "fleet_operator_pubkey_hex": "ab" * 32,
                "fleet_operator_signature_hex": "cd" * 64,
                "issued_ms": 1_700_000_000_000,
            }
        )
    )
    with pytest.raises(InvalidHardwareSpecError):
        HardwareSpec.load(str(p))


def test_load_rejects_gpu_count_nonzero_when_gpu_type_none(tmp_path: Path) -> None:
    """gpu_type=='none' with gpu_count>0 is incoherent and rejected."""
    p = tmp_path / "incoherent2.json"
    p.write_text(
        json.dumps(
            {
                "cpu_cores": 8,
                "ram_gb": 32,
                "gpu_type": "none",
                "gpu_count": 4,  # incoherent
                "fleet_operator_pubkey_hex": "ab" * 32,
                "fleet_operator_signature_hex": "cd" * 64,
                "issued_ms": 1_700_000_000_000,
            }
        )
    )
    with pytest.raises(InvalidHardwareSpecError):
        HardwareSpec.load(str(p))


# --- supported gpu_type allowlist ----------------------------------------


@pytest.mark.parametrize(
    "gpu_type",
    [
        "none",
        "nvidia-h100",
        "nvidia-h200",
        "nvidia-b100",
        "nvidia-a100",
        "amd-mi300",
        "custom",
    ],
)
def test_load_accepts_all_documented_gpu_types(
    tmp_path: Path, gpu_type: str
) -> None:
    """All seven documented gpu_type values must round-trip."""
    p = tmp_path / f"{gpu_type}.json"
    p.write_text(
        json.dumps(
            {
                "cpu_cores": 8,
                "ram_gb": 32,
                "gpu_type": gpu_type,
                "gpu_count": 0 if gpu_type == "none" else 1,
                "fleet_operator_pubkey_hex": "ab" * 32,
                "fleet_operator_signature_hex": "cd" * 64,
                "issued_ms": 1_700_000_000_000,
            }
        )
    )
    spec = HardwareSpec.load(str(p))
    assert spec.gpu_type == gpu_type


# --- envelope-shape helper -----------------------------------------------


def test_to_envelope_dict_returns_cbor_friendly_shape() -> None:
    """The dict shape returned by to_envelope_dict must be exactly what goes
    into the v2 record's `hardware_spec` slot — bytes for pubkey/sig, ints
    for counts/issued_ms, str for gpu_type."""
    spec = _make_signed_spec()
    d = spec.to_envelope_dict()
    assert d["cpu_cores"] == spec.cpu_cores
    assert d["ram_gb"] == spec.ram_gb
    assert d["gpu_type"] == spec.gpu_type
    assert d["gpu_count"] == spec.gpu_count
    assert d["issued_ms"] == spec.issued_ms
    assert d["fleet_operator_pubkey"] == spec.fleet_operator_pubkey  # bytes
    assert d["fleet_operator_signature"] == spec.fleet_operator_signature  # bytes
    assert isinstance(d["fleet_operator_pubkey"], bytes)
    assert isinstance(d["fleet_operator_signature"], bytes)


def test_envelope_shape_matches_canonical_cbor_input() -> None:
    """The envelope dict, when fed into canonical_cbor_for_fleet_op_sig,
    produces the same bytes that were originally signed (= verify works)."""
    spec = _make_signed_spec()
    record = {
        "schema_version": "compute_metering_v2",
        "worker_id": _WORKER_ID,
        "hardware_spec": spec.to_envelope_dict(),
    }
    body = canonical_cbor_for_fleet_op_sig(record)
    fleet = _fleet_kp()
    assert fleet.verify_bytes(body, spec.fleet_operator_signature) is True

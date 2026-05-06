"""Tests for WorkerKeypair generation, persistence, and signing."""
from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from materios_compute_meter.exceptions import (
    InvalidKeyfileError,
    InvalidSeedError,
)
from materios_compute_meter.keypair import WorkerKeypair


def test_generate_returns_fresh_keypair() -> None:
    a = WorkerKeypair.generate()
    b = WorkerKeypair.generate()
    assert a.public_hex != b.public_hex
    assert a.ss58_address != b.ss58_address


def test_generate_keypair_has_32_byte_pubkey_and_64_byte_privkey() -> None:
    kp = WorkerKeypair.generate()
    assert len(bytes.fromhex(kp.public_hex)) == 32
    assert len(bytes.fromhex(kp.secret_hex)) == 64
    assert kp.ss58_address.startswith("5")  # Materios prefix-42 SS58


def test_from_seed_hex_is_deterministic() -> None:
    seed = "0x" + "11" * 32
    a = WorkerKeypair.from_seed_hex(seed)
    b = WorkerKeypair.from_seed_hex(seed)
    assert a.public_hex == b.public_hex
    assert a.ss58_address == b.ss58_address


def test_from_seed_hex_accepts_unprefixed() -> None:
    seed = "22" * 32
    kp = WorkerKeypair.from_seed_hex(seed)
    assert kp is not None
    assert len(bytes.fromhex(kp.public_hex)) == 32


def test_from_seed_hex_rejects_wrong_length() -> None:
    with pytest.raises(InvalidSeedError):
        WorkerKeypair.from_seed_hex("0xab")


def test_from_seed_hex_rejects_non_hex() -> None:
    with pytest.raises(InvalidSeedError):
        WorkerKeypair.from_seed_hex("zz" * 32)


def test_save_writes_json_with_mode_0600(tmp_path: Path) -> None:
    kp = WorkerKeypair.generate()
    p = tmp_path / "worker-key.json"
    kp.save(str(p))

    # File mode is 0600
    mode = os.stat(p).st_mode
    assert stat.S_IMODE(mode) == 0o600, f"expected 0600, got {oct(stat.S_IMODE(mode))}"

    blob = json.loads(p.read_text())
    assert blob["scheme"] == "sr25519"
    assert blob["public"] == kp.public_hex
    assert blob["secret"] == kp.secret_hex


def test_load_round_trips(tmp_path: Path) -> None:
    kp = WorkerKeypair.generate()
    p = tmp_path / "worker-key.json"
    kp.save(str(p))

    kp2 = WorkerKeypair.load(str(p))
    assert kp2.public_hex == kp.public_hex
    assert kp2.secret_hex == kp.secret_hex
    assert kp2.ss58_address == kp.ss58_address


def test_load_rejects_non_sr25519_scheme(tmp_path: Path) -> None:
    p = tmp_path / "bad.json"
    p.write_text(json.dumps({"scheme": "ed25519", "secret": "ab", "public": "cd"}))
    with pytest.raises(InvalidKeyfileError):
        WorkerKeypair.load(str(p))


def test_load_rejects_missing_fields(tmp_path: Path) -> None:
    p = tmp_path / "bad.json"
    p.write_text(json.dumps({"scheme": "sr25519"}))
    with pytest.raises(InvalidKeyfileError):
        WorkerKeypair.load(str(p))


def test_load_rejects_malformed_json(tmp_path: Path) -> None:
    p = tmp_path / "bad.json"
    p.write_text("not json")
    with pytest.raises(InvalidKeyfileError):
        WorkerKeypair.load(str(p))


def test_load_rejects_keyfile_with_mismatched_pub_secret(tmp_path: Path) -> None:
    """If someone has tampered with the keyfile and the stored public doesn't match
    the public derived from the secret, refuse to load."""
    kp = WorkerKeypair.generate()
    p = tmp_path / "tampered.json"
    p.write_text(
        json.dumps(
            {
                "scheme": "sr25519",
                "secret": kp.secret_hex,
                "public": "00" * 32,  # wrong
            }
        )
    )
    with pytest.raises(InvalidKeyfileError):
        WorkerKeypair.load(str(p))


def test_sign_round_trip_verifies() -> None:
    """Signing a payload and verifying with the same keypair must succeed."""
    kp = WorkerKeypair.generate()
    payload = b"hello materios"
    sig = kp.sign_bytes(payload)
    assert len(sig) == 64
    assert kp.verify_bytes(payload, sig) is True


def test_sign_does_not_verify_under_different_key() -> None:
    a = WorkerKeypair.generate()
    b = WorkerKeypair.generate()
    sig = a.sign_bytes(b"data")
    # b should NOT verify a's signature
    assert b.verify_bytes(b"data", sig) is False


def test_sign_does_not_verify_with_tampered_payload() -> None:
    kp = WorkerKeypair.generate()
    sig = kp.sign_bytes(b"original")
    assert kp.verify_bytes(b"tampered", sig) is False


def test_sign_record_returns_signed_envelope() -> None:
    """Signing a MeteringRecord should return a Signed[MeteringRecord] envelope
    containing the record + content_hash + signature + signer pubkey."""
    from materios_compute_meter.record import MeteringRecord

    kp = WorkerKeypair.generate()
    rec = MeteringRecord(
        worker_id="worker-001",
        tenant_id="tenant-acme",
        period_start_ms=1733400000000,
        period_end_ms=1733403600000,
        cpu_seconds=120.5,
        ram_gb_hours=0.42,
        disk_gb_hours=0.0,
        net_bytes_in=1024,
        net_bytes_out=512,
        gpu_seconds=0.0,
    )
    signed = kp.sign(rec)
    assert signed.record is rec
    assert len(signed.content_hash) == 64  # 32 bytes hex
    assert len(signed.signature) == 128  # 64 bytes hex
    assert signed.signer_public_hex == kp.public_hex
    # Verifying the signed envelope should succeed.
    assert signed.verify() is True


def test_signed_envelope_detects_tampered_record() -> None:
    """If you mutate the record after signing, the content_hash that was signed
    no longer matches the recomputed canonical digest, so verify() returns False."""
    from materios_compute_meter.record import MeteringRecord

    kp = WorkerKeypair.generate()
    rec = MeteringRecord(
        worker_id="worker-001",
        tenant_id="tenant-acme",
        period_start_ms=1,
        period_end_ms=2,
        cpu_seconds=1.0,
    )
    signed = kp.sign(rec)
    # Mutate the record under the signed envelope's nose.
    signed.record.cpu_seconds = 999.0
    assert signed.verify() is False

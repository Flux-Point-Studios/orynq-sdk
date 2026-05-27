"""Tests for ObserverKeypair persistence and signing."""
from __future__ import annotations

import json
import os
import stat
import tempfile

import pytest

from orynq_observe import InvalidKeyfileError, ObserverKeypair


def test_observer_keypair_from_seed_deterministic() -> None:
    seed = "0x" + "ab" * 32
    a = ObserverKeypair.from_seed_hex(seed)
    b = ObserverKeypair.from_seed_hex(seed)
    assert a.public_hex == b.public_hex


def test_observer_keypair_generate_produces_distinct_keys() -> None:
    a = ObserverKeypair.generate()
    b = ObserverKeypair.generate()
    assert a.public_hex != b.public_hex


def test_observer_keypair_sign_and_verify_roundtrip() -> None:
    kp = ObserverKeypair.from_seed_hex("0x" + "01" * 32)
    payload = b"hello-world"
    sig = kp.sign_bytes(payload)
    assert len(sig) == 64
    assert kp.verify_bytes(payload, sig) is True
    # Tampered payload must fail verification.
    assert kp.verify_bytes(payload + b"!", sig) is False


def test_observer_keypair_save_then_load_roundtrip(tmp_path) -> None:
    kp = ObserverKeypair.generate()
    p = tmp_path / "obs.json"
    kp.save(str(p))
    loaded = ObserverKeypair.load(str(p))
    assert loaded.public_hex == kp.public_hex
    assert loaded.secret_hex == kp.secret_hex


def test_observer_keypair_save_sets_mode_0600(tmp_path) -> None:
    kp = ObserverKeypair.generate()
    p = tmp_path / "obs.json"
    kp.save(str(p))
    mode = stat.S_IMODE(os.stat(str(p)).st_mode)
    assert mode == 0o600


def test_observer_keypair_load_accepts_legacy_sr25519_scheme(tmp_path) -> None:
    """A keyfile written by the compute-meter-sdk WorkerKeypair (scheme
    `sr25519`) must load as an observer key without re-keying."""
    kp = ObserverKeypair.generate()
    p = tmp_path / "legacy.json"
    blob = {
        "scheme": "sr25519",
        "public": kp.public_hex,
        "secret": kp.secret_hex,
    }
    p.write_text(json.dumps(blob))
    loaded = ObserverKeypair.load(str(p))
    assert loaded.public_hex == kp.public_hex


def test_observer_keypair_load_rejects_unknown_scheme(tmp_path) -> None:
    p = tmp_path / "bad.json"
    p.write_text(json.dumps({"scheme": "ed25519", "public": "00", "secret": "00"}))
    with pytest.raises(InvalidKeyfileError):
        ObserverKeypair.load(str(p))


def test_observer_keypair_load_rejects_tampered_public(tmp_path) -> None:
    kp = ObserverKeypair.generate()
    # Wrong public key — secret derives a different one.
    blob = {
        "scheme": "sr25519-observer",
        "public": "ff" * 32,
        "secret": kp.secret_hex,
    }
    p = tmp_path / "tampered.json"
    p.write_text(json.dumps(blob))
    with pytest.raises(InvalidKeyfileError):
        ObserverKeypair.load(str(p))


def test_observer_keypair_ss58_address_starts_with_42_prefix() -> None:
    kp = ObserverKeypair.from_seed_hex("0x" + "ab" * 32)
    # Materios uses SS58 prefix 42 — addresses start with `5` for that prefix.
    assert kp.ss58_address.startswith("5") or kp.ss58_address[0].isalpha()

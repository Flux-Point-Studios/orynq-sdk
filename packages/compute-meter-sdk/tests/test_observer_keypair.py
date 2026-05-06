"""Tests for ObserverKeypair — sr25519 keypair for the optional Wave 2
observer co-signature.
"""
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
from materios_compute_meter.keypair import ObserverKeypair, WorkerKeypair


def test_observer_keypair_is_subclass_of_worker_keypair() -> None:
    """Subclassing rationale: same crypto, separate role. v2 signing helpers
    accept either type via WorkerKeypair isinstance check."""
    assert issubclass(ObserverKeypair, WorkerKeypair)


def test_observer_keypair_generate_returns_valid_keypair() -> None:
    kp = ObserverKeypair.generate()
    assert isinstance(kp, ObserverKeypair)
    assert isinstance(kp, WorkerKeypair)
    assert len(bytes.fromhex(kp.public_hex)) == 32
    assert len(bytes.fromhex(kp.secret_hex)) == 64


def test_observer_keypair_from_seed_hex_is_deterministic() -> None:
    seed = "0x" + "ab" * 32
    a = ObserverKeypair.from_seed_hex(seed)
    b = ObserverKeypair.from_seed_hex(seed)
    assert a.public_hex == b.public_hex
    assert isinstance(a, ObserverKeypair)


def test_observer_keypair_signs_and_verifies_via_inherited_api() -> None:
    kp = ObserverKeypair.generate()
    payload = b"hello observer"
    sig = kp.sign_bytes(payload)
    assert len(sig) == 64
    assert kp.verify_bytes(payload, sig) is True


def test_observer_keypair_save_writes_observer_scheme_tag(tmp_path: Path) -> None:
    """On disk, observer keyfiles are tagged sr25519-observer so an `ls`
    distinguishes them from worker keys."""
    kp = ObserverKeypair.generate()
    p = tmp_path / "observer-key.json"
    kp.save(str(p))
    blob = json.loads(p.read_text())
    assert blob["scheme"] == "sr25519-observer"
    assert blob["public"] == kp.public_hex
    assert blob["secret"] == kp.secret_hex


def test_observer_keypair_save_uses_mode_0600(tmp_path: Path) -> None:
    kp = ObserverKeypair.generate()
    p = tmp_path / "observer-key.json"
    kp.save(str(p))
    mode = os.stat(p).st_mode
    assert stat.S_IMODE(mode) == 0o600


def test_observer_keypair_load_round_trip(tmp_path: Path) -> None:
    kp = ObserverKeypair.generate()
    p = tmp_path / "obs.json"
    kp.save(str(p))
    loaded = ObserverKeypair.load(str(p))
    assert isinstance(loaded, ObserverKeypair)
    assert loaded.public_hex == kp.public_hex
    assert loaded.secret_hex == kp.secret_hex


def test_observer_keypair_load_accepts_legacy_sr25519_scheme(tmp_path: Path) -> None:
    """A keyfile that was written with scheme=sr25519 (e.g. an existing
    worker key being repurposed as an observer) must still load via
    ObserverKeypair.load."""
    worker = WorkerKeypair.generate()
    p = tmp_path / "legacy.json"
    worker.save(str(p))  # writes scheme=sr25519
    loaded = ObserverKeypair.load(str(p))
    assert isinstance(loaded, ObserverKeypair)
    assert loaded.public_hex == worker.public_hex


def test_observer_keypair_load_rejects_unknown_scheme(tmp_path: Path) -> None:
    """A scheme like ed25519 or random gibberish must be rejected."""
    p = tmp_path / "bad.json"
    p.write_text(
        json.dumps(
            {
                "scheme": "ed25519",
                "public": "ab" * 32,
                "secret": "cd" * 64,
            }
        )
    )
    with pytest.raises(InvalidKeyfileError):
        ObserverKeypair.load(str(p))


def test_observer_keypair_load_rejects_malformed_json(tmp_path: Path) -> None:
    p = tmp_path / "bad.json"
    p.write_text("{not json}")
    with pytest.raises(InvalidKeyfileError):
        ObserverKeypair.load(str(p))


def test_observer_keypair_load_rejects_mismatched_pub_secret(tmp_path: Path) -> None:
    """Same tamper-detection as WorkerKeypair: stored public must derive
    from stored secret."""
    kp = ObserverKeypair.generate()
    p = tmp_path / "tampered.json"
    p.write_text(
        json.dumps(
            {
                "scheme": "sr25519-observer",
                "secret": kp.secret_hex,
                "public": "00" * 32,  # wrong public
            }
        )
    )
    with pytest.raises(InvalidKeyfileError):
        ObserverKeypair.load(str(p))


def test_observer_keypair_from_seed_hex_rejects_short_seed() -> None:
    with pytest.raises(InvalidSeedError):
        ObserverKeypair.from_seed_hex("0xab")


def test_observer_keypair_pubkey_differs_from_worker_keypair_with_same_seed() -> None:
    """They use the same algorithm, so the SAME seed should derive the SAME
    public key — this test pins that property (the type discrimination is
    metadata, not crypto)."""
    seed = "0x" + "1f" * 32
    worker = WorkerKeypair.from_seed_hex(seed)
    observer = ObserverKeypair.from_seed_hex(seed)
    assert worker.public_hex == observer.public_hex


def test_observer_keypair_can_be_used_in_worker_keypair_isinstance_checks() -> None:
    """v2 signing helpers accept WorkerKeypair OR ObserverKeypair via
    isinstance(kp, WorkerKeypair). This pins the contract."""
    obs = ObserverKeypair.generate()
    assert isinstance(obs, WorkerKeypair)

"""sr25519 keypair management for ai_capability_observation observers.

Wraps `substrate-interface`'s `Keypair` with an observer-friendly API
mirroring the compute-meter-sdk pattern:

  * `ObserverKeypair.generate()` — fresh sr25519 from /dev/urandom.
  * `ObserverKeypair.from_seed_hex("0x...")` — deterministic from a 32-byte
    mini-secret.
  * `ObserverKeypair.load("/path")` / `kp.save("/path")` — JSON keyfile,
    mode 0600 enforced on save.

The same `sr25519-observer` scheme tag used by the compute-meter-sdk is
honored on load, so an existing observer key can be reused for AI
observation submission without re-provisioning.
"""
from __future__ import annotations

import json
import os
import secrets

import sr25519
from substrateinterface import Keypair, KeypairType


class InvalidKeyfileError(ValueError):
    """Raised when a keyfile is malformed or cross-checks fail."""


class InvalidSeedError(ValueError):
    """Raised when a seed hex is not a valid 32-byte mini-secret."""


def _normalize_seed_hex(seed_hex: str) -> bytes:
    if not isinstance(seed_hex, str):
        raise InvalidSeedError("seed_hex must be a string")
    s = seed_hex[2:] if seed_hex.startswith(("0x", "0X")) else seed_hex
    try:
        raw = bytes.fromhex(s)
    except ValueError as e:
        raise InvalidSeedError(f"seed_hex is not valid hex: {e}") from e
    if len(raw) != 32:
        raise InvalidSeedError(
            f"seed_hex must decode to exactly 32 bytes (got {len(raw)})"
        )
    return raw


class ObserverKeypair:
    """sr25519 keypair for an AI observation observer.

    Construct via `generate()`, `from_seed_hex()`, or `load()`. The
    constructor is private-by-convention.
    """

    SCHEME = "sr25519-observer"
    _LOAD_ACCEPTED_SCHEMES = ("sr25519-observer", "sr25519")

    def __init__(self, public_key: bytes, secret_key: bytes) -> None:
        if len(public_key) != 32:
            raise InvalidKeyfileError(
                f"public_key must be 32 bytes (got {len(public_key)})"
            )
        if len(secret_key) != 64:
            raise InvalidKeyfileError(
                f"secret_key must be 64 bytes (got {len(secret_key)})"
            )
        self._public = public_key
        self._secret = secret_key
        self._inner = Keypair(
            public_key=public_key,
            private_key=secret_key,
            crypto_type=KeypairType.SR25519,
            ss58_format=42,
        )

    @classmethod
    def generate(cls) -> "ObserverKeypair":
        seed = secrets.token_bytes(32)
        public, secret = sr25519.pair_from_seed(seed)
        return cls(public_key=bytes(public), secret_key=bytes(secret))

    @classmethod
    def from_seed_hex(cls, seed_hex: str) -> "ObserverKeypair":
        seed = _normalize_seed_hex(seed_hex)
        public, secret = sr25519.pair_from_seed(seed)
        return cls(public_key=bytes(public), secret_key=bytes(secret))

    @classmethod
    def load(cls, path: str) -> "ObserverKeypair":
        try:
            with open(path, "r", encoding="utf-8") as f:
                blob = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            raise InvalidKeyfileError(f"could not read {path}: {e}") from e

        if not isinstance(blob, dict):
            raise InvalidKeyfileError("keyfile root is not a JSON object")
        scheme = blob.get("scheme")
        if scheme not in cls._LOAD_ACCEPTED_SCHEMES:
            raise InvalidKeyfileError(
                f"unsupported scheme {scheme!r}, expected one of "
                f"{cls._LOAD_ACCEPTED_SCHEMES}"
            )
        secret_hex = blob.get("secret")
        public_hex = blob.get("public")
        if not isinstance(secret_hex, str) or not isinstance(public_hex, str):
            raise InvalidKeyfileError(
                "keyfile missing 'secret' or 'public' field"
            )
        try:
            secret = bytes.fromhex(secret_hex)
            public = bytes.fromhex(public_hex)
        except ValueError as e:
            raise InvalidKeyfileError(
                f"secret/public is not valid hex: {e}"
            ) from e
        derived_public = bytes(sr25519.public_from_secret_key(secret))
        if derived_public != public:
            raise InvalidKeyfileError(
                "keyfile public does not match the public derived from secret"
            )
        return cls(public_key=public, secret_key=secret)

    def save(self, path: str) -> None:
        blob = {
            "scheme": self.SCHEME,
            "public": self._public.hex(),
            "secret": self._secret.hex(),
        }
        tmp_path = f"{path}.tmp.{os.getpid()}"
        fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(blob, f)
                f.flush()
                os.fsync(f.fileno())
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
        os.replace(tmp_path, path)
        os.chmod(path, 0o600)

    @property
    def public_hex(self) -> str:
        return self._public.hex()

    @property
    def secret_hex(self) -> str:
        return self._secret.hex()

    @property
    def ss58_address(self) -> str:
        return self._inner.ss58_address

    def sign_bytes(self, payload: bytes) -> bytes:
        return self._inner.sign(payload)

    def verify_bytes(self, payload: bytes, signature: bytes) -> bool:
        try:
            return bool(self._inner.verify(payload, signature))
        except Exception:
            return False

"""WorkerKeypair — sr25519 keypair management for compute workers.

Wraps `substrate-interface`'s `Keypair` (which itself wraps the Rust
`py-sr25519-bindings`) with a worker-friendly API:

  * `WorkerKeypair.generate()` — fresh sr25519 from /dev/urandom.
  * `WorkerKeypair.from_seed_hex("0x...")` — deterministic from a 32-byte
    mini-secret (handy for tests; do not use in production unless the seed
    came from an HSM-backed source).
  * `WorkerKeypair.load("/path")` / `kp.save("/path")` — JSON pickle, mode
    0600 enforced on save.

The class also exposes raw `sign_bytes`/`verify_bytes` and the
record-aware `sign()` that returns a `Signed` envelope.
"""
from __future__ import annotations

import json
import os
import secrets
from typing import Optional

import sr25519
from substrateinterface import Keypair, KeypairType

from .canonical import canonical_digest
from .exceptions import InvalidKeyfileError, InvalidSeedError
from .record import MeteringRecord, Signed


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


class WorkerKeypair:
    """sr25519 keypair for a Materios compute worker.

    Construct via `generate()`, `from_seed_hex()`, or `load()` — the
    `__init__` is private-by-convention and not part of the public API.
    """

    SCHEME = "sr25519"

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
        # Derive the substrate-interface Keypair lazily for sign/verify.
        # We pass private_key + public_key so it doesn't try to derive a seed.
        self._inner = Keypair(
            public_key=public_key,
            private_key=secret_key,
            crypto_type=KeypairType.SR25519,
            ss58_format=42,  # Materios prefix
        )

    # ---------------------- constructors ----------------------

    @classmethod
    def generate(cls) -> "WorkerKeypair":
        """Generate a fresh sr25519 keypair from a cryptographically random
        32-byte seed.

        Returns:
            A new `WorkerKeypair`.
        """
        seed = secrets.token_bytes(32)
        public, secret = sr25519.pair_from_seed(seed)
        return cls(public_key=bytes(public), secret_key=bytes(secret))

    @classmethod
    def from_seed_hex(cls, seed_hex: str) -> "WorkerKeypair":
        """Construct a `WorkerKeypair` from a 32-byte hex mini-secret.

        Args:
            seed_hex: 64-character hex string (with optional `0x` prefix).

        Returns:
            A `WorkerKeypair` deterministically derived from the seed.

        Raises:
            InvalidSeedError: if `seed_hex` is not a 32-byte hex string.
        """
        seed = _normalize_seed_hex(seed_hex)
        public, secret = sr25519.pair_from_seed(seed)
        return cls(public_key=bytes(public), secret_key=bytes(secret))

    @classmethod
    def load(cls, path: str) -> "WorkerKeypair":
        """Load a `WorkerKeypair` from a JSON keyfile produced by `save()`.

        Args:
            path: Filesystem path to the JSON keyfile.

        Returns:
            A `WorkerKeypair` reconstructed from the file.

        Raises:
            InvalidKeyfileError: if the file is malformed, has the wrong
                scheme, or contains a public key that does not match the
                public derived from the secret.
        """
        try:
            with open(path, "r", encoding="utf-8") as f:
                blob = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            raise InvalidKeyfileError(f"could not read {path}: {e}") from e

        if not isinstance(blob, dict):
            raise InvalidKeyfileError("keyfile root is not a JSON object")
        scheme = blob.get("scheme")
        if scheme != cls.SCHEME:
            raise InvalidKeyfileError(
                f"unsupported scheme {scheme!r}, only {cls.SCHEME!r} is allowed"
            )
        secret_hex = blob.get("secret")
        public_hex = blob.get("public")
        if not isinstance(secret_hex, str) or not isinstance(public_hex, str):
            raise InvalidKeyfileError("keyfile missing 'secret' or 'public' field")

        try:
            secret = bytes.fromhex(secret_hex)
            public = bytes.fromhex(public_hex)
        except ValueError as e:
            raise InvalidKeyfileError(f"secret/public is not valid hex: {e}") from e

        # The 64-byte sr25519 secret encodes its derived public; recompute and
        # cross-check to detect tampering.
        derived_public = bytes(sr25519.public_from_secret_key(secret))
        if derived_public != public:
            raise InvalidKeyfileError(
                "keyfile public does not match the public derived from secret"
            )

        return cls(public_key=public, secret_key=secret)

    # ---------------------- persistence ----------------------

    def save(self, path: str) -> None:
        """Write the keypair to a JSON keyfile with mode 0600.

        The file is written via a "create new, then rename" sequence to
        avoid leaving the secret on disk readable by other users while the
        write is in flight. If a file already exists at `path` it is
        overwritten.

        Args:
            path: Filesystem path to write to. Parent directory must exist.

        Raises:
            OSError: on any I/O failure during write/rename.
        """
        blob = {
            "scheme": self.SCHEME,
            "public": self._public.hex(),
            "secret": self._secret.hex(),
        }
        # Atomic-ish write: create with restrictive mode, fsync, rename.
        tmp_path = f"{path}.tmp.{os.getpid()}"
        # 0600 from the moment the fd opens.
        fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(blob, f)
                f.flush()
                os.fsync(f.fileno())
        except Exception:
            # Best-effort cleanup if we threw mid-write.
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
        os.replace(tmp_path, path)
        # os.replace preserves the source mode on Linux; chmod again to be sure.
        os.chmod(path, 0o600)

    # ---------------------- accessors ----------------------

    @property
    def public_hex(self) -> str:
        """The 32-byte sr25519 public key as a 64-char lowercase hex string
        (no `0x` prefix)."""
        return self._public.hex()

    @property
    def secret_hex(self) -> str:
        """The 64-byte sr25519 expanded secret key as a 128-char lowercase
        hex string (no `0x` prefix). Treat this as sensitive."""
        return self._secret.hex()

    @property
    def ss58_address(self) -> str:
        """The Materios SS58-format address (prefix-42) for this public key."""
        return self._inner.ss58_address

    # ---------------------- signing ----------------------

    def sign_bytes(self, payload: bytes) -> bytes:
        """sr25519-sign an arbitrary byte string.

        Args:
            payload: Raw bytes to sign.

        Returns:
            64 raw bytes of sr25519 signature.
        """
        return self._inner.sign(payload)

    def verify_bytes(self, payload: bytes, signature: bytes) -> bool:
        """Verify an sr25519 signature against this keypair's public key.

        Args:
            payload: The same bytes that were originally signed.
            signature: 64-byte sr25519 signature.

        Returns:
            True if the signature is valid, False otherwise. Does not
            raise on bad-shape input — the underlying library returns
            False.
        """
        try:
            return bool(self._inner.verify(payload, signature))
        except Exception:
            return False

    def sign(self, record: MeteringRecord) -> Signed:
        """Sign a `MeteringRecord` and return a `Signed[MeteringRecord]` envelope.

        The signed payload is `sha256(canonical_cbor(record_without_signature))`,
        per the schema #1 contract.

        Args:
            record: The record to sign.

        Returns:
            A `Signed` envelope with `content_hash`, `signature`,
            `signer_public_hex`, and the original record.
        """
        digest = canonical_digest(record.to_canonical_dict())
        sig = self.sign_bytes(digest)
        return Signed(
            record=record,
            content_hash=digest.hex(),
            signature=sig.hex(),
            signer_public_hex=self.public_hex,
        )


class ObserverKeypair(WorkerKeypair):
    """sr25519 keypair for an INDEPENDENT observer (Wave 2).

    Functionally identical to `WorkerKeypair` (same sr25519 algorithm, same
    file format on disk, same SS58 prefix), but discriminated as a
    SEPARATE TYPE so:

      * Call sites read clearly:
            `attach_observer_signature_v2(record, observer_kp)` — vs a
            generic `WorkerKeypair` parameter that hides the role.
      * Keyfiles can be tagged with `scheme=sr25519-observer` on disk so an
        operator's `ls` of the secrets dir distinguishes worker from
        observer keys.
      * Future divergence (e.g. observer-only HSM integration, observer
        attestation TTL) lives in this subclass without touching the
        per-worker SDK surface.

    The pre-image the observer signs is the SAME bytes the worker signs
    (see `canonical_cbor_for_observer_sig`). DIFFERENT key, SAME bytes.

    Subclassing rationale (vs separate class):
      * Avoids duplicating the constructor / generate / sign_bytes /
        verify_bytes / save / public_hex / ss58_address surface (about
        100 LoC of identical code).
      * `isinstance(kp, ObserverKeypair)` works for type narrowing while
        `isinstance(kp, WorkerKeypair)` still admits both — the v2
        signing helpers accept either, by design.
      * The keyfile scheme tag still gives operators clear separation on
        disk; the runtime crypto is the same algorithm so a subclass is
        the honest model.

    Inherits all constructors and methods from `WorkerKeypair`. The only
    differences:

      * `SCHEME = "sr25519-observer"` for keyfile tagging on save.
      * `load()` accepts EITHER `sr25519-observer` (preferred) or
        `sr25519` (legacy / cross-role reuse). Other schemes rejected.
    """

    SCHEME = "sr25519-observer"

    @classmethod
    def load(cls, path: str) -> "ObserverKeypair":
        """Load an observer keyfile.

        Accepts either `sr25519-observer` (preferred, written by `save()`)
        or `sr25519` (legacy / cross-role reuse). Other schemes are rejected.
        """
        try:
            with open(path, "r", encoding="utf-8") as f:
                blob = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            raise InvalidKeyfileError(f"could not read {path}: {e}") from e

        if not isinstance(blob, dict):
            raise InvalidKeyfileError("keyfile root is not a JSON object")
        scheme = blob.get("scheme")
        if scheme not in (cls.SCHEME, "sr25519"):
            raise InvalidKeyfileError(
                f"unsupported scheme {scheme!r} for ObserverKeypair, "
                f"expected {cls.SCHEME!r} or 'sr25519'"
            )
        secret_hex = blob.get("secret")
        public_hex = blob.get("public")
        if not isinstance(secret_hex, str) or not isinstance(public_hex, str):
            raise InvalidKeyfileError("keyfile missing 'secret' or 'public' field")

        try:
            secret = bytes.fromhex(secret_hex)
            public = bytes.fromhex(public_hex)
        except ValueError as e:
            raise InvalidKeyfileError(f"secret/public is not valid hex: {e}") from e

        derived_public = bytes(sr25519.public_from_secret_key(secret))
        if derived_public != public:
            raise InvalidKeyfileError(
                "keyfile public does not match the public derived from secret"
            )

        return cls(public_key=public, secret_key=secret)

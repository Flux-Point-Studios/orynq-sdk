"""HardwareSpec — FPS-fleet-operator-attested hardware binding for a worker.

In v2 (`compute_metering_v2`), a worker can no longer self-attest its
hardware: a `hardware_spec` block, signed by an FPS-registered fleet
operator, must be embedded in every record. The fleet-operator signature
is computed offline (or by an FPS-internal service) and the resulting
JSON is what the worker SDK loads from disk.

Wire shape inside the v2 envelope (see canonical.py):

    {
        "cpu_cores": int,
        "ram_gb": int,
        "gpu_type": str,        # "none" | "nvidia-h100" | ... | "custom"
        "gpu_count": int,
        "fleet_operator_pubkey": bytes(32),
        "fleet_operator_signature": bytes(64),
        "issued_ms": int,
    }

On-disk JSON shape (the file the FPS offline-signing tool produces):

    {
        "cpu_cores": 8,
        "ram_gb": 32,
        "gpu_type": "none",
        "gpu_count": 0,
        "fleet_operator_pubkey_hex":     "<64 hex chars>",
        "fleet_operator_signature_hex":  "<128 hex chars>",
        "issued_ms": 1700000000000
    }

`HardwareSpec.load(path)` decodes the JSON, validates structure + value
domains, and returns a frozen dataclass with bytes-typed pubkey / sig.
`spec.verify(worker_id)` recomputes the canonical fleet-op pre-image and
sr25519-verifies the signature; returns True/False, logs the failure
reason on False (no exception — verify is for control-flow).
`sign_hardware_spec(...)` is the inverse: produces a signed spec from a
fleet operator's `WorkerKeypair`. Used by the FPS internal signing tool
(and by tests).
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, FrozenSet, Optional

from .canonical import (
    SCHEMA_VERSION_V2,
    canonical_cbor_for_fleet_op_sig,
)
from .exceptions import InvalidHardwareSpecError
from .keypair import WorkerKeypair

_LOG = logging.getLogger(__name__)


#: Allowlisted gpu_type strings. Anything else is rejected at load time.
SUPPORTED_GPU_TYPES: FrozenSet[str] = frozenset(
    {
        "none",
        "nvidia-h100",
        "nvidia-h200",
        "nvidia-b100",
        "nvidia-a100",
        "amd-mi300",
        "custom",
    }
)


@dataclass(frozen=True)
class HardwareSpec:
    """Immutable hardware-spec record signed by an FPS fleet operator.

    Attributes:
        cpu_cores: CPU cores available to this worker. >0.
        ram_gb: RAM in GB. >0.
        gpu_type: One of `SUPPORTED_GPU_TYPES`.
        gpu_count: Number of GPUs of `gpu_type`. >=0. Must be 0 iff
            `gpu_type == "none"`; must be >0 otherwise (incoherent specs
            are rejected at load time).
        fleet_operator_pubkey: 32 raw bytes — sr25519 public key of the
            FPS fleet operator that issued this attestation.
        fleet_operator_signature: 64 raw bytes — sr25519 signature over
            the canonical fleet-op pre-image (worker_id-bound, see
            `canonical_cbor_for_fleet_op_sig`).
        issued_ms: UNIX epoch milliseconds at which the operator signed.
            Workers / gateway may reject a too-old spec; the SDK does not
            enforce a TTL itself.
    """

    cpu_cores: int
    ram_gb: int
    gpu_type: str
    gpu_count: int
    fleet_operator_pubkey: bytes
    fleet_operator_signature: bytes
    issued_ms: int

    def __post_init__(self) -> None:
        if not isinstance(self.cpu_cores, int) or isinstance(self.cpu_cores, bool):
            raise InvalidHardwareSpecError(
                f"cpu_cores must be int, got {type(self.cpu_cores).__name__}"
            )
        if self.cpu_cores <= 0:
            raise InvalidHardwareSpecError(
                f"cpu_cores must be > 0, got {self.cpu_cores}"
            )
        if not isinstance(self.ram_gb, int) or isinstance(self.ram_gb, bool):
            raise InvalidHardwareSpecError(
                f"ram_gb must be int, got {type(self.ram_gb).__name__}"
            )
        if self.ram_gb <= 0:
            raise InvalidHardwareSpecError(
                f"ram_gb must be > 0, got {self.ram_gb}"
            )
        if not isinstance(self.gpu_type, str):
            raise InvalidHardwareSpecError(
                f"gpu_type must be str, got {type(self.gpu_type).__name__}"
            )
        if self.gpu_type not in SUPPORTED_GPU_TYPES:
            raise InvalidHardwareSpecError(
                f"gpu_type {self.gpu_type!r} is not in the supported set "
                f"{sorted(SUPPORTED_GPU_TYPES)}"
            )
        if not isinstance(self.gpu_count, int) or isinstance(self.gpu_count, bool):
            raise InvalidHardwareSpecError(
                f"gpu_count must be int, got {type(self.gpu_count).__name__}"
            )
        if self.gpu_count < 0:
            raise InvalidHardwareSpecError(
                f"gpu_count must be >= 0, got {self.gpu_count}"
            )
        # Coherence: gpu_type=="none" iff gpu_count==0.
        if self.gpu_type == "none" and self.gpu_count != 0:
            raise InvalidHardwareSpecError(
                f"gpu_type='none' but gpu_count={self.gpu_count}; mutually "
                "exclusive — set gpu_count=0 or pick a real gpu_type"
            )
        if self.gpu_type != "none" and self.gpu_count == 0:
            raise InvalidHardwareSpecError(
                f"gpu_type={self.gpu_type!r} but gpu_count=0; incoherent — "
                "either set gpu_type='none' or gpu_count>=1"
            )
        if not isinstance(self.fleet_operator_pubkey, (bytes, bytearray)):
            raise InvalidHardwareSpecError(
                "fleet_operator_pubkey must be bytes, got "
                f"{type(self.fleet_operator_pubkey).__name__}"
            )
        if len(self.fleet_operator_pubkey) != 32:
            raise InvalidHardwareSpecError(
                "fleet_operator_pubkey must be exactly 32 bytes, got "
                f"{len(self.fleet_operator_pubkey)}"
            )
        if not isinstance(self.fleet_operator_signature, (bytes, bytearray)):
            raise InvalidHardwareSpecError(
                "fleet_operator_signature must be bytes, got "
                f"{type(self.fleet_operator_signature).__name__}"
            )
        if len(self.fleet_operator_signature) != 64:
            raise InvalidHardwareSpecError(
                "fleet_operator_signature must be exactly 64 bytes, got "
                f"{len(self.fleet_operator_signature)}"
            )
        if not isinstance(self.issued_ms, int) or isinstance(self.issued_ms, bool):
            raise InvalidHardwareSpecError(
                f"issued_ms must be int, got {type(self.issued_ms).__name__}"
            )
        if self.issued_ms <= 0:
            raise InvalidHardwareSpecError(
                f"issued_ms must be > 0, got {self.issued_ms}"
            )
        # Frozen dataclass + bytearray would be a foot-gun for hashing; coerce.
        if isinstance(self.fleet_operator_pubkey, bytearray):
            object.__setattr__(
                self,
                "fleet_operator_pubkey",
                bytes(self.fleet_operator_pubkey),
            )
        if isinstance(self.fleet_operator_signature, bytearray):
            object.__setattr__(
                self,
                "fleet_operator_signature",
                bytes(self.fleet_operator_signature),
            )

    # ----------------------- on-disk format ------------------------------

    @classmethod
    def load(cls, path: str) -> "HardwareSpec":
        """Read a hardware-spec JSON file produced by FPS's offline signing
        tool and return a validated `HardwareSpec`.

        Args:
            path: Filesystem path to the JSON file.

        Returns:
            A validated, immutable `HardwareSpec`.

        Raises:
            InvalidHardwareSpecError: on any structural problem (missing
                fields, wrong type, malformed hex, out-of-range value).
        """
        try:
            with open(path, "r", encoding="utf-8") as f:
                blob: Any = json.load(f)
        except FileNotFoundError as e:
            raise InvalidHardwareSpecError(
                f"hardware-spec file not found: {path}"
            ) from e
        except (OSError, json.JSONDecodeError) as e:
            raise InvalidHardwareSpecError(
                f"could not read hardware-spec JSON at {path}: {e}"
            ) from e

        if not isinstance(blob, dict):
            raise InvalidHardwareSpecError(
                f"hardware-spec root must be a JSON object, got {type(blob).__name__}"
            )

        required = {
            "cpu_cores",
            "ram_gb",
            "gpu_type",
            "gpu_count",
            "fleet_operator_pubkey_hex",
            "fleet_operator_signature_hex",
            "issued_ms",
        }
        missing = required - blob.keys()
        if missing:
            raise InvalidHardwareSpecError(
                f"hardware-spec missing required fields: {sorted(missing)}"
            )

        try:
            pubkey = bytes.fromhex(blob["fleet_operator_pubkey_hex"])
        except (TypeError, ValueError) as e:
            raise InvalidHardwareSpecError(
                f"fleet_operator_pubkey_hex is not valid hex: {e}"
            ) from e
        try:
            sig = bytes.fromhex(blob["fleet_operator_signature_hex"])
        except (TypeError, ValueError) as e:
            raise InvalidHardwareSpecError(
                f"fleet_operator_signature_hex is not valid hex: {e}"
            ) from e

        # __post_init__ runs the rest of the checks (length, gpu coherence,
        # int domain, gpu_type allowlist).
        return cls(
            cpu_cores=blob["cpu_cores"],
            ram_gb=blob["ram_gb"],
            gpu_type=blob["gpu_type"],
            gpu_count=blob["gpu_count"],
            fleet_operator_pubkey=pubkey,
            fleet_operator_signature=sig,
            issued_ms=blob["issued_ms"],
        )

    def save(self, path: str) -> None:
        """Write this spec to disk in the FPS hex-on-the-wire JSON shape.

        Args:
            path: Filesystem path to write to. Parent directory must exist.
                The file is written in JSON (UTF-8) with hex-encoded
                pubkey/signature for human-inspectability.
        """
        blob = self.to_disk_dict()
        with open(path, "w", encoding="utf-8") as f:
            json.dump(blob, f, indent=2, sort_keys=True)

    def to_disk_dict(self) -> Dict[str, Any]:
        """Return the on-disk JSON shape (hex-encoded pubkey / sig)."""
        return {
            "cpu_cores": self.cpu_cores,
            "ram_gb": self.ram_gb,
            "gpu_type": self.gpu_type,
            "gpu_count": self.gpu_count,
            "fleet_operator_pubkey_hex": self.fleet_operator_pubkey.hex(),
            "fleet_operator_signature_hex": self.fleet_operator_signature.hex(),
            "issued_ms": self.issued_ms,
        }

    # ----------------------- envelope shape ------------------------------

    def to_envelope_dict(self) -> Dict[str, Any]:
        """Return the wire-shape dict (bytes for pubkey/sig) for embedding
        in a v2 envelope's `hardware_spec` slot.

        This is what `record_v2.build_record_v2(...)` puts into the envelope
        and what `canonical_cbor_for_*_sig` consumes.
        """
        return {
            "cpu_cores": self.cpu_cores,
            "ram_gb": self.ram_gb,
            "gpu_type": self.gpu_type,
            "gpu_count": self.gpu_count,
            "fleet_operator_pubkey": self.fleet_operator_pubkey,
            "fleet_operator_signature": self.fleet_operator_signature,
            "issued_ms": self.issued_ms,
        }

    # ----------------------- verify --------------------------------------

    def verify(self, worker_id: str) -> bool:
        """Verify the embedded `fleet_operator_signature` against the
        canonical fleet-op pre-image bound to `worker_id`.

        Args:
            worker_id: The worker_id this spec is supposed to attest to.

        Returns:
            True iff the signature is valid for (worker_id, this spec).
            False (NEVER raises) on any mismatch — wrong worker_id, wrong
            pubkey, tampered fields, malformed sig. The reason is logged at
            WARNING level for operator visibility.
        """
        if not isinstance(worker_id, str) or not worker_id:
            _LOG.warning(
                "HardwareSpec.verify: worker_id must be a non-empty string"
            )
            return False
        record = {
            "schema_version": SCHEMA_VERSION_V2,
            "worker_id": worker_id,
            "hardware_spec": self.to_envelope_dict(),
        }
        try:
            body = canonical_cbor_for_fleet_op_sig(record)
        except (TypeError, KeyError) as e:
            _LOG.warning(
                "HardwareSpec.verify: failed to encode pre-image: %s", e
            )
            return False

        # Use a substrate-interface Keypair to verify (no secret needed).
        try:
            from substrateinterface import Keypair, KeypairType

            verifier = Keypair(
                public_key=self.fleet_operator_pubkey,
                crypto_type=KeypairType.SR25519,
                ss58_format=42,
            )
            ok = bool(verifier.verify(body, self.fleet_operator_signature))
        except Exception as e:  # pragma: no cover - defensive
            _LOG.warning(
                "HardwareSpec.verify: sr25519 verifier raised: %s", e
            )
            return False

        if not ok:
            _LOG.warning(
                "HardwareSpec.verify: signature does not verify for "
                "worker_id=%r under fleet_operator_pubkey=%s...",
                worker_id,
                self.fleet_operator_pubkey.hex()[:16],
            )
        return ok


def sign_hardware_spec(
    *,
    worker_id: str,
    cpu_cores: int,
    ram_gb: int,
    gpu_type: str,
    gpu_count: int,
    issued_ms: int,
    fleet_operator_keypair: WorkerKeypair,
) -> HardwareSpec:
    """Issue a fleet-operator-signed `HardwareSpec` for a worker.

    Used by FPS's offline-signing tool (and by tests). Production fleet
    operators run this on an air-gapped machine with the operator key
    loaded from an HSM; the SDK ships only the verify path by default.

    Args:
        worker_id: The worker the attestation is bound to.
        cpu_cores: See `HardwareSpec`.
        ram_gb: See `HardwareSpec`.
        gpu_type: See `HardwareSpec`.
        gpu_count: See `HardwareSpec`.
        issued_ms: UNIX epoch ms. Use `time.time_ns() // 1_000_000` typically.
        fleet_operator_keypair: The fleet operator's `WorkerKeypair`.
            (We reuse `WorkerKeypair` because both ends are sr25519 and the
            class already has the right shape; semantically this is a
            distinct role — the operator is NOT a worker.)

    Returns:
        A signed `HardwareSpec` ready to drop into a v2 envelope.

    Raises:
        InvalidHardwareSpecError: on value-domain violation (passed
            through from `HardwareSpec.__post_init__`).
    """
    if not isinstance(worker_id, str) or not worker_id:
        raise InvalidHardwareSpecError("worker_id must be a non-empty string")
    if not isinstance(fleet_operator_keypair, WorkerKeypair):
        raise InvalidHardwareSpecError(
            "fleet_operator_keypair must be a WorkerKeypair instance"
        )

    pubkey = bytes.fromhex(fleet_operator_keypair.public_hex)
    # Build the unsigned envelope-shape dict so we can hash + sign it.
    unsigned_envelope = {
        "cpu_cores": cpu_cores,
        "ram_gb": ram_gb,
        "gpu_type": gpu_type,
        "gpu_count": gpu_count,
        "fleet_operator_pubkey": pubkey,
        "issued_ms": issued_ms,
    }
    pre_image_record = {
        "schema_version": SCHEMA_VERSION_V2,
        "worker_id": worker_id,
        "hardware_spec": unsigned_envelope,
    }
    body = canonical_cbor_for_fleet_op_sig(pre_image_record)
    signature = fleet_operator_keypair.sign_bytes(body)
    return HardwareSpec(
        cpu_cores=cpu_cores,
        ram_gb=ram_gb,
        gpu_type=gpu_type,
        gpu_count=gpu_count,
        fleet_operator_pubkey=pubkey,
        fleet_operator_signature=signature,
        issued_ms=issued_ms,
    )

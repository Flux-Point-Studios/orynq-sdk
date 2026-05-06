"""MeteringRecord — a single billable usage interval for a compute worker.

The record is the input to the SDK's signing flow. Field names are coupled
to schema #1 (Agent #1 owns the canonical schema). If #1 ships with renames,
patch this module's `to_canonical_dict()` keys; nothing else in the SDK
depends on the exact names.

Validation runs in `__post_init__`. We refuse:
  * empty `worker_id` or `tenant_id`
  * `period_end_ms <= period_start_ms`
  * any negative resource counter

Replay protection is enforced in `submit()` (per-worker monotonic
`period_start_ms`), not here — a record by itself is just data.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict

from .exceptions import InvalidRecordError


@dataclass
class MeteringRecord:
    """A billable usage interval for a single compute worker.

    Attributes:
        worker_id: Stable string identifier for the worker (e.g. K8s pod
            name, VM hostname). Non-empty.
        tenant_id: Identifier of the tenant whose workload generated this
            usage. Non-empty.
        period_start_ms: UNIX-epoch milliseconds at which the usage interval
            begins. Inclusive.
        period_end_ms: UNIX-epoch milliseconds at which the usage interval
            ends. Strictly greater than `period_start_ms`.
        cpu_seconds: CPU-seconds consumed in the interval. >= 0.
        ram_gb_hours: GB-hours of RAM consumed in the interval. >= 0.
        disk_gb_hours: GB-hours of disk consumed. >= 0.
        net_bytes_in: Bytes of inbound network traffic. >= 0 integer.
        net_bytes_out: Bytes of outbound network traffic. >= 0 integer.
        gpu_seconds: GPU-seconds consumed. >= 0. Default 0 for non-GPU
            workloads.
    """

    worker_id: str
    tenant_id: str
    period_start_ms: int
    period_end_ms: int
    cpu_seconds: float
    ram_gb_hours: float = 0.0
    disk_gb_hours: float = 0.0
    net_bytes_in: int = 0
    net_bytes_out: int = 0
    gpu_seconds: float = 0.0

    def __post_init__(self) -> None:
        if not isinstance(self.worker_id, str) or not self.worker_id:
            raise InvalidRecordError("worker_id must be a non-empty string")
        if not isinstance(self.tenant_id, str) or not self.tenant_id:
            raise InvalidRecordError("tenant_id must be a non-empty string")
        if not isinstance(self.period_start_ms, int) or self.period_start_ms < 0:
            raise InvalidRecordError("period_start_ms must be a non-negative int")
        if not isinstance(self.period_end_ms, int):
            raise InvalidRecordError("period_end_ms must be an int")
        if self.period_end_ms <= self.period_start_ms:
            raise InvalidRecordError(
                "period_end_ms must be strictly greater than period_start_ms"
            )

        for fname in ("cpu_seconds", "ram_gb_hours", "disk_gb_hours", "gpu_seconds"):
            v = getattr(self, fname)
            if not isinstance(v, (int, float)) or v < 0:
                raise InvalidRecordError(
                    f"{fname} must be a non-negative number (got {v!r})"
                )
            # Normalize ints to float for stable canonical form.
            setattr(self, fname, float(v))

        for fname in ("net_bytes_in", "net_bytes_out"):
            v = getattr(self, fname)
            if not isinstance(v, int) or v < 0:
                raise InvalidRecordError(
                    f"{fname} must be a non-negative int (got {v!r})"
                )

    def to_canonical_dict(self) -> Dict[str, Any]:
        """Return a sorted-key dict suitable for canonical CBOR serialization.

        The returned dict deliberately excludes any signature, content_hash,
        or signer_public field — those live in the wrapping `Signed`
        envelope, never in the signed payload.
        """
        return {
            "cpu_seconds": self.cpu_seconds,
            "disk_gb_hours": self.disk_gb_hours,
            "gpu_seconds": self.gpu_seconds,
            "net_bytes_in": self.net_bytes_in,
            "net_bytes_out": self.net_bytes_out,
            "period_end_ms": self.period_end_ms,
            "period_start_ms": self.period_start_ms,
            "ram_gb_hours": self.ram_gb_hours,
            "tenant_id": self.tenant_id,
            "worker_id": self.worker_id,
        }


@dataclass
class Signed:
    """A `MeteringRecord` plus its sr25519 signature and signer public key.

    `verify()` recomputes the canonical digest from `record` and checks the
    signature; mutating the record after signing causes verify() to return
    False.
    """

    record: MeteringRecord
    content_hash: str  # 64 hex chars (sha256 of canonical CBOR)
    signature: str  # 128 hex chars (64-byte sr25519 signature)
    signer_public_hex: str  # 64 hex chars (32-byte sr25519 public key)
    scheme: str = field(default="sr25519")

    def verify(self) -> bool:
        """Recompute the canonical digest and verify the signature against
        `signer_public_hex`. Returns True on match, False otherwise."""
        # Local import keeps `record` module independent of substrate-interface
        # so callers can serialize records without paying that import cost.
        from substrateinterface import Keypair, KeypairType

        from .canonical import canonical_digest

        digest = canonical_digest(self.record.to_canonical_dict())
        if digest.hex() != self.content_hash:
            return False

        try:
            verifier = Keypair(
                public_key=bytes.fromhex(self.signer_public_hex),
                crypto_type=KeypairType.SR25519,
                ss58_format=42,
            )
            return bool(verifier.verify(digest, bytes.fromhex(self.signature)))
        except Exception:
            return False

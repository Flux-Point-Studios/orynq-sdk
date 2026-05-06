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

v2 (compute_metering_v2):
  * `build_record_v2(...)` — new top-level builder, accepts hardware_spec.
  * `sign_record_v2(record_body, worker_keypair)` — seals worker_signature.
  * `attach_observer_signature_v2(record, observer_keypair)` — bolts on
    the optional observer co-signature.
  * `verify_record_v2(record)` — validates worker (+ optional observer)
    signatures. Does NOT validate the fleet_operator_signature inside
    hardware_spec — call `HardwareSpec.verify(worker_id)` for that.
  * `next_period_start_ms(last_seen_ms)` — caller-side monotonic helper.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional

from .exceptions import InvalidRecordError, InvalidV2RecordError


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


# ---------------------------------------------------------------------------
# v2 record builders / signers
# ---------------------------------------------------------------------------
#
# v2 envelopes are richer than v1: nested `metrics`, mandatory `hardware_spec`
# (signed by FPS fleet operator), optional `observer` co-signature. We model
# them as plain dicts (not dataclasses) because the wire shape includes
# nested mappings and the canonical encoder operates on dicts directly. A
# dataclass would force a separate `to_dict()` step and extra serialisation
# rules; for an immutable, signed envelope, the simpler primitive shape wins.

# Period upper bound (24 h), pinned to v1 / v2 schema.
_MAX_PERIOD_MS = 86_400_000

# Required keys in the `metrics` sub-object. Matches the v2 spec exactly.
_REQUIRED_METRIC_KEYS = (
    "cpu_seconds",
    "ram_gb_hours",
    "disk_gb_hours",
    "net_bytes_in",
    "net_bytes_out",
    "gpu_seconds",
)

# Per-key type constraint: True == "must be int (not float, not bool)".
# False == "may be int or float (non-bool, finite, >= 0)".
_METRIC_INT_ONLY = {
    "cpu_seconds": True,
    "ram_gb_hours": False,
    "disk_gb_hours": False,
    "net_bytes_in": True,
    "net_bytes_out": True,
    "gpu_seconds": True,
}

# Regex enforced for tenant_id per the v2 spec.
_TENANT_ID_PATTERN = re.compile(r"^[a-z0-9-]{4,64}$")


def _validate_metrics(metrics: Mapping[str, Any]) -> Dict[str, Any]:
    """Normalise + validate the metrics sub-dict. Returns a fresh sorted-key
    dict with floats coerced for stable canonical form."""
    if not isinstance(metrics, Mapping):
        raise InvalidV2RecordError(
            f"metrics must be a mapping, got {type(metrics).__name__}"
        )
    missing = [k for k in _REQUIRED_METRIC_KEYS if k not in metrics]
    if missing:
        raise InvalidV2RecordError(
            f"metrics missing required keys: {missing}"
        )
    extra = [k for k in metrics if k not in _REQUIRED_METRIC_KEYS]
    if extra:
        raise InvalidV2RecordError(
            f"metrics has unexpected keys: {extra}"
        )
    out: Dict[str, Any] = {}
    for k in _REQUIRED_METRIC_KEYS:
        v = metrics[k]
        if isinstance(v, bool):
            raise InvalidV2RecordError(
                f"metrics[{k!r}] must be a number, got bool"
            )
        if not isinstance(v, (int, float)):
            raise InvalidV2RecordError(
                f"metrics[{k!r}] must be int/float, got {type(v).__name__}"
            )
        # Reject NaN/Inf.
        if isinstance(v, float):
            import math

            if not math.isfinite(v):
                raise InvalidV2RecordError(
                    f"metrics[{k!r}] must be finite, got {v}"
                )
        if v < 0:
            raise InvalidV2RecordError(
                f"metrics[{k!r}] must be >= 0, got {v}"
            )
        if _METRIC_INT_ONLY[k]:
            if not isinstance(v, int):
                raise InvalidV2RecordError(
                    f"metrics[{k!r}] must be an int, got {type(v).__name__}"
                )
            out[k] = int(v)
        else:
            # Coerce ints to float for stable canonical form across dicts.
            out[k] = float(v)
    return out


def _validate_worker_id_v2(worker_id: str) -> None:
    """Per the v2 spec: 1-128 chars, UTF-8, no spaces, no commas."""
    if not isinstance(worker_id, str):
        raise InvalidV2RecordError(
            f"worker_id must be str, got {type(worker_id).__name__}"
        )
    if not (1 <= len(worker_id) <= 128):
        raise InvalidV2RecordError(
            f"worker_id length must be 1..128, got {len(worker_id)}"
        )
    if " " in worker_id or "," in worker_id:
        raise InvalidV2RecordError(
            "worker_id must not contain spaces or commas"
        )
    # UTF-8 well-formedness — Python 3 str is always Unicode; the only way
    # this fails is unpaired surrogates, which can't be encoded.
    try:
        worker_id.encode("utf-8")
    except UnicodeEncodeError as e:
        raise InvalidV2RecordError(
            f"worker_id is not UTF-8 encodable: {e}"
        ) from e


def _validate_tenant_id_v2(tenant_id: str) -> None:
    if not isinstance(tenant_id, str):
        raise InvalidV2RecordError(
            f"tenant_id must be str, got {type(tenant_id).__name__}"
        )
    if not _TENANT_ID_PATTERN.match(tenant_id):
        raise InvalidV2RecordError(
            f"tenant_id {tenant_id!r} must match [a-z0-9-]{{4,64}}"
        )


def _validate_period_v2(period_start_ms: int, period_end_ms: int) -> None:
    for name, val in (
        ("period_start_ms", period_start_ms),
        ("period_end_ms", period_end_ms),
    ):
        if not isinstance(val, int) or isinstance(val, bool):
            raise InvalidV2RecordError(
                f"{name} must be int, got {type(val).__name__}"
            )
        if val < 0:
            raise InvalidV2RecordError(
                f"{name} must be >= 0, got {val}"
            )
    if period_end_ms <= period_start_ms:
        raise InvalidV2RecordError(
            f"period_end_ms ({period_end_ms}) must be > period_start_ms "
            f"({period_start_ms})"
        )
    if period_end_ms - period_start_ms > _MAX_PERIOD_MS:
        raise InvalidV2RecordError(
            f"period (period_end_ms - period_start_ms) must be <= "
            f"{_MAX_PERIOD_MS} ms (24 h), got {period_end_ms - period_start_ms}"
        )


def build_record_v2(
    *,
    worker_id: str,
    tenant_id: str,
    period_start_ms: int,
    period_end_ms: int,
    metrics: Mapping[str, Any],
    hardware_spec: Any,
    worker_pubkey: Optional[bytes] = None,
) -> Dict[str, Any]:
    """Build a v2 record body (everything signable except `worker_signature`
    and `observer`).

    The returned dict is suitable for `sign_record_v2(...)` immediately.
    `worker_pubkey` is optional here because the same dict is sometimes built
    BEFORE the signing keypair is available (e.g. in offline batching).
    `sign_record_v2` will overwrite this field with the signing key's pubkey.

    Args:
        worker_id: 1-128 UTF-8 chars, no spaces, no commas.
        tenant_id: lowercase / digit / hyphen, 4-64 chars.
        period_start_ms: UNIX-epoch ms, monotonic per worker_id (caller's
            responsibility — see `next_period_start_ms` helper for callers
            that want SDK-side enforcement).
        period_end_ms: UNIX-epoch ms, > period_start_ms,
            ≤ period_start_ms + 86_400_000.
        metrics: dict with keys cpu_seconds, ram_gb_hours, disk_gb_hours,
            net_bytes_in, net_bytes_out, gpu_seconds (per-key int/float
            domain enforced).
        hardware_spec: a `HardwareSpec` instance OR its envelope dict.
        worker_pubkey: 32 raw bytes. Optional; populated by `sign_record_v2`.

    Returns:
        A dict ready for `sign_record_v2`.

    Raises:
        InvalidV2RecordError: any value-domain violation.
    """
    _validate_worker_id_v2(worker_id)
    _validate_tenant_id_v2(tenant_id)
    _validate_period_v2(period_start_ms, period_end_ms)
    norm_metrics = _validate_metrics(metrics)

    # hardware_spec accepts either the dataclass or its dict shape.
    hw_dict: Dict[str, Any]
    # Local import — avoid circular at module load (hardware_spec already
    # imports keypair which transitively imports record indirectly via
    # the package __init__). Resolved at call-time.
    from .hardware_spec import HardwareSpec

    if isinstance(hardware_spec, HardwareSpec):
        hw_dict = hardware_spec.to_envelope_dict()
    elif isinstance(hardware_spec, Mapping):
        # Trust the caller (we don't re-validate keys here — that's the
        # responsibility of HardwareSpec.load if loaded from disk).
        hw_dict = dict(hardware_spec)
    else:
        raise InvalidV2RecordError(
            "hardware_spec must be a HardwareSpec instance or dict, got "
            f"{type(hardware_spec).__name__}"
        )

    if worker_pubkey is not None:
        if not isinstance(worker_pubkey, (bytes, bytearray)):
            raise InvalidV2RecordError(
                "worker_pubkey must be bytes, got "
                f"{type(worker_pubkey).__name__}"
            )
        if len(worker_pubkey) != 32:
            raise InvalidV2RecordError(
                f"worker_pubkey must be 32 bytes, got {len(worker_pubkey)}"
            )
        worker_pubkey = bytes(worker_pubkey)

    # Local import — same reason.
    from .canonical import SCHEMA_VERSION_V2

    record: Dict[str, Any] = {
        "schema_version": SCHEMA_VERSION_V2,
        "worker_id": worker_id,
        "tenant_id": tenant_id,
        "period_start_ms": period_start_ms,
        "period_end_ms": period_end_ms,
        "metrics": norm_metrics,
        "hardware_spec": hw_dict,
    }
    if worker_pubkey is not None:
        record["worker_pubkey"] = worker_pubkey
    return record


def sign_record_v2(
    record_body: Dict[str, Any],
    worker_keypair: Any,
) -> Dict[str, Any]:
    """Seal a v2 record body with the worker's sr25519 signature.

    The function:
      1. Sets/overwrites `worker_pubkey` to match the signing key.
      2. Computes the canonical worker-sig pre-image.
      3. sr25519-signs the pre-image bytes.
      4. Returns a NEW dict (does not mutate `record_body`) with the
         `worker_signature` field filled in.

    Args:
        record_body: Output of `build_record_v2(...)`.
        worker_keypair: A `WorkerKeypair` (the worker's signing key).

    Returns:
        A new dict identical to `record_body` plus `worker_pubkey` (32 bytes)
        and `worker_signature` (64 bytes).

    Raises:
        InvalidV2RecordError: if `worker_keypair` isn't a WorkerKeypair, or
            the body is missing required fields.
    """
    # Avoid a hard import at module load.
    from .keypair import WorkerKeypair

    if not isinstance(record_body, dict):
        raise InvalidV2RecordError(
            f"record_body must be dict, got {type(record_body).__name__}"
        )
    if not isinstance(worker_keypair, WorkerKeypair):
        raise InvalidV2RecordError(
            "worker_keypair must be a WorkerKeypair instance"
        )
    # Shallow copy so we don't mutate the caller's dict.
    sealed: Dict[str, Any] = dict(record_body)
    sealed["worker_pubkey"] = bytes.fromhex(worker_keypair.public_hex)

    # Strip any pre-existing observer/signature before computing the pre-image
    # — defense in depth: callers should never pass them in here, but if they
    # do, they MUST NOT contaminate the signed bytes.
    pre_image_record = {
        k: v for k, v in sealed.items()
        if k not in ("worker_signature", "observer")
    }
    from .canonical import canonical_cbor_for_worker_sig

    body = canonical_cbor_for_worker_sig(pre_image_record)
    sig = worker_keypair.sign_bytes(body)
    sealed["worker_signature"] = sig
    return sealed


def attach_observer_signature_v2(
    record: Mapping[str, Any],
    observer_keypair: Any,
) -> Dict[str, Any]:
    """Attach an observer's co-signature to a worker-sealed v2 record.

    The observer signs the SAME pre-image as the worker (different key,
    same bytes). The returned record has an `observer` block populated;
    the worker's existing `worker_signature` is preserved unchanged.

    Args:
        record: A worker-sealed v2 record (output of `sign_record_v2`).
        observer_keypair: An `ObserverKeypair` (or any sr25519 keypair
            with a `sign_bytes` method and `public_hex` property).

    Returns:
        A new dict identical to `record` plus an `observer` sub-dict
        with `observer_pubkey` (32 bytes) and `observer_signature` (64 bytes).

    Raises:
        InvalidV2RecordError: if `record` is missing `worker_signature` or
            `observer_keypair` doesn't have the right shape.
    """
    from .keypair import WorkerKeypair

    if not isinstance(record, Mapping):
        raise InvalidV2RecordError(
            f"record must be a mapping, got {type(record).__name__}"
        )
    if "worker_signature" not in record:
        raise InvalidV2RecordError(
            "observer can only co-sign a worker-sealed record; pass the "
            "output of sign_record_v2(...)"
        )
    if not isinstance(observer_keypair, WorkerKeypair):
        raise InvalidV2RecordError(
            "observer_keypair must be a WorkerKeypair (or ObserverKeypair) "
            "instance"
        )

    # Recompute pre-image WITHOUT worker_signature & observer (per the
    # canonical contract). The worker's pre-image bytes are what we sign.
    from .canonical import canonical_cbor_for_observer_sig

    body = canonical_cbor_for_observer_sig(record)
    sig = observer_keypair.sign_bytes(body)
    obs_pub = bytes.fromhex(observer_keypair.public_hex)

    sealed: Dict[str, Any] = dict(record)
    sealed["observer"] = {
        "observer_pubkey": obs_pub,
        "observer_signature": sig,
    }
    return sealed


def next_period_start_ms(
    last_seen_ms: int, *, now_ms: Optional[int] = None
) -> int:
    """Helper: return a `period_start_ms` value that's strictly greater than
    `last_seen_ms` for the same worker.

    The caller is responsible for tracking `last_seen_ms` per worker
    (per `feedback_intent_settlement_chain_tdd.md`-style chain-side
    monotonic enforcement). This helper exists so a misclock'd machine
    doesn't accidentally produce a non-monotonic record — pass the
    last-recorded ms and current wall-clock; the helper picks the right one.

    Args:
        last_seen_ms: Greatest `period_start_ms` previously sealed for
            this worker_id. Pass 0 for never-seen.
        now_ms: Current wall-clock ms; defaults to time.time_ns() // 1e6.

    Returns:
        `max(last_seen_ms + 1, now_ms)`.
    """
    if not isinstance(last_seen_ms, int) or isinstance(last_seen_ms, bool):
        raise InvalidV2RecordError(
            f"last_seen_ms must be int, got {type(last_seen_ms).__name__}"
        )
    if last_seen_ms < 0:
        raise InvalidV2RecordError(
            f"last_seen_ms must be >= 0, got {last_seen_ms}"
        )
    if now_ms is None:
        import time as _time

        now_ms = _time.time_ns() // 1_000_000
    if not isinstance(now_ms, int) or isinstance(now_ms, bool):
        raise InvalidV2RecordError(
            f"now_ms must be int, got {type(now_ms).__name__}"
        )
    return max(last_seen_ms + 1, now_ms)


def verify_record_v2(record: Mapping[str, Any]) -> bool:
    """Recompute the canonical pre-images and verify both the worker
    signature and (if present) the observer signature.

    Args:
        record: A v2 record dict — the OUTPUT of `sign_record_v2(...)` or
            `attach_observer_signature_v2(...)`.

    Returns:
        True iff every embedded signature verifies. False on any mismatch.
        The fleet-operator signature inside `hardware_spec` is NOT checked
        here — call `HardwareSpec(...).verify(worker_id)` for that (it's
        a different pre-image structure and a different threat model).
    """
    if not isinstance(record, Mapping):
        return False
    if "worker_signature" not in record or "worker_pubkey" not in record:
        return False
    try:
        from substrateinterface import Keypair, KeypairType

        from .canonical import (
            canonical_cbor_for_observer_sig,
            canonical_cbor_for_worker_sig,
        )
    except Exception:
        return False

    worker_pub = record["worker_pubkey"]
    worker_sig = record["worker_signature"]
    if not isinstance(worker_pub, bytes) or len(worker_pub) != 32:
        return False
    if not isinstance(worker_sig, bytes) or len(worker_sig) != 64:
        return False

    try:
        body = canonical_cbor_for_worker_sig(record)
    except (TypeError, KeyError):
        return False
    try:
        verifier = Keypair(
            public_key=worker_pub,
            crypto_type=KeypairType.SR25519,
            ss58_format=42,
        )
        if not verifier.verify(body, worker_sig):
            return False
    except Exception:
        return False

    obs = record.get("observer")
    if obs is not None:
        if not isinstance(obs, Mapping):
            return False
        obs_pub = obs.get("observer_pubkey")
        obs_sig = obs.get("observer_signature")
        if not isinstance(obs_pub, bytes) or len(obs_pub) != 32:
            return False
        if not isinstance(obs_sig, bytes) or len(obs_sig) != 64:
            return False
        try:
            obs_body = canonical_cbor_for_observer_sig(record)
            obs_verifier = Keypair(
                public_key=obs_pub,
                crypto_type=KeypairType.SR25519,
                ss58_format=42,
            )
            if not obs_verifier.verify(obs_body, obs_sig):
                return False
        except Exception:
            return False
    return True

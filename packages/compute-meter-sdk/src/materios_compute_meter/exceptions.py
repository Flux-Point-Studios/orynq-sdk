"""Exception hierarchy for materios_compute_meter.

All exceptions raised by the public API derive from `ComputeMeterError`,
so callers can catch the family with one `except`.
"""
from __future__ import annotations

from typing import Optional


class ComputeMeterError(Exception):
    """Base exception for all materios_compute_meter errors."""


class InvalidSeedError(ComputeMeterError):
    """Raised when `WorkerKeypair.from_seed_hex` gets a value that is not a
    32-byte hex string."""


class InvalidKeyfileError(ComputeMeterError):
    """Raised by `WorkerKeypair.load` when the file is missing fields, has the
    wrong scheme, or contains a public/secret pair that does not derive."""


class InvalidRecordError(ComputeMeterError):
    """Raised by `MeteringRecord.__post_init__` for any value-domain
    violation (negative usage, empty IDs, end <= start)."""


class SubmitError(ComputeMeterError):
    """Raised by `submit()` for any non-gateway error path: configuration
    bad (empty API key), network transport error after the retry budget
    is exhausted, or response not-JSON / missing required fields."""


class GatewayError(SubmitError):
    """Raised by `submit()` when the gateway responds with a non-2xx status
    code that is not retryable (4xx) or after exhausting the retry budget
    on 5xx. Carries the HTTP status code and decoded body if available."""

    def __init__(
        self, status: int, message: str, body: Optional[object] = None
    ) -> None:
        super().__init__(f"gateway returned {status}: {message}")
        self.status = status
        self.body = body


class ReplayRejectedError(ComputeMeterError):
    """Raised by `submit()` when the SDK's local replay cache sees a record
    with `period_start_ms <= last_seen` for the same `worker_id`. This is
    the SDK's own pre-flight check; the gateway also rejects replays
    server-side as a defense in depth."""


# ---------------------------------------------------------------------------
# v2 (compute_metering_v2) exceptions
# ---------------------------------------------------------------------------


class InvalidHardwareSpecError(ComputeMeterError):
    """Raised by `HardwareSpec.load` / `HardwareSpec.__post_init__` when the
    on-disk JSON spec is missing fields, has malformed values (wrong type,
    out-of-range counts, unsupported gpu_type), or carries pubkey/signature
    blobs that aren't 32/64 raw bytes respectively.

    Does NOT raise on signature verification failure — that returns False
    from `HardwareSpec.verify(worker_id)`. Only structural problems trigger
    this exception.
    """


class InvalidV2RecordError(ComputeMeterError):
    """Raised when the v2 record-builder sees a value-domain violation:
    period out of range, bad metric value, gpu_type inconsistent with
    gpu_count, etc. Distinct from `InvalidRecordError` (v1) so callers can
    discriminate which envelope shape they were constructing."""

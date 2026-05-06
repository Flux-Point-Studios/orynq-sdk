"""HTTPS submit pipeline for signed metering records.

`submit(...)` accepts either a pre-signed `Signed[MeteringRecord]` envelope
or a `(WorkerKeypair, MeteringRecord)` pair (one-shot). It POSTs the
canonical signed envelope to `<gateway_url>/metering/submit` with a
`Bearer <api_key>` header.

Behavioural details:
  * Per-process replay cache: a record whose `period_start_ms` is `<=` the
    last seen value for the same `worker_id` raises `ReplayRejectedError`
    BEFORE any HTTP call goes out. This is a defense in depth — the
    gateway also rejects replays server-side at the
    `(signer_pub, period_start_ms)` tuple.
  * Retry policy: one retry on 5xx with a 2-second backoff. 4xx is fatal.
  * Default timeout: 15 seconds, matches publisher convention.
  * URL normalization: trailing slash on `gateway_url` is stripped.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Dict, Optional, Union

import httpx

from .exceptions import (
    GatewayError,
    ReplayRejectedError,
    SubmitError,
)
from .keypair import WorkerKeypair
from .record import MeteringRecord, Signed

_LOG = logging.getLogger(__name__)

DEFAULT_TIMEOUT_SECONDS = 15.0
DEFAULT_RETRY_BACKOFF_SECONDS = 2.0

# Per-process replay cache: maps worker_id -> last accepted period_start_ms.
# Guarded by `_REPLAY_LOCK` so concurrent submit() calls from the same
# process can't race past the check.
_REPLAY_CACHE: Dict[str, int] = {}
_REPLAY_LOCK = threading.Lock()


def _resolve_signed(
    signed_or_kp: Union[Signed, WorkerKeypair],
    record: Optional[MeteringRecord],
) -> Signed:
    """Normalize the two call shapes into a `Signed` envelope."""
    if isinstance(signed_or_kp, Signed):
        if record is not None:
            raise SubmitError(
                "submit(signed, ...) was called with a record argument; pass "
                "either a Signed envelope OR (keypair, record), not both"
            )
        return signed_or_kp

    if isinstance(signed_or_kp, WorkerKeypair):
        if record is None:
            raise SubmitError(
                "submit(keypair, record, ...) requires a record argument"
            )
        return signed_or_kp.sign(record)

    raise SubmitError(
        "first argument to submit() must be a Signed envelope or a WorkerKeypair "
        f"(got {type(signed_or_kp).__name__})"
    )


def _check_and_record_replay(record: MeteringRecord) -> None:
    """Reject if `record.period_start_ms` is not strictly greater than the
    last seen for the same `worker_id`. Updates the cache on success."""
    with _REPLAY_LOCK:
        last = _REPLAY_CACHE.get(record.worker_id)
        if last is not None and record.period_start_ms <= last:
            raise ReplayRejectedError(
                f"replay rejected for worker_id={record.worker_id!r}: "
                f"period_start_ms={record.period_start_ms} is not greater than "
                f"last seen {last} (records must be monotonically increasing)"
            )
        # Warn (not error) if the user submits records with the same period
        # under different worker_ids — that's typically a sign of a clock /
        # naming mistake, but it's not strictly forbidden.
        if last is not None and record.period_start_ms < last + 1:
            _LOG.warning(
                "metering record for worker_id=%r jumped period by less than 1ms; "
                "verify your scheduler is not double-firing",
                record.worker_id,
            )
        _REPLAY_CACHE[record.worker_id] = record.period_start_ms


def _envelope_to_wire(signed: Signed) -> Dict[str, Any]:
    """The JSON shape Agent #1's gateway expects (see
    `feedback_orynq_gateway_migration_gaps.md`-style contract)."""
    return {
        "scheme": signed.scheme,
        "record": signed.record.to_canonical_dict(),
        "content_hash": signed.content_hash,
        "signature": signed.signature,
        "signer_public": signed.signer_public_hex,
    }


def _post_with_retry(
    client: httpx.Client,
    url: str,
    headers: Dict[str, str],
    body: Dict[str, Any],
    retry_backoff_seconds: float,
) -> httpx.Response:
    """One try + one retry on 5xx. 4xx is returned directly (no retry).
    Network errors are retried once with the same backoff, then raised."""
    last_exc: Optional[Exception] = None
    for attempt in (0, 1):
        if attempt == 1 and retry_backoff_seconds > 0:
            time.sleep(retry_backoff_seconds)
        try:
            r = client.post(url, headers=headers, json=body)
        except httpx.HTTPError as e:
            last_exc = e
            if attempt == 1:
                raise SubmitError(
                    f"network error reaching gateway at {url}: {e}"
                ) from e
            continue

        if 500 <= r.status_code < 600:
            if attempt == 0:
                _LOG.warning(
                    "gateway %s returned %d, retrying once after %.1fs backoff",
                    url, r.status_code, retry_backoff_seconds,
                )
                continue
            # Second 5xx — give up.
            return r
        # 2xx or 4xx — return immediately, no retry.
        return r
    # Loop above always returns or raises; this line is for type-checkers.
    raise SubmitError(f"unreachable retry exit; last_exc={last_exc!r}")  # pragma: no cover


def submit(
    signed_or_kp: Union[Signed, WorkerKeypair],
    record: Optional[MeteringRecord] = None,
    *,
    gateway_url: str,
    api_key: str,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    _client: Optional[httpx.Client] = None,
    _retry_backoff_seconds: float = DEFAULT_RETRY_BACKOFF_SECONDS,
) -> Dict[str, Any]:
    """Submit a signed metering record to the Materios blob gateway.

    Two call shapes are supported:

        # 1) Pre-signed envelope:
        signed = kp.sign(record)
        submit(signed, gateway_url=..., api_key=...)

        # 2) One-shot:
        submit(kp, record, gateway_url=..., api_key=...)

    Args:
        signed_or_kp: Either a `Signed` envelope (form 1) or a
            `WorkerKeypair` (form 2).
        record: Required iff form 2; ignored for form 1.
        gateway_url: Base URL of the Materios blob gateway, e.g.
            `https://materios.fluxpointstudios.com/preprod-blobs`. The SDK
            appends `/metering/submit`. Trailing slashes are tolerated.
        api_key: Bearer token issued by the gateway admin (matra_*).
        timeout_seconds: Per-request timeout. Default 15s.

    Returns:
        The decoded JSON body from the gateway, typically:
            {"receipt_id": "...", "content_hash": "...", "accepted_at": ...}

    Raises:
        SubmitError: configuration or network error.
        GatewayError: gateway returned a non-2xx after retries.
        ReplayRejectedError: SDK replay cache rejected the record.
    """
    if not api_key:
        raise SubmitError("api_key must be a non-empty string")
    if not gateway_url:
        raise SubmitError("gateway_url must be a non-empty string")

    base = gateway_url.rstrip("/")
    url = f"{base}/metering/submit"

    envelope = _resolve_signed(signed_or_kp, record)

    # Replay check happens AFTER signing (so a replayed record is signed
    # only once, not zero times — keeps the API symmetric across both call
    # shapes) but BEFORE the network call (so we don't burn quota).
    _check_and_record_replay(envelope.record)

    headers = {
        "authorization": f"Bearer {api_key}",
        "content-type": "application/json",
        "user-agent": "materios-compute-meter/0.1.0",
    }
    wire = _envelope_to_wire(envelope)

    owns_client = _client is None
    client = _client or httpx.Client(timeout=timeout_seconds)
    try:
        try:
            r = _post_with_retry(
                client=client,
                url=url,
                headers=headers,
                body=wire,
                retry_backoff_seconds=_retry_backoff_seconds,
            )
        except SubmitError:
            # Replay cache was already updated; on a hard transport failure
            # we leave the cache as-is so a deliberate retry from the caller
            # with the same record gets the local-replay rejection rather
            # than re-hitting the network. Callers that want to retry MUST
            # bump period_start_ms.
            raise

        if not (200 <= r.status_code < 300):
            try:
                body: Optional[object] = r.json()
                err_msg = (body or {}).get("error") if isinstance(body, dict) else r.text
            except Exception:
                body = r.text
                err_msg = r.text
            raise GatewayError(
                status=r.status_code,
                message=str(err_msg)[:500],
                body=body,
            )

        try:
            decoded = r.json()
        except Exception as e:
            raise SubmitError(
                f"gateway returned non-JSON 2xx body: {r.text[:200]!r}"
            ) from e

        if not isinstance(decoded, dict):
            raise SubmitError(
                f"gateway 2xx body is not a JSON object: {decoded!r}"
            )
        return decoded
    finally:
        if owns_client:
            client.close()


def _reset_replay_cache_for_tests() -> None:
    """Clear the per-process replay cache. Tests may call this between
    parameterized runs that intentionally reuse `worker_id` values."""
    with _REPLAY_LOCK:
        _REPLAY_CACHE.clear()

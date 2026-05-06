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

v2 (compute_metering_v2): `submit_v2(record, gateway_url=..., bearer=...)`
posts a sealed v2 envelope (worker_signature + optional observer co-sig)
to the same `/metering/submit` route. Wire format hex-encodes the byte
fields; the SDK recomputes content_hash locally and asserts equality
against the gateway's response (refuses to trust a server-substituted
hash).
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, Mapping, Optional, Union

import httpx

from .canonical import SCHEMA_VERSION_V2, canonical_content_hash_v2
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


# ---------------------------------------------------------------------------
# v2 submit (compute_metering_v2)
# ---------------------------------------------------------------------------


@dataclass
class SubmissionResult:
    """Structured response from a v2 submit.

    Attributes:
        status_code: HTTP status code returned by the gateway (200..299).
        receipt_id: Stable receipt identifier the gateway assigned. **May be
            None on initial accept** — the gateway issues a synchronous
            "accepted" response immediately on validation success and assigns
            the receipt_id asynchronously when the on-chain extrinsic lands.
            Callers can recover the receipt_id by querying
            `GET /billing/usage?...&include_records=true` and matching on
            content_hash, OR by polling the gateway's receipt-by-content-hash
            lookup. The `status` field on the body distinguishes the two
            paths: `"accepted"` = async (no receipt_id yet), `"replay"` = same
            content_hash already submitted (receipt_id usually present).
        content_hash: SHA-256 hex of the worker-sig canonical pre-image.
            The SDK MUST recompute this locally and assert equality before
            returning, so the caller never sees a server-substituted hash.
        accepted_at: Server-side timestamp (typically UNIX seconds or ms;
            opaque — passthrough).
        body: The full decoded JSON response body, for debugging /
            forward-compat fields the SDK doesn't yet model.
    """

    status_code: int
    receipt_id: Optional[str]
    content_hash: str
    accepted_at: Any
    body: Dict[str, Any]


# v2 wire-shape: hardware_spec + observer carry raw bytes (CBOR-friendly).
# We hex-encode them in the JSON body for safe transport. The gateway
# reverses the hex on its side using the same canonical encoder.

# Map for human-readable errors when the gateway returns one of the new
# v2-specific status codes.
_V2_STATUS_MEANINGS = {
    400: "bad request (malformed envelope or missing field)",
    401: "unauthorized (Bearer token rejected)",
    403: "fleet_operator unknown (the operator pubkey is not registered)",
    409: "duplicate (replay rejected by gateway)",
    422: "hardware bound violated (metric exceeds spec capacity)",
}


def _v2_record_to_wire(record: Mapping[str, Any]) -> Dict[str, Any]:
    """Translate the in-memory v2 record (bytes for pubkeys/sigs) to the JSON
    wire shape (hex-encoded bytes). Does not mutate the input.

    Required record keys: schema_version, worker_id, tenant_id,
    period_start_ms, period_end_ms, metrics, hardware_spec,
    worker_pubkey, worker_signature.

    Optional: observer.

    Raises:
        SubmitError: if a required key is missing or wrong type.
    """
    if not isinstance(record, Mapping):
        raise SubmitError(
            f"v2 record must be a mapping, got {type(record).__name__}"
        )

    required = {
        "schema_version",
        "worker_id",
        "tenant_id",
        "period_start_ms",
        "period_end_ms",
        "metrics",
        "hardware_spec",
        "worker_pubkey",
        "worker_signature",
    }
    missing = required - record.keys()
    if missing:
        raise SubmitError(
            f"v2 record missing required keys: {sorted(missing)}"
        )

    hardware_spec = record["hardware_spec"]
    if not isinstance(hardware_spec, Mapping):
        raise SubmitError("hardware_spec must be a mapping")
    hw_pub = hardware_spec.get("fleet_operator_pubkey")
    hw_sig = hardware_spec.get("fleet_operator_signature")
    if not isinstance(hw_pub, (bytes, bytearray)) or len(hw_pub) != 32:
        raise SubmitError(
            "hardware_spec.fleet_operator_pubkey must be 32-byte bytes"
        )
    if not isinstance(hw_sig, (bytes, bytearray)) or len(hw_sig) != 64:
        raise SubmitError(
            "hardware_spec.fleet_operator_signature must be 64-byte bytes"
        )

    worker_pub = record["worker_pubkey"]
    worker_sig = record["worker_signature"]
    if not isinstance(worker_pub, (bytes, bytearray)) or len(worker_pub) != 32:
        raise SubmitError("worker_pubkey must be 32-byte bytes")
    if not isinstance(worker_sig, (bytes, bytearray)) or len(worker_sig) != 64:
        raise SubmitError("worker_signature must be 64-byte bytes")

    # Wire field names match the gateway-side validator's spec exactly — bare
    # `*_pubkey` / `*_signature`, no `_hex` suffix. The bytes are still
    # serialized as hex strings; the suffix in the field NAME was a stylistic
    # divergence from the spec that broke gateway acceptance (gateway reads
    # `hardware_spec.fleet_operator_pubkey`, not `..._pubkey_hex`).
    wire_hw = {
        "cpu_cores": hardware_spec["cpu_cores"],
        "ram_gb": hardware_spec["ram_gb"],
        "gpu_type": hardware_spec["gpu_type"],
        "gpu_count": hardware_spec["gpu_count"],
        "fleet_operator_pubkey": bytes(hw_pub).hex(),
        "fleet_operator_signature": bytes(hw_sig).hex(),
        "issued_ms": hardware_spec["issued_ms"],
    }

    wire: Dict[str, Any] = {
        "schema_version": record["schema_version"],
        "worker_id": record["worker_id"],
        "tenant_id": record["tenant_id"],
        "period_start_ms": record["period_start_ms"],
        "period_end_ms": record["period_end_ms"],
        "metrics": dict(record["metrics"]),
        "hardware_spec": wire_hw,
        "worker_pubkey": bytes(worker_pub).hex(),
        "worker_signature": bytes(worker_sig).hex(),
    }

    obs = record.get("observer")
    if obs is not None:
        if not isinstance(obs, Mapping):
            raise SubmitError("observer must be a mapping when present")
        obs_pub = obs.get("observer_pubkey")
        obs_sig = obs.get("observer_signature")
        if not isinstance(obs_pub, (bytes, bytearray)) or len(obs_pub) != 32:
            raise SubmitError("observer.observer_pubkey must be 32-byte bytes")
        if not isinstance(obs_sig, (bytes, bytearray)) or len(obs_sig) != 64:
            raise SubmitError("observer.observer_signature must be 64-byte bytes")
        wire["observer"] = {
            "observer_pubkey": bytes(obs_pub).hex(),
            "observer_signature": bytes(obs_sig).hex(),
        }

    return wire


def _v2_check_replay(record: Mapping[str, Any]) -> None:
    """Same per-(worker_id) monotonic check as v1 submit, applied to v2
    records. Worker_id and period_start_ms are field names from the v2
    schema."""
    worker_id = record["worker_id"]
    period_start_ms = record["period_start_ms"]
    if not isinstance(worker_id, str):
        raise SubmitError("v2 record worker_id must be str")
    if not isinstance(period_start_ms, int):
        raise SubmitError("v2 record period_start_ms must be int")
    with _REPLAY_LOCK:
        last = _REPLAY_CACHE.get(worker_id)
        if last is not None and period_start_ms <= last:
            raise ReplayRejectedError(
                f"replay rejected for worker_id={worker_id!r}: "
                f"period_start_ms={period_start_ms} is not greater than "
                f"last seen {last} (records must be monotonically increasing)"
            )
        _REPLAY_CACHE[worker_id] = period_start_ms


def submit_v2(
    record: Mapping[str, Any],
    *,
    gateway_url: str,
    api_key: Optional[str] = None,
    bearer: Optional[str] = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    _client: Optional[httpx.Client] = None,
    _retry_backoff_seconds: float = DEFAULT_RETRY_BACKOFF_SECONDS,
) -> SubmissionResult:
    """Submit a sealed v2 record to the Materios blob gateway.

    Args:
        record: A worker-sealed v2 record (output of
            `materios_compute_meter.record.sign_record_v2(...)`).
            Optionally also observer-co-signed via
            `attach_observer_signature_v2(...)`.
        gateway_url: Base URL of the Materios blob gateway. The SDK appends
            `/metering/submit`. Trailing slash tolerated.
        api_key: Bearer token (mutually exclusive with `bearer` —
            equivalent — both names provided so callers using either v1
            or x402 idiom feel at home).
        bearer: Alias for `api_key`. Pass either, not both.
        timeout_seconds: Per-request timeout. Default 15s.

    Returns:
        A `SubmissionResult` carrying the gateway-returned receipt_id +
        the SDK-verified content_hash (the SDK recomputes content_hash
        locally and asserts it matches the server's response — so callers
        never blindly trust a server-substituted hash).

    Raises:
        SubmitError: configuration / wire-shape / network error.
        GatewayError: gateway returned a non-2xx after retries. Includes
            v2-specific status meanings (403=fleet_operator unknown,
            422=hardware bound violated).
        ReplayRejectedError: SDK replay cache rejected the record.
    """
    if not gateway_url:
        raise SubmitError("gateway_url must be a non-empty string")
    if api_key and bearer and api_key != bearer:
        raise SubmitError(
            "submit_v2 received conflicting api_key and bearer; pass one"
        )
    token = api_key or bearer
    if not token:
        raise SubmitError(
            "submit_v2 requires either api_key= or bearer= (Bearer token)"
        )

    base = gateway_url.rstrip("/")
    url = f"{base}/metering/submit"

    # Translate to wire shape FIRST — surfaces structural errors before any
    # state mutation (replay-cache update happens after).
    wire = _v2_record_to_wire(record)

    # Compute the SDK-side content_hash from the original record (NOT the
    # wire shape). This is what we'll cross-check against the server's
    # response, so a mid-flight tamper or server bug surfaces here.
    expected_content_hash = canonical_content_hash_v2(record)

    # Replay check + cache update (post-wire-validation, pre-network).
    _v2_check_replay(record)

    headers = {
        "authorization": f"Bearer {token}",
        "content-type": "application/json",
        "user-agent": "materios-compute-meter/0.2.0-rc1",
        "x-schema-version": SCHEMA_VERSION_V2,
    }

    owns_client = _client is None
    client = _client or httpx.Client(timeout=timeout_seconds)
    try:
        r = _post_with_retry(
            client=client,
            url=url,
            headers=headers,
            body=wire,
            retry_backoff_seconds=_retry_backoff_seconds,
        )

        if not (200 <= r.status_code < 300):
            try:
                body: Optional[object] = r.json()
            except Exception:
                body = r.text
            # Prefer the gateway's structured `code`/`message`/`error` over
            # our status-code-based heuristic — the gateway knows exactly
            # what went wrong and we should surface that to the operator.
            err_msg: Any = None
            if isinstance(body, dict):
                # Validator-style: {"ok": false, "code": "...", "message": "..."}
                if body.get("code") and body.get("message"):
                    err_msg = f"{body['code']}: {body['message']}"
                elif body.get("error"):
                    err_msg = body["error"]
                elif body.get("message"):
                    err_msg = body["message"]
            if err_msg is None:
                err_msg = r.text or _V2_STATUS_MEANINGS.get(r.status_code, "")
            # If we recognise the status, surface the meaning as a hint
            # AFTER the structured error (so operators see both).
            meaning = _V2_STATUS_MEANINGS.get(r.status_code)
            full_msg = (
                f"{err_msg} [{meaning}]" if meaning and meaning not in str(err_msg) else str(err_msg)
            )
            raise GatewayError(
                status=r.status_code,
                message=full_msg[:500],
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

        # `receipt_id` is async on v2 — the gateway issues an "accepted"
        # response immediately and the receipt_id gets assigned when the
        # on-chain extrinsic lands. Callers recover it later via
        # /billing/usage?...&include_records=true matching on content_hash.
        # Only raise if both receipt_id AND status are missing — that would
        # mean the gateway returned an unexpected shape.
        receipt_id = decoded.get("receipt_id")
        server_content_hash = decoded.get("content_hash")
        accepted_at = decoded.get("accepted_at")
        if receipt_id is not None and not isinstance(receipt_id, str):
            raise SubmitError(
                f"gateway response receipt_id is wrong type "
                f"(expected str | None, got {type(receipt_id).__name__})"
            )
        if not isinstance(server_content_hash, str):
            raise SubmitError(
                f"gateway response missing content_hash (got {decoded!r})"
            )
        if server_content_hash.lower() != expected_content_hash.lower():
            raise SubmitError(
                "gateway returned a content_hash that does not match the "
                "SDK-computed canonical digest. SDK="
                f"{expected_content_hash}, server={server_content_hash}. "
                "This indicates a server-side encoder drift OR a network "
                "tamper — refusing to trust the response."
            )

        return SubmissionResult(
            status_code=r.status_code,
            receipt_id=receipt_id,
            content_hash=expected_content_hash,
            accepted_at=accepted_at,
            body=decoded,
        )
    finally:
        if owns_client:
            client.close()

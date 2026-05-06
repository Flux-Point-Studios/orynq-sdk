"""Helpers for the live-preprod E2E suite (`test_e2e_preprod.py`).

Two responsibilities:

  1. Build a `compute_metering_v1` wire envelope EXACTLY the way Agent #1's
     gateway validator (`services/blob-gateway/src/schemas/compute_metering_v1.ts`)
     decodes it. The on-disk SDK (`materios_compute_meter`) historically used
     a slightly different canonical encoding (cbor2's `canonical=True` over a
     reduced field set with `_ms` suffixes and no `schema_version`); the
     gateway expects RFC 8949 §4.2.1 canonical CBOR over the FULL field set
     including `schema_version` and `worker_pubkey`, with `period_start`/
     `period_end` (no `_ms` suffix), and ALWAYS-8-byte float64. This module
     contains the gateway-compatible canonical encoder so the suite can
     exercise the real wire contract without modifying the SDK's existing
     `submit()` API surface (which has 42/42 unit tests pinned to its own
     shape).

  2. Polling helpers — long-poll a content_hash through cert-daemon
     certification (~5 min p50) and through the Cardano anchor (~15 min p50).
     Per `feedback_anchor_worker_log_timezone_misread.md`: timestamps in
     anchor logs are NOT always UTC, so we never compare wall-clock — we
     only compare gateway-returned status fields.

The encoder here is intentionally a self-contained ~150 LoC pure-Python
implementation; it does NOT call the SDK's `canonical_cbor()`. That keeps
the test independent: if anyone changes the SDK's encoder, the gateway
contract stays pinned by THIS file. Cross-language consistency with the
TS implementation is the whole point of the wire format — so a second
independent implementation in tests is a feature, not duplication.
"""
from __future__ import annotations

import hashlib
import os
import struct
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import httpx

# Pull WorkerKeypair only for type hints; sign_bytes is the only API we use.
from materios_compute_meter import WorkerKeypair


# ---------------------------------------------------------------------------
# Schema constants — kept in lockstep with
# services/blob-gateway/src/schemas/compute_metering_v1.ts
# ---------------------------------------------------------------------------

SCHEMA_VERSION = "compute_metering_v1"

# sha256 of the schema-version utf-8 bytes — surfaced as `schema_hash` by the
# route + by `GET /billing/usage`'s audit_trail. Pinned here so the suite can
# assert the value the gateway returns matches the spec, not whatever the
# server happens to compute today.
SCHEMA_HASH_HEX = hashlib.sha256(SCHEMA_VERSION.encode("utf-8")).hexdigest()

# All `compute_metering_v1` keys that go INTO the canonical body (the input
# to sr25519.sign). `worker_signature` is intentionally absent — it is NOT
# included in the message that's signed (signing yourself is a tautology).
# Order is presentation-only; the canonical encoder sorts by encoded-key
# bytes per RFC 8949 §4.2.1.
CANONICAL_FIELDS = (
    "schema_version",
    "worker_id",
    "tenant_id",
    "period_start",
    "period_end",
    "cpu_seconds",
    "ram_gb_hours",
    "disk_gb_hours",
    "net_bytes_in",
    "net_bytes_out",
    "gpu_seconds",
    "worker_pubkey",
)


# ---------------------------------------------------------------------------
# Canonical CBOR encoder — RFC 8949 §4.2.1, restricted to the type set the
# `compute_metering_v1` schema actually uses. Mirrors the TS implementation
# in compute_metering_v1.ts byte-for-byte.
# ---------------------------------------------------------------------------


def _encode_uint(major: int, n: int) -> bytes:
    """Shortest unsigned-int CBOR encoding (RFC 8949 §3.1)."""
    if n < 0:
        raise TypeError(f"_encode_uint: negative: {n}")
    if n <= 23:
        return bytes([(major << 5) | n])
    if n <= 0xFF:
        return bytes([(major << 5) | 24, n])
    if n <= 0xFFFF:
        return bytes([(major << 5) | 25, (n >> 8) & 0xFF, n & 0xFF])
    if n <= 0xFFFFFFFF:
        return struct.pack(">BI", (major << 5) | 26, n)
    if n > (2**53 - 1):
        # Mirrors the JS_SAFE_INT cap in the TS encoder; we never allow
        # larger ints in this schema's wire form.
        raise TypeError(f"_encode_uint: exceeds JS-safe int: {n}")
    return struct.pack(">BQ", (major << 5) | 27, n)


def _encode_int(n: int) -> bytes:
    """Signed int CBOR encoding (major type 0 for >=0, 1 for <0)."""
    if not isinstance(n, int) or isinstance(n, bool):
        raise TypeError(f"_encode_int: not an integer: {n!r}")
    if n >= 0:
        return _encode_uint(0, n)
    # Major type 1, value -1 - n.
    return _encode_uint(1, -1 - n)


def _encode_float64(n: float) -> bytes:
    """Float64 CBOR encoding (major type 7, additional 27, 8-byte BE).

    Always 8 bytes — never shorten to f32/f16. RFC 8949 §3.3 allows
    shortening but the TS encoder does NOT shorten, and a cross-language
    verifier needs the byte streams identical. NaN and Infinity are refused
    to mirror the TS validator's `Number.isFinite` gate.
    """
    if not isinstance(n, (int, float)) or isinstance(n, bool):
        raise TypeError(f"_encode_float64: not a number: {n!r}")
    f = float(n)
    if f != f or f in (float("inf"), float("-inf")):
        raise TypeError(f"_encode_float64: not finite: {f}")
    return bytes([(7 << 5) | 27]) + struct.pack(">d", f)


def _encode_text(s: str) -> bytes:
    """Text-string CBOR encoding (major type 3, UTF-8 bytes)."""
    if not isinstance(s, str):
        raise TypeError(f"_encode_text: not a string: {s!r}")
    payload = s.encode("utf-8")
    return _encode_uint(3, len(payload)) + payload


def _encode_value(v: Any) -> bytes:
    """Dispatch a single value to the right primitive encoder.

    Order of checks matters:
      * `bool` is a subclass of `int` in Python — forbid explicitly.
      * `str` first to keep sr25519 hex strings out of the int branch.
      * `int` next — Python `True/False` already filtered.
      * `float` last — BUT TypeScript's encoder dispatches floats that are
        whole numbers (`Number.isInteger(v) === true`) to the integer
        encoder (`encodeInt`) regardless of declared type. JavaScript has
        no separate float type, so `0.0` and `0` produce identical CBOR
        bytes there. To match byte-for-byte, mirror that policy here:
        a Python `float` whose `.is_integer()` is True AND fits in the
        signed-int range encodes as an int. A `float` like `120.5` keeps
        the float64 encoding.

    Without this dispatch parity, `gpu_seconds=0.0` etc. would produce
    9-byte float64 encodings on Python and 1-byte uint encodings on TS,
    making the canonical body bytes (and thus content_hash) diverge.
    """
    if isinstance(v, bool):
        raise TypeError(f"_encode_value: bool not allowed in compute_metering_v1: {v}")
    if isinstance(v, str):
        return _encode_text(v)
    if isinstance(v, int):
        return _encode_int(v)
    if isinstance(v, float):
        # Match `Number.isInteger(v)` from TS: True iff finite and the value
        # equals its integer truncation. JS `Number.isInteger` rejects NaN
        # / Infinity by definition; we already gate those in encode_float64
        # so a stray non-finite value still raises.
        if v != v or v in (float("inf"), float("-inf")):
            raise TypeError(f"_encode_value: not finite: {v}")
        if v.is_integer():
            ivalue = int(v)
            # JavaScript's safe-int range is the cap — match.
            if -(2**53 - 1) <= ivalue <= (2**53 - 1):
                return _encode_int(ivalue)
        return _encode_float64(v)
    raise TypeError(f"_encode_value: unsupported type {type(v).__name__}")


def _encode_map(entries: List[Tuple[str, Any]]) -> bytes:
    """Canonical map encoder. Keys encoded first, then sorted by encoded-key
    byte sequence (RFC 8949 §4.2.1). For our short ASCII keys this is
    equivalent to lexicographic string sort."""
    encoded_pairs: List[Tuple[bytes, bytes]] = []
    for k, v in entries:
        kb = _encode_text(k)
        vb = _encode_value(v)
        encoded_pairs.append((kb, vb))
    encoded_pairs.sort(key=lambda kv: kv[0])
    head = _encode_uint(5, len(encoded_pairs))
    return head + b"".join(kb + vb for kb, vb in encoded_pairs)


def canonical_body(record: Dict[str, Any]) -> bytes:
    """Encode the canonical body bytes for a `compute_metering_v1` record.

    `record` MUST include every CANONICAL_FIELDS key (NOT `worker_signature`)
    with the right type — int for time/byte counters, float for *_seconds /
    *_hours, str for ids and hex pubkey. Float types are normalized to ensure
    the wire form is stable (Python int 12 vs float 12.0 produce different
    CBOR bytes; the gateway treats `cpu_seconds` etc. as float).

    Returns the raw canonical CBOR bytes — sha256 of this is `content_hash`,
    and sr25519-sign over this gives `worker_signature`.
    """
    missing = [k for k in CANONICAL_FIELDS if k not in record]
    if missing:
        raise ValueError(f"canonical_body missing required fields: {missing}")
    if "worker_signature" in record:
        raise ValueError(
            "canonical_body must NOT include worker_signature; signature is "
            "computed over the body sans signature, then attached to the "
            "wire envelope separately"
        )
    # Field-type normalization. The TS validator distinguishes integer fields
    # (`period_start`, `period_end`, `net_bytes_in/out`) from floats. Match.
    int_fields = ("period_start", "period_end", "net_bytes_in", "net_bytes_out")
    float_fields = (
        "cpu_seconds",
        "ram_gb_hours",
        "disk_gb_hours",
        "gpu_seconds",
    )
    str_fields = ("schema_version", "worker_id", "tenant_id", "worker_pubkey")
    entries: List[Tuple[str, Any]] = []
    for k in CANONICAL_FIELDS:
        v = record[k]
        if k in int_fields:
            if not isinstance(v, int) or isinstance(v, bool):
                raise TypeError(f"{k} must be int (got {type(v).__name__})")
            entries.append((k, v))
        elif k in float_fields:
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise TypeError(f"{k} must be a finite number (got {type(v).__name__})")
            entries.append((k, float(v)))
        elif k in str_fields:
            if not isinstance(v, str):
                raise TypeError(f"{k} must be str (got {type(v).__name__})")
            entries.append((k, v))
        else:
            raise AssertionError(f"unhandled CANONICAL_FIELDS member: {k}")
    return _encode_map(entries)


def canonical_content_hash(record: Dict[str, Any]) -> str:
    """sha256 hex of the canonical body. Matches gateway's content_hash."""
    return hashlib.sha256(canonical_body(record)).hexdigest()


# ---------------------------------------------------------------------------
# Wire-envelope builder — turns a canonical record + signature into the JSON
# body the route accepts.
# ---------------------------------------------------------------------------


@dataclass
class SignedEnvelope:
    """The exact JSON shape POSTed to `/metering/submit`."""

    content_hash: str
    body_bytes: bytes
    wire: Dict[str, Any]


def build_record(
    *,
    worker_id: str,
    tenant_id: str,
    period_start: int,
    period_end: int,
    cpu_seconds: float,
    ram_gb_hours: float = 0.0,
    disk_gb_hours: float = 0.0,
    net_bytes_in: int = 0,
    net_bytes_out: int = 0,
    gpu_seconds: float = 0.0,
    worker_pubkey_hex: str,
) -> Dict[str, Any]:
    """Assemble the dict shape the canonical encoder accepts (no signature).

    All numeric arguments are passed through with no clamping — bound checks
    (max_cpu_cores * periodSec etc.) live on the gateway. The test suite
    exercises in-bounds values only.
    """
    return {
        "schema_version": SCHEMA_VERSION,
        "worker_id": worker_id,
        "tenant_id": tenant_id,
        "period_start": period_start,
        "period_end": period_end,
        "cpu_seconds": float(cpu_seconds),
        "ram_gb_hours": float(ram_gb_hours),
        "disk_gb_hours": float(disk_gb_hours),
        "net_bytes_in": net_bytes_in,
        "net_bytes_out": net_bytes_out,
        "gpu_seconds": float(gpu_seconds),
        "worker_pubkey": worker_pubkey_hex,
    }


def sign_envelope(kp: WorkerKeypair, record: Dict[str, Any]) -> SignedEnvelope:
    """Sign `record` with `kp` and return the wire envelope ready to POST.

    Asserts `record["worker_pubkey"] == kp.public_hex` so a typo can't
    silently produce a record that signs under one key but claims to be
    from another.
    """
    if record["worker_pubkey"] != kp.public_hex:
        raise ValueError(
            "record.worker_pubkey does not match keypair public; refusing to "
            f"sign (record={record['worker_pubkey'][:16]}..., "
            f"kp={kp.public_hex[:16]}...)"
        )
    body_bytes = canonical_body(record)
    sig = kp.sign_bytes(body_bytes)
    sig_hex = sig.hex()
    if len(sig_hex) != 128:
        # sr25519 signature is always 64 bytes / 128 hex chars; surface a
        # broken upstream lib loudly rather than letting the gateway return
        # HEX_FORMAT.
        raise RuntimeError(
            f"sr25519 signature unexpected length: {len(sig_hex)} hex chars"
        )
    wire = {**record, "worker_signature": sig_hex}
    return SignedEnvelope(
        content_hash=hashlib.sha256(body_bytes).hexdigest(),
        body_bytes=body_bytes,
        wire=wire,
    )


# ---------------------------------------------------------------------------
# Tenant-id helpers — keep the suite re-runnable on a shared gateway.
# ---------------------------------------------------------------------------


def fresh_tenant_id(prefix: str = "e2e") -> str:
    """Return a unique tenant_id matching the gateway regex `[a-z0-9-]{4,64}`.

    We use ms-since-epoch + 4 random hex bytes; that's 13 + 8 = 21 chars
    plus the prefix, well under 64.
    """
    suffix = f"{int(time.time() * 1000):x}-{os.urandom(4).hex()}"
    out = f"{prefix}-{suffix}".lower()
    # Defensive truncation; the dynamic suffix length is constant so this is
    # reachable only for a misconfigured prefix.
    return out[:64]


def fresh_worker_id(prefix: str = "w") -> str:
    """Return a unique worker_id matching `[a-z0-9-]{4,64}`."""
    suffix = f"{int(time.time() * 1000):x}-{os.urandom(3).hex()}"
    out = f"{prefix}-{suffix}".lower()
    return out[:64]


# ---------------------------------------------------------------------------
# Endpoint client — thin wrapper around httpx with ENV-driven config.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GatewayConfig:
    """Resolved gateway endpoint + auth config for the test session."""

    base_url: str
    bearer: str

    @property
    def metering_submit_url(self) -> str:
        return f"{self.base_url.rstrip('/')}/metering/submit"

    @property
    def billing_usage_url(self) -> str:
        return f"{self.base_url.rstrip('/')}/billing/usage"

    @property
    def auth_header(self) -> Dict[str, str]:
        # The gateway's bearerAuth middleware accepts either Authorization:
        # Bearer or x-api-key. We stick to Bearer for parity with what
        # operator-facing docs (project_sponsored_receipt_pipeline.md) tell
        # callers to use.
        return {"authorization": f"Bearer {self.bearer}"}


def submit_metering(
    cfg: GatewayConfig,
    envelope: SignedEnvelope,
    *,
    timeout_s: float = 10.0,
) -> httpx.Response:
    """POST a signed envelope to `/metering/submit`. Returns the raw response
    (caller asserts on status + body)."""
    headers = {
        **cfg.auth_header,
        "content-type": "application/json",
        "user-agent": "materios-compute-meter-e2e/0.1.0",
    }
    with httpx.Client(timeout=timeout_s) as client:
        return client.post(cfg.metering_submit_url, json=envelope.wire, headers=headers)


def fetch_billing_usage(
    cfg: GatewayConfig,
    *,
    tenant_id: str,
    start_ms: int,
    end_ms: int,
    include_records: bool = True,
    page_size: Optional[int] = None,
    cursor: Optional[str] = None,
    timeout_s: float = 10.0,
) -> httpx.Response:
    """GET `/billing/usage` with the given filter parameters."""
    params: Dict[str, Any] = {
        "tenant_id": tenant_id,
        "start_ms": str(start_ms),
        "end_ms": str(end_ms),
        "include_records": "true" if include_records else "false",
    }
    if page_size is not None:
        params["page_size"] = str(page_size)
    if cursor is not None:
        params["cursor"] = cursor
    with httpx.Client(timeout=timeout_s) as client:
        return client.get(cfg.billing_usage_url, params=params, headers=cfg.auth_header)


# ---------------------------------------------------------------------------
# Polling helpers — exponential-backoff wait until certified / anchored.
# ---------------------------------------------------------------------------


@dataclass
class PollResult:
    """Returned by every `wait_for_*` helper. `final` is the last response
    body observed (so the test can attach diagnostic context to a failure
    without re-querying)."""

    success: bool
    elapsed_s: float
    polls: int
    final: Optional[Dict[str, Any]]
    final_status: Optional[str]


def _exp_backoff(attempt: int) -> float:
    """5s base, 1.4x growth, cap 60s. Long-poll the cert-daemon (~5 min p50)
    without burning a request per second."""
    base = 5.0
    delay = base * (1.4**attempt)
    return min(delay, 60.0)


def wait_for_certification(
    cfg: GatewayConfig,
    *,
    tenant_id: str,
    content_hash: str,
    period_start_ms: int,
    period_end_ms: int,
    deadline_s: float,
) -> PollResult:
    """Poll `/billing/usage` until the record with `content_hash` reports
    `attestation_status == "certified"`, or the deadline elapses.

    Window is `[period_start_ms - 1, period_end_ms + 1]` so an off-by-one
    in the gateway's inclusivity model can't make the record invisible.
    """
    start = time.monotonic()
    attempt = 0
    last_body: Optional[Dict[str, Any]] = None
    last_status: Optional[str] = None
    while True:
        elapsed = time.monotonic() - start
        if elapsed >= deadline_s:
            return PollResult(
                success=False,
                elapsed_s=elapsed,
                polls=attempt,
                final=last_body,
                final_status=last_status,
            )
        attempt += 1
        try:
            r = fetch_billing_usage(
                cfg,
                tenant_id=tenant_id,
                start_ms=max(0, period_start_ms - 1),
                end_ms=period_end_ms + 1,
                include_records=True,
                timeout_s=10.0,
            )
        except httpx.HTTPError:
            # Network blip — sleep + retry. Don't count against the deadline
            # specially; the deadline check above handles it.
            time.sleep(_exp_backoff(attempt))
            continue
        if r.status_code == 200:
            try:
                body = r.json()
            except Exception:
                body = None
            if isinstance(body, dict):
                last_body = body
                rec = _find_record_by_hash(body, content_hash)
                if rec is not None:
                    last_status = rec.get("attestation_status")
                    if last_status == "certified":
                        return PollResult(
                            success=True,
                            elapsed_s=time.monotonic() - start,
                            polls=attempt,
                            final=body,
                            final_status="certified",
                        )
        # Sleep up to a budget that won't blow the deadline.
        remaining = deadline_s - (time.monotonic() - start)
        if remaining <= 0:
            continue
        time.sleep(min(_exp_backoff(attempt), max(0.5, remaining)))


def wait_for_cardano_anchor(
    cfg: GatewayConfig,
    *,
    tenant_id: str,
    content_hash: str,
    period_start_ms: int,
    period_end_ms: int,
    deadline_s: float,
) -> PollResult:
    """Like `wait_for_certification` but waits for `cardano_anchor_tx` to
    become non-null. Implies certification (gateway gates anchor_tx on it)."""
    start = time.monotonic()
    attempt = 0
    last_body: Optional[Dict[str, Any]] = None
    last_status: Optional[str] = None
    while True:
        elapsed = time.monotonic() - start
        if elapsed >= deadline_s:
            return PollResult(
                success=False,
                elapsed_s=elapsed,
                polls=attempt,
                final=last_body,
                final_status=last_status,
            )
        attempt += 1
        try:
            r = fetch_billing_usage(
                cfg,
                tenant_id=tenant_id,
                start_ms=max(0, period_start_ms - 1),
                end_ms=period_end_ms + 1,
                include_records=True,
                timeout_s=15.0,
            )
        except httpx.HTTPError:
            time.sleep(_exp_backoff(attempt))
            continue
        if r.status_code == 200:
            try:
                body = r.json()
            except Exception:
                body = None
            if isinstance(body, dict):
                last_body = body
                rec = _find_record_by_hash(body, content_hash)
                if rec is not None:
                    last_status = rec.get("attestation_status")
                    anchor_tx = rec.get("cardano_anchor_tx")
                    if anchor_tx:
                        return PollResult(
                            success=True,
                            elapsed_s=time.monotonic() - start,
                            polls=attempt,
                            final=body,
                            final_status="anchored",
                        )
        remaining = deadline_s - (time.monotonic() - start)
        if remaining <= 0:
            continue
        time.sleep(min(_exp_backoff(attempt), max(0.5, remaining)))


def _find_record_by_hash(
    body: Dict[str, Any],
    content_hash: str,
) -> Optional[Dict[str, Any]]:
    """Locate a record in a `/billing/usage` response by content_hash.

    Returns None if `records` was omitted (include_records=false) or the
    hash isn't in the page. Caller is responsible for choosing a window
    narrow enough to fit on a single page.
    """
    records = body.get("records")
    if not isinstance(records, list):
        return None
    for r in records:
        if isinstance(r, dict) and r.get("content_hash") == content_hash:
            return r
    return None


# ---------------------------------------------------------------------------
# Pre-flight probes — used by the conftest skip logic.
# ---------------------------------------------------------------------------


def gateway_health(cfg: GatewayConfig, *, timeout_s: float = 5.0) -> Optional[int]:
    """GET `/health`. Returns the HTTP status or None on transport error."""
    url = f"{cfg.base_url.rstrip('/')}/health"
    try:
        with httpx.Client(timeout=timeout_s) as client:
            r = client.get(url)
            return r.status_code
    except httpx.HTTPError:
        return None


def metering_endpoint_status(cfg: GatewayConfig, *, timeout_s: float = 5.0) -> Optional[int]:
    """POST a known-bad probe to `/metering/submit`. Returns the HTTP status
    or None. 404 => route not deployed yet (skip suite); 400 / 401 / 422 =>
    deployed (run suite)."""
    try:
        with httpx.Client(timeout=timeout_s) as client:
            r = client.post(cfg.metering_submit_url, json={"probe": True})
            return r.status_code
    except httpx.HTTPError:
        return None


def billing_endpoint_status(cfg: GatewayConfig, *, timeout_s: float = 5.0) -> Optional[int]:
    """GET `/billing/usage` with no params. 400 => deployed (missing params),
    404 => not deployed."""
    try:
        with httpx.Client(timeout=timeout_s) as client:
            r = client.get(cfg.billing_usage_url, headers=cfg.auth_header)
            return r.status_code
    except httpx.HTTPError:
        return None

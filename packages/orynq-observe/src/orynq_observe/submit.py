"""HTTPS submit pipeline for signed ai_capability_observation_v1 records.

The SDK signs the canonical CBOR pre-image with the observer's sr25519 key
and POSTs the envelope to the Materios blob gateway. The gateway:

  1. Validates the schema shape + observer signature.
  2. Stores the manifest at receipts/{contentHash}.
  3. Fires `notifySponsoredReceiptSubmitter()` with schemaHash = the AI
     observation schema hash. The submitter calls
     `submit_receipt_v2(content_hash, schema_hash)` on Materios.
  4. The cert-daemon's M-of-N committee picks up the receipt, signs over
     the canonical bytes, and anchors to Cardano L1.

This module does NOT compute the M-of-N committee signatures — that's
cert-daemon's job. It also does NOT submit to Materios directly — that's
the sponsored-receipt-submitter's job. The SDK's sole on-chain hand-off
is the HTTPS POST to the gateway.

Receipt lookup:
  The initial submit returns a `materios_tx = None` because the
  `submit_receipt_v2` extrinsic is issued asynchronously by the
  submitter. `SubmissionReceipt.refresh(...)` polls the gateway's
  `/receipts/{content_hash}` endpoint to fill in `materios_tx` and
  `cardano_anchor_tx` when they land.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

import httpx

from .canonical import (
    SCHEMA_HASH_HEX,
    SCHEMA_VERSION,
    canonical_cbor,
    canonical_content_hash,
)
from .keypair import ObserverKeypair


_LOG = logging.getLogger(__name__)


# Per-network defaults. Override via `gateway_url=` to point at a self-hosted
# gateway or a different deployment. The path `/preprod-blobs` is the
# canonical preprod prefix used by the materios.fluxpointstudios.com tunnel.
DEFAULT_GATEWAY_URLS = {
    "preprod": "https://materios.fluxpointstudios.com/preprod-blobs",
    "mainnet": "https://materios.fluxpointstudios.com/mainnet-blobs",
}

DEFAULT_TIMEOUT_SECONDS = 15.0
DEFAULT_RETRY_BACKOFF_SECONDS = 2.0


# --------------------------------------------------------------------------- #
# Exceptions
# --------------------------------------------------------------------------- #


class SubmitError(RuntimeError):
    """Raised on submission-pipeline failures (config / network / shape)."""


class GatewayError(RuntimeError):
    """Raised when the gateway returns a non-2xx response."""

    def __init__(
        self,
        *,
        status: int,
        message: str,
        body: Any = None,
    ) -> None:
        super().__init__(f"gateway HTTP {status}: {message}")
        self.status = status
        self.message = message
        self.body = body


# --------------------------------------------------------------------------- #
# Receipt
# --------------------------------------------------------------------------- #


@dataclass
class SubmissionReceipt:
    """Result of a successful (or accepted) observation submission.

    Attributes:
        content_hash: SHA-256 hex of the canonical CBOR pre-image. The
            SDK recomputes this locally and asserts the gateway's response
            agrees; callers can trust this field unconditionally.
        gateway_status: HTTP status code from the gateway's initial accept.
        accepted_at: Server-side timestamp from the initial accept (opaque).
        materios_tx: The on-chain extrinsic hash, when known. None on
            initial accept — `submit_receipt_v2` is dispatched
            asynchronously by the sponsored-receipt-submitter. Call
            `refresh(gateway_url=..., api_key=...)` to populate.
        cardano_anchor_tx: Cardano L1 transaction hash carrying the
            corresponding checkpoint, when known. None until the
            anchor-worker has produced it (typically 30-90s after
            `materios_tx`).
        observer_ss58: SS58 address of the observer key the submission
            was signed under.
        body: Full gateway response body for debugging / forward-compat.
    """

    content_hash: str
    gateway_status: int
    accepted_at: Any
    materios_tx: Optional[str] = None
    cardano_anchor_tx: Optional[str] = None
    observer_ss58: str = ""
    body: Dict[str, Any] = field(default_factory=dict)

    # --- ergonomic mirrors of the requested public surface ----------------
    @property
    def materiosTx(self) -> Optional[str]:  # noqa: N802 — TS-style alias
        return self.materios_tx

    @property
    def cardanoAnchorTx(self) -> Optional[str]:  # noqa: N802 — TS-style alias
        return self.cardano_anchor_tx

    def refresh(
        self,
        *,
        gateway_url: str,
        api_key: Optional[str] = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> "SubmissionReceipt":
        """Poll the gateway for materios_tx + cardano_anchor_tx and update
        this receipt in place. Returns self for chaining.

        The gateway exposes `GET /receipts/{content_hash}` returning a JSON
        body shaped roughly:

            {
              "content_hash": "...",
              "receipt_id":   "...",
              "materios_tx":  "0x..." | null,
              "cardano_anchor_tx": "..."  | null,
            }
        """
        base = gateway_url.rstrip("/")
        url = f"{base}/receipts/{self.content_hash}"
        headers: Dict[str, str] = {
            "accept": "application/json",
            "user-agent": f"orynq-observe/{_VERSION}",
        }
        if api_key:
            headers["authorization"] = f"Bearer {api_key}"

        with httpx.Client(timeout=timeout_seconds) as client:
            r = client.get(url, headers=headers)
        if r.status_code == 404:
            # Receipt not yet on chain — quietly leave fields None.
            return self
        if not (200 <= r.status_code < 300):
            raise GatewayError(
                status=r.status_code,
                message=r.text[:200],
                body=None,
            )
        try:
            decoded = r.json()
        except Exception as e:
            raise SubmitError(
                f"receipt lookup returned non-JSON body: {r.text[:200]!r}"
            ) from e
        if isinstance(decoded, dict):
            mtx = decoded.get("materios_tx") or decoded.get("materiosTx")
            ctx = (
                decoded.get("cardano_anchor_tx")
                or decoded.get("cardanoAnchorTx")
            )
            if isinstance(mtx, str):
                self.materios_tx = mtx
            if isinstance(ctx, str):
                self.cardano_anchor_tx = ctx
            self.body = decoded
        return self


# --------------------------------------------------------------------------- #
# Wire shape
# --------------------------------------------------------------------------- #


def _record_to_wire(record: Dict[str, Any], signed: Dict[str, Any]) -> Dict[str, Any]:
    """JSON shape sent to `POST /observations/submit`.

    The wire layer:
      * Echoes the canonical record verbatim (gateway re-encodes locally
        and asserts equality with the supplied `content_hash`).
      * Adds `observer_signature` + `observer_pubkey` as 64/32-byte hex.
      * Includes `schema_hash` for the sponsored-receipt-submitter.
    """
    return {
        "schema_version": SCHEMA_VERSION,
        "schema_hash": SCHEMA_HASH_HEX,
        "record": record,
        "content_hash": signed["content_hash"],
        "observer_pubkey": signed["observer_pubkey_hex"],
        "observer_signature": signed["signature_hex"],
    }


def _sign_record(
    record: Dict[str, Any], keypair: ObserverKeypair
) -> Dict[str, Any]:
    body = canonical_cbor(record)
    digest_hex = canonical_content_hash(record)
    signature = keypair.sign_bytes(body)
    return {
        "content_hash": digest_hex,
        "signature_hex": signature.hex(),
        "observer_pubkey_hex": keypair.public_hex,
    }


def _resolve_gateway_url(network: str, override: Optional[str]) -> str:
    if override:
        return override
    if network not in DEFAULT_GATEWAY_URLS:
        raise SubmitError(
            f"unknown network {network!r}; supply gateway_url= explicitly "
            f"or use one of {list(DEFAULT_GATEWAY_URLS)}"
        )
    return DEFAULT_GATEWAY_URLS[network]


def _post_with_retry(
    client: httpx.Client,
    url: str,
    headers: Dict[str, str],
    body: Dict[str, Any],
    retry_backoff_seconds: float,
) -> httpx.Response:
    """One try + one retry on 5xx. 4xx is returned directly (no retry)."""
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
            return r
        return r
    raise SubmitError(f"unreachable retry exit; last_exc={last_exc!r}")  # pragma: no cover


# --------------------------------------------------------------------------- #
# Public entry point
# --------------------------------------------------------------------------- #


def submit_observation(
    *,
    record: Dict[str, Any],
    keypair: ObserverKeypair,
    network: str = "preprod",
    gateway_url: Optional[str] = None,
    api_key: Optional[str] = None,
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    _client: Optional[httpx.Client] = None,
    _retry_backoff_seconds: float = DEFAULT_RETRY_BACKOFF_SECONDS,
) -> SubmissionReceipt:
    """Sign + POST a canonical AI capability observation record.

    Args:
        record: The wire-shape dict (use `Observation.to_record(...)` to
            build one). Must include the `schemaVersion` literal.
        keypair: The observer's sr25519 keypair. The signed pre-image is
            the canonical CBOR; the gateway re-encodes locally and asserts
            the supplied content_hash matches.
        network: "preprod" (default) or "mainnet". Picks the default gateway.
        gateway_url: Override the network default.
        api_key: Bearer token issued by the gateway operator. Required —
            observation submission is sponsored (the operator pays the
            chain fee on behalf of the researcher).
        timeout_seconds: Per-request HTTP timeout. Default 15s.

    Returns:
        A `SubmissionReceipt`. On initial accept, `materios_tx` and
        `cardano_anchor_tx` are typically None — call `.refresh(...)` to
        poll for them.

    Raises:
        SubmitError: configuration / wire-shape / network error.
        GatewayError: gateway returned a non-2xx after retries.
    """
    if not api_key:
        raise SubmitError(
            "api_key is required — observation submission is sponsored. "
            "Request a token from the gateway operator (materios.fluxpoint "
            "studios.com on preprod) and pass api_key=..."
        )
    resolved = _resolve_gateway_url(network, gateway_url)

    # Recompute content_hash locally so we control the canonical bytes.
    expected_hash = canonical_content_hash(record)
    signed = _sign_record(record, keypair)
    if signed["content_hash"] != expected_hash:
        # Defensive — _sign_record uses the same canonical fn; this should
        # never fire, but if it does, we want a loud failure not a silent
        # mismatch downstream.
        raise SubmitError(
            "internal canonical-hash drift between record encode + sign"
        )

    wire = _record_to_wire(record, signed)
    base = resolved.rstrip("/")
    url = f"{base}/observations/submit"
    headers = {
        "authorization": f"Bearer {api_key}",
        "content-type": "application/json",
        "user-agent": f"orynq-observe/{_VERSION}",
        "x-schema-version": SCHEMA_VERSION,
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
                body: Any = r.json()
            except Exception:
                body = r.text
            err_msg: Any = None
            if isinstance(body, dict):
                if body.get("code") and body.get("message"):
                    err_msg = f"{body['code']}: {body['message']}"
                elif body.get("error"):
                    err_msg = body["error"]
                elif body.get("message"):
                    err_msg = body["message"]
            if err_msg is None:
                err_msg = r.text or f"HTTP {r.status_code}"
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
        server_hash = decoded.get("content_hash") or decoded.get("contentHash")
        if not isinstance(server_hash, str):
            raise SubmitError(
                f"gateway response missing content_hash (got {decoded!r})"
            )
        if server_hash.lower() != expected_hash.lower():
            raise SubmitError(
                "gateway returned a content_hash that does not match the "
                f"SDK-computed canonical digest (SDK={expected_hash}, "
                f"server={server_hash}). Refusing to trust the response."
            )

        return SubmissionReceipt(
            content_hash=expected_hash,
            gateway_status=r.status_code,
            accepted_at=decoded.get("accepted_at") or decoded.get("acceptedAt"),
            materios_tx=decoded.get("materios_tx") or decoded.get("materiosTx"),
            cardano_anchor_tx=(
                decoded.get("cardano_anchor_tx")
                or decoded.get("cardanoAnchorTx")
            ),
            observer_ss58=keypair.ss58_address,
            body=decoded,
        )
    finally:
        if owns_client:
            client.close()


_VERSION = "0.1.0"

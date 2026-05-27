"""Fluent builder for an ai_capability_observation_v1 record.

The public surface mirrors the spec:

    obs = Observation(
        model_name="claude-opus-4-7",
        model_version="20260201",
        taxonomy_id="AUTO-MONEY-001",
        severity="high",
        observer_context="independent red-team session",
    )
    obs.add_evidence(prompt="...", response="...")
    obs.add_artifact("/path/to/transcript.json")  # optional, blob upload
    obs.attest_tee(tier="Acurast", evidence=b"...")  # optional
    receipt = obs.submit(wallet="path/to/key.json", network="preprod")

The builder is a thin shell around a normalized dict. The canonical
encoder lives in `canonical.py` and operates on that dict directly, so
callers wanting to bypass the builder (advanced verifiers, batch tools)
can do so with the same byte guarantees.
"""
from __future__ import annotations

import hashlib
import os
import time
from typing import TYPE_CHECKING, Any, Dict, Optional, Union

from .canonical import (
    SCHEMA_VERSION,
    SEVERITIES,
    canonical_cbor,
    canonical_content_hash,
)
from .keypair import ObserverKeypair

if TYPE_CHECKING:
    from .submit import SubmissionReceipt  # noqa: F401


class ObservationError(ValueError):
    """Raised on builder-level shape violations."""


def _sha256_hex(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


class Observation:
    """Builder for one AI capability observation.

    All construction parameters are required at __init__. Evidence
    (prompt/response) MAY be added via `add_evidence` later, but `submit`
    refuses an observation without it — `promptHash` and `responseHash` are
    mandatory in the wire schema.

    The observer ss58 address is derived from the wallet keyfile passed to
    `submit(wallet=...)`. The observer context string is part of the
    canonical pre-image so a single key can publish observations under
    different attribution strings without re-keying.
    """

    def __init__(
        self,
        *,
        model_name: str,
        model_version: str,
        taxonomy_id: str,
        severity: str,
        observer_context: str,
        model_hash: Optional[Union[bytes, str]] = None,
        occurred_at: Optional[int] = None,
    ) -> None:
        if not isinstance(model_name, str) or not model_name:
            raise ObservationError("model_name must be a non-empty string")
        if not isinstance(model_version, str) or not model_version:
            raise ObservationError("model_version must be a non-empty string")
        if not isinstance(taxonomy_id, str) or not taxonomy_id:
            raise ObservationError("taxonomy_id must be a non-empty string")
        if severity not in SEVERITIES:
            raise ObservationError(
                f"severity must be one of {SEVERITIES}, got {severity!r}"
            )
        if not isinstance(observer_context, str):
            raise ObservationError("observer_context must be a string")
        if occurred_at is not None and (
            not isinstance(occurred_at, int) or isinstance(occurred_at, bool)
        ):
            raise ObservationError("occurred_at must be int (unix ms)")

        self._model: Dict[str, Any] = {
            "name": model_name,
            "version": model_version,
            "hash": model_hash,
        }
        self._capability: Dict[str, Any] = {
            "taxonomyId": taxonomy_id,
            "severity": severity,
        }
        self._observation: Dict[str, Any] = {
            "promptHash": None,
            "responseHash": None,
            "artifactRef": None,
            "occurredAt": occurred_at if occurred_at is not None else _now_ms(),
        }
        self._observer_context = observer_context
        self._tee: Optional[Dict[str, Any]] = None

    # ---------------------- evidence + artifact + TEE --------------------

    def add_evidence(
        self,
        *,
        prompt: Union[str, bytes],
        response: Union[str, bytes],
    ) -> "Observation":
        """Hash the prompt + response bytes into the observation pre-image.

        Strings are encoded as UTF-8. Hashing is sha256, 32-byte digest. We
        deliberately do NOT carry plaintext on chain — only the hash. A
        researcher who wants to publish the transcript can add it via
        `add_artifact(...)` which uploads the bytes to a blob endpoint and
        carries a content-addressable ref in `artifactRef`.
        """
        if isinstance(prompt, str):
            prompt_bytes = prompt.encode("utf-8")
        elif isinstance(prompt, (bytes, bytearray)):
            prompt_bytes = bytes(prompt)
        else:
            raise ObservationError(
                f"prompt must be str or bytes, got {type(prompt).__name__}"
            )
        if isinstance(response, str):
            response_bytes = response.encode("utf-8")
        elif isinstance(response, (bytes, bytearray)):
            response_bytes = bytes(response)
        else:
            raise ObservationError(
                f"response must be str or bytes, got {type(response).__name__}"
            )
        self._observation["promptHash"] = _sha256_hex(prompt_bytes)
        self._observation["responseHash"] = _sha256_hex(response_bytes)
        return self

    def add_evidence_hashes(
        self, *, prompt_hash: Union[str, bytes], response_hash: Union[str, bytes]
    ) -> "Observation":
        """For callers that already have sha256 digests (e.g. hashes from an
        external transcript store). Both must be 32 bytes / 64 hex chars."""
        self._observation["promptHash"] = prompt_hash
        self._observation["responseHash"] = response_hash
        return self

    def add_artifact(
        self,
        path_or_ref: str,
        *,
        gateway_url: Optional[str] = None,
        api_key: Optional[str] = None,
    ) -> "Observation":
        """Attach a content-addressable artifact reference.

        Two modes:
          * If `path_or_ref` is an existing file path AND `gateway_url` is set,
            the SDK uploads the bytes to the blob-gateway and sets
            `artifactRef = "blob:<sha256_hex>"`.
          * Otherwise, `path_or_ref` is treated as an opaque pre-existing ref
            (e.g. an IPFS CID, an S3 URL, a hash hex) and stored verbatim.

        The on-chain pre-image carries ONLY the ref string — never the
        contents. Anyone with the ref + gateway access can recover the bytes
        and re-verify the content hash; without the ref the chain anchor
        leaks nothing about the artifact.
        """
        if not isinstance(path_or_ref, str) or not path_or_ref:
            raise ObservationError(
                "path_or_ref must be a non-empty string"
            )
        if gateway_url is not None and os.path.isfile(path_or_ref):
            # Local file path mode — upload bytes to blob gateway.
            ref = self._upload_artifact(path_or_ref, gateway_url, api_key)
            self._observation["artifactRef"] = ref
        else:
            # Opaque pre-existing reference.
            self._observation["artifactRef"] = path_or_ref
        return self

    def attest_tee(
        self,
        *,
        tier: str,
        evidence: Union[bytes, str],
    ) -> "Observation":
        """Attach a TEE attestation envelope.

        `tier` is a free-form short string identifying the TEE family
        (Acurast / AMD_SEV_SNP / Intel_TDX / ARM_TrustZone / ReproducibleBuild).
        `evidence` is opaque bytes — the TEE's quote / attestation document
        in its native binary form. We hash + carry verbatim in the canonical
        pre-image, then the cert-daemon (or downstream verifier) is responsible
        for parsing the tier-specific format.
        """
        if not isinstance(tier, str) or not tier:
            raise ObservationError("tier must be a non-empty string")
        if not isinstance(evidence, (bytes, bytearray, str)):
            raise ObservationError("evidence must be bytes or hex str")
        self._tee = {"tier": tier, "evidence": evidence}
        return self

    # ---------------------- record assembly ------------------------------

    def to_record(self, observer_ss58: str) -> Dict[str, Any]:
        """Return the canonical wire-shape dict for the canonical encoder.

        Args:
            observer_ss58: SS58 address derived from the observer keypair —
                bound into the canonical pre-image so the receipt anchor
                attributes the observation to the right signer.

        Returns:
            A dict ready for `canonical_cbor(...)` / `canonical_content_hash(...)`.

        Raises:
            ObservationError: if `add_evidence` has not been called.
        """
        prompt_hash = self._observation.get("promptHash")
        response_hash = self._observation.get("responseHash")
        if prompt_hash is None or response_hash is None:
            raise ObservationError(
                "promptHash + responseHash are required — call add_evidence(...) "
                "or add_evidence_hashes(...) before submit()"
            )
        return {
            "schemaVersion": SCHEMA_VERSION,
            "model": dict(self._model),
            "capability": dict(self._capability),
            "observation": dict(self._observation),
            "observer": {
                "ss58": observer_ss58,
                "context": self._observer_context,
                "teeAttestation": dict(self._tee) if self._tee else None,
            },
        }

    def content_hash(self, observer_ss58: str) -> str:
        """Compute the SDK-side canonical content_hash for a given observer ss58.

        Useful for offline preview / debugging without submitting.
        """
        return canonical_content_hash(self.to_record(observer_ss58))

    # ---------------------- submission -----------------------------------

    def submit(
        self,
        *,
        wallet: Union[str, ObserverKeypair],
        network: str = "preprod",
        gateway_url: Optional[str] = None,
        api_key: Optional[str] = None,
        timeout_seconds: float = 15.0,
    ) -> "SubmissionReceipt":
        """Sign the observation and POST it to the Materios blob gateway.

        Args:
            wallet: Either a `ObserverKeypair` instance OR a filesystem path
                to a JSON keyfile (`scheme` may be `sr25519-observer` or
                `sr25519`).
            network: "preprod" (default) or "mainnet". Selects the gateway
                URL when one is not explicitly supplied.
            gateway_url: Override the default per-network gateway URL.
                Trailing slash tolerated.
            api_key: Bearer token issued by the gateway admin. Required
                because observation submission is sponsored (the gateway
                operator pays the chain fee on behalf of the researcher).
            timeout_seconds: Per-request HTTP timeout.

        Returns:
            A `SubmissionReceipt` with the materios_tx (initial accept) and
            the SDK-verified content_hash. Cardano anchor tx is populated by
            polling the gateway later; the initial receipt may have
            `cardano_anchor_tx = None`.
        """
        # Resolve wallet → ObserverKeypair.
        if isinstance(wallet, ObserverKeypair):
            kp = wallet
        elif isinstance(wallet, str):
            kp = ObserverKeypair.load(wallet)
        else:
            raise ObservationError(
                f"wallet must be ObserverKeypair or keyfile path, got "
                f"{type(wallet).__name__}"
            )

        # Local import to avoid pulling httpx at module-load time for
        # callers who only want the canonical encoder.
        from .submit import submit_observation

        record = self.to_record(observer_ss58=kp.ss58_address)
        return submit_observation(
            record=record,
            keypair=kp,
            network=network,
            gateway_url=gateway_url,
            api_key=api_key,
            timeout_seconds=timeout_seconds,
        )

    # ---------------------- helpers --------------------------------------

    def _upload_artifact(
        self,
        path: str,
        gateway_url: str,
        api_key: Optional[str],
    ) -> str:
        """Upload an artifact file to the blob gateway, return `blob:<sha256>`.

        Uses the gateway's `/blobs` route. The artifact is uploaded as raw
        bytes; the SDK computes the sha256 client-side and trusts the
        gateway's returned content hash only after equality check (mirrors
        the compute-meter-sdk content_hash double-check).
        """
        import httpx  # local import — keep startup cost minimal

        with open(path, "rb") as f:
            payload = f.read()
        digest = _sha256_hex(payload)

        base = gateway_url.rstrip("/")
        url = f"{base}/blobs"
        headers = {
            "content-type": "application/octet-stream",
            "user-agent": f"orynq-observe/{_VERSION}",
        }
        if api_key:
            headers["authorization"] = f"Bearer {api_key}"

        with httpx.Client(timeout=30.0) as client:
            r = client.post(url, headers=headers, content=payload)
            if not (200 <= r.status_code < 300):
                raise ObservationError(
                    f"artifact upload failed: status={r.status_code} "
                    f"body={r.text[:200]!r}"
                )
            try:
                body = r.json()
            except Exception:
                body = {}
            server_hash = (
                body.get("content_hash")
                or body.get("contentHash")
                or body.get("sha256")
            )
            if server_hash and server_hash.lower() != digest.lower():
                raise ObservationError(
                    "gateway returned a content_hash that does not match the "
                    f"SDK-computed sha256 (SDK={digest}, server={server_hash})"
                )
        return f"blob:{digest}"


_VERSION = "0.1.0"

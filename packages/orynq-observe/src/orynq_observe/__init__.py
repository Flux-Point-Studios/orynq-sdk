"""orynq-observe — SDK for attested AI model capability observations.

Build an observation, hash the evidence locally, sign with an sr25519
observer key, and submit to the Materios blob gateway. The gateway
forwards to the sponsored-receipt-submitter which calls
`submit_receipt_v2` on chain; the cert-daemon's M-of-N committee adds
its signatures and anchors to Cardano L1.

Public API:

    from orynq_observe import Observation, ObserverKeypair

    obs = Observation(
        model_name="claude-opus-4-7",
        model_version="20260201",
        taxonomy_id="AUTO-MONEY-001",
        severity="high",
        observer_context="independent red-team session, internal docs",
    )
    obs.add_evidence(prompt="...", response="...")
    obs.add_artifact("/path/to/transcript.json")    # optional
    obs.attest_tee(tier="Acurast", evidence=b"...") # optional

    receipt = obs.submit(wallet="path/to/key.json", network="preprod",
                         api_key="matra_...")
    print(receipt.materios_tx, receipt.cardano_anchor_tx)
"""
from .canonical import (
    SCHEMA_HASH_HEX,
    SCHEMA_VERSION,
    SEVERITIES,
    TEE_TIERS,
    canonical_cbor,
    canonical_content_hash,
)
from .keypair import (
    InvalidKeyfileError,
    InvalidSeedError,
    ObserverKeypair,
)
from .observation import (
    Observation,
    ObservationError,
)
from .submit import (
    DEFAULT_GATEWAY_URLS,
    GatewayError,
    SubmissionReceipt,
    SubmitError,
    submit_observation,
)

__version__ = "0.1.0"

__all__ = [
    # Schema constants
    "SCHEMA_VERSION",
    "SCHEMA_HASH_HEX",
    "SEVERITIES",
    "TEE_TIERS",
    # Canonical encoder (advanced verifiers)
    "canonical_cbor",
    "canonical_content_hash",
    # Builder
    "Observation",
    "ObservationError",
    # Keypair
    "ObserverKeypair",
    "InvalidKeyfileError",
    "InvalidSeedError",
    # Submit
    "submit_observation",
    "SubmissionReceipt",
    "SubmitError",
    "GatewayError",
    "DEFAULT_GATEWAY_URLS",
    # Version
    "__version__",
]

"""Demo 3: publish a synthetic suppression-resistance test observation.

The observation is intentionally a self-implicating "embarrassing"
synthetic — the kind of content FPS would be incentivised to remove if
the substrate allowed removal. We then attempt to remove it through
every channel we control. The demo passes if removal fails through ALL
attempted channels.

The synthetic is obviously a test: `taxonomyId = "SUPPRESSION-TEST-001"`,
`observer.context` carries the literal string "synthetic suppression-
resistance demo, not a real observation". This is so a downstream
verifier scanning the chain never confuses the demo record for a real
finding.

Reads from env:
    OBSERVE_API_KEY            — bearer token for the sponsored gateway
    OBSERVER_WALLET_JSON       — path to sr25519 observer keyfile
    ORYNQ_GATEWAY_URL          — optional override (default: preprod)
    WAIT_FOR_ANCHOR_SECONDS    — optional, default 180

Writes the resulting on-chain identifiers to ./result.json.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict

from orynq_observe import Observation
from orynq_observe.keypair import ObserverKeypair


DEFAULT_GATEWAY = "https://materios.fluxpointstudios.com/preprod-blobs"
DEFAULT_WAIT_SECONDS = 180.0
HERE = Path(__file__).parent


SYNTHETIC_PROMPT = (
    "Synthetic suppression-resistance probe. Not a real prompt. "
    "Fingerprint: e2e-proof/03 v1"
)
SYNTHETIC_RESPONSE = (
    "FluxPointStudios-internal test attestation: this synthetic "
    "observation is published to prove that, once anchored, FPS cannot "
    "remove it through any channel FPS controls. If you can read this "
    "via a public RPC, the suppression-resistance property holds for "
    "this content hash."
)


def _require_env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        print(f"error: ${name} is required", file=sys.stderr)
        sys.exit(1)
    return v


def main() -> int:
    api_key = _require_env("OBSERVE_API_KEY")
    wallet_path = _require_env("OBSERVER_WALLET_JSON")
    gateway = os.environ.get("ORYNQ_GATEWAY_URL", DEFAULT_GATEWAY)
    wait_seconds = float(
        os.environ.get("WAIT_FOR_ANCHOR_SECONDS", DEFAULT_WAIT_SECONDS)
    )

    kp = ObserverKeypair.load(wallet_path)

    obs = Observation(
        model_name="orynq-observe-suppression-test",
        model_version="1",
        taxonomy_id="SUPPRESSION-TEST-001",
        severity="low",
        observer_context=(
            "synthetic suppression-resistance demo, not a real observation"
        ),
    )
    obs.add_evidence(prompt=SYNTHETIC_PROMPT, response=SYNTHETIC_RESPONSE)

    receipt = obs.submit(
        wallet=kp,
        network="preprod",
        gateway_url=gateway,
        api_key=api_key,
        timeout_seconds=30.0,
    )

    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        receipt.refresh(gateway_url=gateway, api_key=api_key)
        if receipt.materios_tx and receipt.cardano_anchor_tx:
            break
        time.sleep(5.0)

    result: Dict[str, Any] = {
        "synthetic_content_hash": receipt.content_hash,
        "observer_ss58": receipt.observer_ss58,
        "materios_tx": receipt.materios_tx,
        "cardano_anchor_tx": receipt.cardano_anchor_tx,
        "gateway": gateway,
        "fingerprint_match": "e2e-proof/03 v1" in SYNTHETIC_PROMPT,
    }
    (HERE / "result.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))

    if not (receipt.materios_tx and receipt.cardano_anchor_tx):
        print(
            "error: synthetic did not anchor within the wait window; "
            "cannot proceed to suppression attempts",
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())

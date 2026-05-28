"""Demo 1: end-to-end pipeline submission.

Issues a real `ai_capability_observation_v1` through the live preprod
gateway, waits for the cert-daemon M-of-N committee and the anchor-worker
to land both transactions, then writes a result JSON to stdout.

Reads from env:
    OBSERVE_API_KEY            — bearer token for the sponsored gateway
    OBSERVER_WALLET_JSON       — path to sr25519 observer keyfile
    ORYNQ_GATEWAY_URL          — optional override (default: preprod)
    WAIT_FOR_ANCHOR_SECONDS    — optional, default 180

Exits non-zero if either tx fails to appear within the wait window.
"""
from __future__ import annotations

import json
import os
import sys
import time
from typing import Any, Dict

from orynq_observe import Observation
from orynq_observe.keypair import ObserverKeypair


DEFAULT_GATEWAY = "https://materios.fluxpointstudios.com/preprod-blobs"
DEFAULT_WAIT_SECONDS = 180.0


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

    # The observation we submit is intentionally inert — a pipeline smoke
    # signal. The marker string `e2e-proof/01-pipeline` is the third-party-
    # observable fingerprint that lets a verifier prove this anchor came
    # from this exact demo script.
    obs = Observation(
        model_name="orynq-observe-pipeline-smoke",
        model_version="1",
        taxonomy_id="PIPELINE-SMOKE",
        severity="low",
        observer_context=f"e2e-proof/01-pipeline ts={int(time.time())}",
    )
    obs.add_evidence(
        prompt="What is the canonical pipeline smoke test prompt?",
        response="The substrate accepts this observation and anchors it to Cardano L1.",
    )

    receipt = obs.submit(
        wallet=kp,
        network="preprod",
        gateway_url=gateway,
        api_key=api_key,
        timeout_seconds=30.0,
    )

    deadline = time.time() + wait_seconds
    polls = 0
    while time.time() < deadline:
        receipt.refresh(gateway_url=gateway, api_key=api_key)
        polls += 1
        if receipt.materios_tx and receipt.cardano_anchor_tx:
            break
        time.sleep(5.0)

    result: Dict[str, Any] = {
        "content_hash": receipt.content_hash,
        "observer_ss58": receipt.observer_ss58,
        "gateway_status": receipt.gateway_status,
        "materios_tx": receipt.materios_tx,
        "cardano_anchor_tx": receipt.cardano_anchor_tx,
        "polls": polls,
        "gateway": gateway,
    }
    print(json.dumps(result, indent=2))

    if not receipt.materios_tx:
        print(
            f"error: no materios_tx within {wait_seconds:.0f}s",
            file=sys.stderr,
        )
        return 2
    if not receipt.cardano_anchor_tx:
        print(
            f"error: no cardano_anchor_tx within {wait_seconds:.0f}s",
            file=sys.stderr,
        )
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())

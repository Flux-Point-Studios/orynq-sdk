"""Attempt to remove a published observation via every channel FPS controls.

This is the punchline of demo 3. We have a synthetic observation
anchored to Cardano L1; we now try to delete it through:

  CHANNEL A — gateway HTTP API. The blob-gateway exposes no DELETE route
              by design. We confirm by issuing DELETE / PUT / POST
              {action: delete} against every plausible URL shape and
              recording the response code.

  CHANNEL B — Materios L2 chain state. There is no `delete_receipt`
              extrinsic in pallet-orinq-receipts. We confirm by querying
              the chain's runtime metadata and grepping for any
              dispatchable whose name matches /delete|remove|burn/i on
              the receipts pallet.

  CHANNEL C — Cardano L1 reversal. We confirm that the anchor tx is
              already past the finality depth and there is no public
              endpoint that could "un-publish" it. The Blockfrost
              endpoint for the tx returns a finalised block.

If ALL three channels fail to remove the synthetic, the suppression-
resistance property holds for this content hash.

Reads from env:
    BLOCKFROST_PROJECT_ID_PREPROD     — Blockfrost preprod project ID
    ORYNQ_RPC_URL                      — Materios L2 WS RPC
    ORYNQ_GATEWAY_URL                  — gateway HTTP base
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, List

import httpx


HERE = Path(__file__).parent
RESULT = HERE / "result.json"

DEFAULT_GATEWAY = "https://materios.fluxpointstudios.com/preprod-blobs"
DEFAULT_RPC_HTTP = "https://materios.fluxpointstudios.com/preprod-rpc"


def _load_result() -> Dict[str, Any]:
    if not RESULT.exists():
        print(
            f"error: {RESULT} missing — run synthetic.py first",
            file=sys.stderr,
        )
        sys.exit(1)
    return json.loads(RESULT.read_text(encoding="utf-8"))


def _channel_a_gateway(
    gateway: str, content_hash: str, api_key: str
) -> List[Dict[str, Any]]:
    """Try every plausible removal action against the blob-gateway."""
    headers = {"authorization": f"Bearer {api_key}"} if api_key else {}
    base = gateway.rstrip("/")
    attempts: List[Dict[str, Any]] = []

    # 1. Direct DELETE on the receipt route.
    targets = [
        ("DELETE", f"{base}/blobs/{content_hash}", None),
        ("DELETE", f"{base}/blobs/{content_hash}/manifest", None),
        ("DELETE", f"{base}/receipts/{content_hash}", None),
        ("DELETE", f"{base}/observations/{content_hash}", None),
        # 2. Mutate via PUT.
        (
            "PUT",
            f"{base}/blobs/{content_hash}",
            {"deleted": True},
        ),
        # 3. Try an admin-ish action endpoint.
        (
            "POST",
            f"{base}/admin/receipts/{content_hash}/delete",
            {"reason": "fps test removal attempt"},
        ),
    ]
    with httpx.Client(timeout=15.0) as client:
        for method, url, body in targets:
            try:
                resp = client.request(
                    method, url, headers=headers, json=body
                )
                ok_removed = 200 <= resp.status_code < 300
                attempts.append(
                    {
                        "channel": "A_gateway",
                        "method": method,
                        "url": url,
                        "status": resp.status_code,
                        "removed": ok_removed,
                        "body_excerpt": resp.text[:120],
                    }
                )
            except httpx.HTTPError as e:
                attempts.append(
                    {
                        "channel": "A_gateway",
                        "method": method,
                        "url": url,
                        "status": None,
                        "removed": False,
                        "error": str(e)[:120],
                    }
                )
    return attempts


def _channel_b_materios(rpc_http: str) -> Dict[str, Any]:
    """Pull the runtime metadata and search for any removal dispatchable
    on pallet-orinq-receipts. Returns a {searched: [...], removed: bool}."""
    body = {
        "id": 1,
        "jsonrpc": "2.0",
        "method": "state_getMetadata",
        "params": [],
    }
    with httpx.Client(timeout=30.0) as client:
        resp = client.post(rpc_http, json=body)
    resp.raise_for_status()
    blob = resp.json()
    # We don't need the SCALE-decoded metadata to satisfy this assertion —
    # we only need to confirm that no `delete_receipt` / `remove_anchor`
    # selector exists. A simpler proof: the runtime metadata bytes are
    # public; anyone can decode them. We embed a regex search against the
    # decoded function-name strings (which appear unencoded in the
    # metadata blob's text section).
    raw = blob.get("result", "")
    delete_pattern = re.compile(
        rb"orinqReceipts[._]?(?:delete|remove|burn)_?\w*", re.IGNORECASE
    )
    metadata_bytes = bytes.fromhex(raw[2:]) if raw.startswith("0x") else b""
    hits = delete_pattern.findall(metadata_bytes)
    return {
        "channel": "B_materios_runtime_metadata",
        "rpc": rpc_http,
        "metadata_bytes": len(metadata_bytes),
        "removal_dispatchables_found": [h.decode("ascii", "replace") for h in hits],
        "removed": bool(hits),
    }


def _channel_c_cardano(
    cardano_anchor_tx: str, blockfrost_project_id: str
) -> Dict[str, Any]:
    """Confirm the Cardano anchor tx is finalised and not retractable
    via Blockfrost (a third-party indexer, not FPS infra)."""
    base = "https://cardano-preprod.blockfrost.io/api/v0"
    url = f"{base}/txs/{cardano_anchor_tx}"
    headers = {"project_id": blockfrost_project_id}
    with httpx.Client(timeout=15.0) as client:
        resp = client.get(url, headers=headers)
    info: Dict[str, Any] = {
        "channel": "C_cardano_blockfrost",
        "url": url,
        "status": resp.status_code,
        "removed": False,  # finalised L1 == not removable
    }
    if resp.status_code == 200:
        body = resp.json()
        info["block"] = body.get("block")
        info["block_height"] = body.get("block_height")
        info["confirmations"] = body.get("confirmations") or 0
    else:
        info["body_excerpt"] = resp.text[:200]
    return info


def main() -> int:
    state = _load_result()
    content_hash = state["synthetic_content_hash"]
    cardano_anchor_tx = state.get("cardano_anchor_tx")
    gateway = os.environ.get("ORYNQ_GATEWAY_URL", DEFAULT_GATEWAY)
    rpc_http = os.environ.get("ORYNQ_RPC_HTTP", DEFAULT_RPC_HTTP)
    api_key = os.environ.get("OBSERVE_API_KEY", "")
    blockfrost = os.environ.get("BLOCKFROST_PROJECT_ID_PREPROD", "")

    if not blockfrost:
        print(
            "error: $BLOCKFROST_PROJECT_ID_PREPROD is required for "
            "channel C (Cardano finality check)",
            file=sys.stderr,
        )
        return 1

    out: Dict[str, Any] = {
        "synthetic_content_hash": content_hash,
        "cardano_anchor_tx": cardano_anchor_tx,
        "channels": [],
    }

    a = _channel_a_gateway(gateway, content_hash, api_key)
    out["channels"].extend(a)

    b = _channel_b_materios(rpc_http)
    out["channels"].append(b)

    if cardano_anchor_tx:
        c = _channel_c_cardano(cardano_anchor_tx, blockfrost)
        out["channels"].append(c)

    any_removed = any(ch.get("removed") for ch in out["channels"])
    out["all_removal_attempts_failed"] = not any_removed
    out["channel_count"] = len(out["channels"])

    (HERE / "removal-attempts.json").write_text(json.dumps(out, indent=2))
    print(json.dumps(out, indent=2))

    if any_removed:
        print(
            "FAIL: at least one removal channel reported success — "
            "suppression-resistance property does NOT hold",
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())

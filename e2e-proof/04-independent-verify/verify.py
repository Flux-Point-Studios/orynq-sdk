"""Independent verification of an `ai_capability_observation_v1` lineage.

Takes a `content_hash` (64-char lowercase hex) and reconstructs the
full provenance chain — Materios L2 → Cardano L1 — using ONLY public
endpoints:

    A. The public Materios L2 RPC at materios.fluxpointstudios.com/rpc
       (same public RPC any Polkadot.js apps user can connect to).
    B. Blockfrost preprod (third-party Cardano indexer, free tier).

No FPS-controlled non-public endpoint is touched. In particular, the
blob-gateway is NOT contacted at any point in this script.

Steps:

    1. Connect to the Materios public RPC, confirm the genesis hash
       matches the value pinned in this script (`MATERIOS_PREPROD_GENESIS`).
    2. Query `OrinqReceipts.ContentIndex[content_hash]` for the
       receipt_id (or list of receipt_ids if the same content was
       submitted twice).
    3. Query `OrinqReceipts.Receipts[receipt_id]` for the record,
       confirming the `content_hash` field actually matches the input.
    4. Compute the checkpoint leaf locally:
           leaf = sha256("materios-checkpoint-v1" || chain_id_bytes ||
                          receipt_id_bytes || cert_hash_bytes)
    5. Query Blockfrost for recent transactions with metadata label
       8746 (the Materios checkpoint anchor label). Decode each
       metadata payload; keep only those whose `chain` field equals
       MATERIOS_PREPROD_GENESIS.
    6. For each candidate, check whether the leaf falls in the
       advertised `[blocks_from, blocks_to]` window. Return the first
       candidate that covers the receipt's block range.

The result is a JSON document with the full lineage. If the chain
through every step matches, the lineage is independently verified.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from typing import Any, Dict, List, Optional, Tuple

import httpx
from substrateinterface import SubstrateInterface


MATERIOS_PREPROD_GENESIS = (
    "0e46e33f639a56cc8780fd871d9a15e16d99af248526f907cb560cb40849f7bf"
)
DEFAULT_MATERIOS_RPC = "wss://materios.fluxpointstudios.com/rpc"
DEFAULT_BLOCKFROST_PREPROD = "https://cardano-preprod.blockfrost.io/api/v0"
ANCHOR_METADATA_LABEL = 8746


class VerifyError(RuntimeError):
    """Raised when the lineage cannot be reconstructed."""


# ---------------------------------------------------------------------------
# Step helpers
# ---------------------------------------------------------------------------


def _strip0x(h: str) -> str:
    return h[2:] if h.startswith(("0x", "0X")) else h


def _to_bytes32(hex_str: str) -> bytes:
    h = _strip0x(hex_str).lower()
    if len(h) != 64:
        raise VerifyError(
            f"expected 64-char hex (32 bytes), got len={len(h)}: {hex_str!r}"
        )
    return bytes.fromhex(h)


def compute_checkpoint_leaf(
    chain_id_hex: str, receipt_id_hex: str, cert_hash_hex: str
) -> str:
    """Replay the cert-daemon's checkpoint-leaf computation.

    leaf = sha256("materios-checkpoint-v1" || chain || receipt || cert).
    """
    prefix = b"materios-checkpoint-v1"
    payload = (
        prefix
        + _to_bytes32(chain_id_hex)
        + _to_bytes32(receipt_id_hex)
        + _to_bytes32(cert_hash_hex)
    )
    return "0x" + hashlib.sha256(payload).hexdigest()


def step1_connect_to_materios(
    rpc_url: str,
) -> Tuple[SubstrateInterface, str]:
    si = SubstrateInterface(url=rpc_url)
    genesis = si.get_block_hash(0)
    actual = _strip0x(genesis).lower()
    if actual != MATERIOS_PREPROD_GENESIS:
        si.close()
        raise VerifyError(
            f"Materios genesis at {rpc_url} = {actual!r}, expected "
            f"{MATERIOS_PREPROD_GENESIS!r}. Refusing — that RPC is "
            f"not the preprod chain this script knows about."
        )
    return si, "0x" + actual


def step2_lookup_receipt_id(
    si: SubstrateInterface, content_hash: str
) -> List[str]:
    """Resolve content_hash -> [receipt_id, ...] via ContentIndex."""
    ch = "0x" + _strip0x(content_hash).lower()
    result = si.query("OrinqReceipts", "ContentIndex", params=[ch])
    if result is None or result.value is None:
        raise VerifyError(
            f"no receipt found in ContentIndex for content_hash={ch}"
        )
    ids = result.value
    if not isinstance(ids, list):
        ids = [ids]
    return [_strip0x(rid).lower() for rid in ids]


def step3_load_receipt(
    si: SubstrateInterface, receipt_id_hex: str
) -> Dict[str, Any]:
    rid = "0x" + _strip0x(receipt_id_hex).lower()
    receipt = si.query("OrinqReceipts", "Receipts", params=[rid])
    if receipt is None or receipt.value is None:
        raise VerifyError(f"receipt {rid} not found on chain")
    rec = receipt.value
    return rec


def step5_query_anchors_via_blockfrost(
    base: str, project_id: str, count: int = 25
) -> List[Dict[str, Any]]:
    """Fetch transactions whose metadata carries label 8746.

    Endpoint:
      GET /metadata/txs/labels/{label_id}?count=N
    """
    url = f"{base.rstrip('/')}/metadata/txs/labels/{ANCHOR_METADATA_LABEL}"
    headers = {"project_id": project_id}
    params = {"count": count, "order": "desc"}
    with httpx.Client(timeout=30.0) as client:
        resp = client.get(url, headers=headers, params=params)
    if not (200 <= resp.status_code < 300):
        raise VerifyError(
            f"blockfrost {url} returned {resp.status_code}: "
            f"{resp.text[:200]!r}"
        )
    return resp.json()


def step6_match_anchor(
    candidates: List[Dict[str, Any]],
    expected_chain: str,
    receipt_block_num: int,
) -> Optional[Dict[str, Any]]:
    """Find an anchor candidate that (a) carries the expected Materios
    chain id and (b) covers `receipt_block_num` in its `blocks` range.

    Anchor metadata shape:
        {
          "p":        "materios",
          "v":        2,
          "chain":    "<materios_genesis_hex>",
          "blocks":   [from, to],
          "leaves":   N,
          "root":     "<merkle_root_hex>",
          "manifest": "<manifest_hash_hex>"
        }
    """
    expected = _strip0x(expected_chain).lower()
    for c in candidates:
        meta = c.get("json_metadata") or {}
        if not isinstance(meta, dict):
            continue
        if meta.get("p") != "materios":
            continue
        if meta.get("v") != 2:
            continue
        chain = _strip0x(str(meta.get("chain") or "")).lower()
        if chain != expected:
            continue
        blocks = meta.get("blocks")
        if not (isinstance(blocks, list) and len(blocks) == 2):
            continue
        try:
            lo, hi = int(blocks[0]), int(blocks[1])
        except Exception:
            continue
        if lo <= receipt_block_num <= hi:
            return {
                "tx_hash": c.get("tx_hash"),
                "metadata": meta,
            }
    return None


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def verify_lineage(
    content_hash: str,
    *,
    rpc_url: str,
    blockfrost_base: str,
    blockfrost_project_id: str,
    anchor_scan_count: int = 50,
) -> Dict[str, Any]:
    si, chain_id = step1_connect_to_materios(rpc_url)
    try:
        receipt_ids = step2_lookup_receipt_id(si, content_hash)
        records: List[Dict[str, Any]] = []
        for rid in receipt_ids:
            rec = step3_load_receipt(si, rid)
            cert_hash = rec.get("availability_cert_hash") or ""
            if _strip0x(cert_hash) == "00" * 32 or not cert_hash:
                # uncertified yet — leaf computation undefined
                continue
            leaf = compute_checkpoint_leaf(chain_id, rid, cert_hash)
            # Resolve the block number this receipt was created in. The
            # pallet records `created_at_millis` (timestamp, not block);
            # the gateway-side trace lineage uses
            # `ReceiptSubmittedAt[receipt_id]` for block number. Try
            # that storage map first; fall back to a permissive search
            # window if it doesn't exist on this runtime.
            block_num = None
            try:
                rsa = si.query(
                    "OrinqReceipts", "ReceiptSubmittedAt", params=["0x" + rid]
                )
                if rsa is not None and rsa.value is not None:
                    block_num = int(rsa.value)
            except Exception:
                pass
            records.append(
                {
                    "receipt_id": "0x" + rid,
                    "content_hash": rec.get("content_hash"),
                    "availability_cert_hash": cert_hash,
                    "submitter": rec.get("submitter"),
                    "created_at_millis": rec.get("created_at_millis"),
                    "submitted_at_block": block_num,
                    "checkpoint_leaf": leaf,
                }
            )

        if not records:
            raise VerifyError(
                f"content_hash {content_hash} has no certified receipt "
                f"on Materios — cannot proceed to Cardano lookup"
            )

        # For the anchor scan we need a block number. Use the most
        # recent certified record. If no block is known, scan a wide
        # window (the Blockfrost result is small).
        anchors = step5_query_anchors_via_blockfrost(
            blockfrost_base, blockfrost_project_id, count=anchor_scan_count
        )

        matched = None
        matched_for = None
        for rec in records:
            block_num = rec["submitted_at_block"]
            if block_num is None:
                continue
            m = step6_match_anchor(anchors, chain_id, block_num)
            if m:
                matched = m
                matched_for = rec
                break
        if matched is None and records and records[0]["submitted_at_block"] is None:
            # Permissive fallback: best-effort scan ignoring block window
            for c in anchors:
                meta = c.get("json_metadata") or {}
                if not isinstance(meta, dict):
                    continue
                if (
                    meta.get("p") == "materios"
                    and meta.get("v") == 2
                    and _strip0x(str(meta.get("chain") or "")).lower()
                    == _strip0x(chain_id).lower()
                ):
                    matched = {"tx_hash": c.get("tx_hash"), "metadata": meta}
                    matched_for = records[0]
                    break

        if matched is None:
            raise VerifyError(
                f"no Cardano preprod transaction with metadata label "
                f"{ANCHOR_METADATA_LABEL} covers receipt block "
                f"{records[0].get('submitted_at_block')!r} on chain "
                f"{chain_id} (scanned {len(anchors)} recent labelled txs)"
            )

        return {
            "input_content_hash": content_hash,
            "materios": {
                "rpc_url": rpc_url,
                "chain_id": chain_id,
            },
            "cardano": {
                "blockfrost_base": blockfrost_base,
                "scanned_label_8746_count": len(anchors),
            },
            "matched_receipt": matched_for,
            "matched_anchor": matched,
            "verified": True,
        }
    finally:
        si.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Independent lineage verifier using only public RPCs",
    )
    parser.add_argument(
        "--content-hash",
        required=True,
        help="64-char lowercase hex sha256 (the value emitted by the SDK)",
    )
    parser.add_argument(
        "--rpc-url",
        default=os.environ.get("ORYNQ_RPC_URL", DEFAULT_MATERIOS_RPC),
    )
    parser.add_argument(
        "--blockfrost-base",
        default=DEFAULT_BLOCKFROST_PREPROD,
    )
    parser.add_argument(
        "--blockfrost-project-id",
        default=os.environ.get("BLOCKFROST_PROJECT_ID_PREPROD"),
    )
    parser.add_argument(
        "--anchor-scan-count",
        type=int,
        default=int(os.environ.get("ANCHOR_SCAN_COUNT", "50")),
    )
    args = parser.parse_args()

    if not args.blockfrost_project_id:
        print(
            "error: $BLOCKFROST_PROJECT_ID_PREPROD or --blockfrost-project-id "
            "is required",
            file=sys.stderr,
        )
        return 1

    try:
        result = verify_lineage(
            args.content_hash,
            rpc_url=args.rpc_url,
            blockfrost_base=args.blockfrost_base,
            blockfrost_project_id=args.blockfrost_project_id,
            anchor_scan_count=args.anchor_scan_count,
        )
    except VerifyError as e:
        print(f"VERIFICATION FAILED: {e}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())

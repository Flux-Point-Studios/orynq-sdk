# Demo 4 — Independent verification

Take a `content_hash` (as emitted by [demo 1](../01-pipeline)) and
reconstruct the full lineage **using only public RPCs**. No FPS-controlled
non-public endpoint is contacted at any step.

**Limits.** `verify.py` reads only the flat encoding of the label 8746
record, which no checkpoint anchor has used since 2026-06-29: the live
anchor worker writes the detailed-schema encoding, so `verify.py` matches
none of its anchors. It also never checks the receipt's leaf against the
anchored root, nor the wallet that funded the anchor, and it selects
anchors by their `chain` field, a label that genuine anchors of
[two windows](../../packages/anchors-cardano/README.md#the-chain-field-is-a-label)
get wrong; a match does not prove inclusion. `verifyMateriosCheckpointAnchor` in
`@fluxpointstudios/orynq-sdk-anchors-cardano` makes every check; its
[README](../../packages/anchors-cardano/README.md#verifying-a-receipts-anchor)
lists its inputs and trust assumptions.

## What "public" means here

| Endpoint | Operator | Public? |
|---|---|---|
| `wss://materios.fluxpointstudios.com/rpc` | Materios partner-chain network | YES — same kind of public Substrate RPC any Polkadot.js apps user connects to; consensus is multi-operator |
| `https://cardano-mainnet.blockfrost.io/api/v0` | Blockfrost (independent indexer) | YES — third-party, free tier, no FPS relationship |

The script does NOT touch:

* `materios.fluxpointstudios.com/preprod-blobs`  (the FPS blob-gateway)
* Any `/trace/api/lineage/*` endpoint (FPS-provided convenience)
* Any FPS-operated indexer

If FPS goes offline tomorrow, this script still works as long as any
Materios validator publishes a public RPC AND Blockfrost is reachable.

## Steps

```
Input:  content_hash  (sha256 of canonical observation pre-image)

  1. Connect to Materios public RPC.
  2. Confirm genesis = 0e46e33f...49f7bf (the preprod chain pinned in this script).
  3. Query OrinqReceipts.ContentIndex[content_hash] → [receipt_id, ...]
  4. Query OrinqReceipts.Receipts[receipt_id] → cert_hash + record
  5. Compute the checkpoint leaf locally:
       leaf = sha256("materios-checkpoint-v1" || chain_id || receipt_id || cert_hash)
  6. Pull recent Cardano mainnet transactions with metadata label 8746 via Blockfrost.
  7. Decode each metadata payload. Keep only those with:
        p     == "materios"
        v     == 2
        chain == 0e46e33f...49f7bf       (the Materios genesis we expect)
  8. Pick the candidate whose `[blocks_from, blocks_to]` window covers
     the receipt's submission block (from OrinqReceipts.ReceiptSubmittedAt).
```

If step 8 returns a tx hash, a flat label 8746 record naming this chain
covers the receipt's block; the limits above say what that leaves
unproven.

## Run

```bash
export BLOCKFROST_PROJECT_ID_MAINNET=mainnetXXXX...
pip install -e packages/orynq-observe   # for substrate-interface + httpx
python e2e-proof/04-independent-verify/verify.py \
    --content-hash <64_char_hex_from_demo_1>
```

Output:

```json
{
  "input_content_hash": "...",
  "materios": {
    "rpc_url": "wss://materios.fluxpointstudios.com/rpc",
    "chain_id": "0x0e46e33f..."
  },
  "cardano": {
    "blockfrost_base": "https://cardano-mainnet.blockfrost.io/api/v0",
    "scanned_label_8746_count": 50
  },
  "matched_receipt": {
    "receipt_id": "0x...",
    "content_hash": "0x...",
    "availability_cert_hash": "0x...",
    "submitter": "...",
    "submitted_at_block": ...,
    "checkpoint_leaf": "0x..."
  },
  "matched_anchor": {
    "tx_hash": "...",
    "metadata": { "p": "materios", "v": 2, ... }
  },
  "verified": true
}
```

## Hermetic tests

```bash
pytest e2e-proof/04-independent-verify/test_verify.py -v
```

The hermetic suite asserts:

| # | Property |
|---|---|
| T1 | `compute_checkpoint_leaf` is byte-identical to the cert-daemon formula (pinned fixture replays cleanly) |
| T2 | `step6_match_anchor` accepts a candidate whose `blocks` range covers the receipt block AND `chain` matches |
| T3 | Rejects a candidate whose `chain` does not match — no cross-chain confusion possible |
| T4 | Rejects a candidate whose `blocks` range excludes the receipt block — anchors are block-window-bound |
| T5 | Rejects a candidate with wrong `p` or wrong `v` — label 8746 might be reused later, schema check is mandatory |
| T6 | When multiple anchors qualify, returns the first (Blockfrost orders newest-first) |

The pinned fixture in [`fixtures/lineage-sample.json`](./fixtures/lineage-sample.json)
includes a real on-chain `(receipt_id, cert_hash, expected_leaf)` triple
pulled from preprod block 350k. If the leaf formula ever changes, T1
fails loudly.

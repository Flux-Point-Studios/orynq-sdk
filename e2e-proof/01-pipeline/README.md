# Demo 1 — Pipeline integrity

End-to-end exercise of the orynq-observe substrate, single observation:

```
   ┌──────────────────┐
   │ orynq-observe    │  sign (sr25519 observer key)
   │ Python SDK       │
   └────────┬─────────┘
            │  POST /observations/submit  (signed canonical CBOR)
            ▼
   ┌──────────────────────────────┐
   │ blob-gateway (preprod)       │
   │  → schema validate           │
   │  → observer signature verify │
   │  → store blob                │
   │  → notify sponsored-submitter│
   └────────┬─────────────────────┘
            │  submit_receipt_v2(content_hash, schema_hash)
            ▼
   ┌──────────────────────────────┐
   │ Materios L2 (preprod chain)  │
   │  ReceiptSubmittedV2 event    │  ← materios_tx
   └────────┬─────────────────────┘
            │
            ▼
   ┌──────────────────────────────┐
   │ cert-daemon M-of-N committee │
   │  → sign canonical bytes      │
   │  → write availability cert   │
   └────────┬─────────────────────┘
            │
            ▼
   ┌──────────────────────────────┐
   │ anchor-worker                │
   │  → batch Merkle root         │
   │  → submit Cardano L1 tx      │  ← cardano_anchor_tx
   └──────────────────────────────┘
```

The demo asserts both `materios_tx` and `cardano_anchor_tx` are returned
by the gateway's `/receipts/{content_hash}` endpoint within 180s.

## What this proves

* The observation reaches the chain end-to-end.
* The cert-daemon committee accepts the canonical bytes the SDK signed.
* The anchor-worker rolls the receipt into a Cardano L1 transaction with
  metadata label 8746 (the Materios checkpoint label).
* A third party with the returned `cardano_anchor_tx` can read its
  anchor record on Cardano mainnet through [Cexplorer](https://cexplorer.io)
  or [Cardanoscan](https://cardanoscan.io) without contacting any
  FPS-controlled endpoint. Proving that the receipt is in the anchored
  batch also takes the batch's leaf list, which only the FPS gateway
  serves.

## Run

```bash
export OBSERVE_API_KEY=matra_...
export OBSERVER_WALLET_JSON=/abs/path/to/observer.json
./run.sh
```

Output (truncated):

```
{
  "content_hash": "8a3f...e2",
  "observer_ss58": "5...",
  "gateway_status": 200,
  "materios_tx": "0x...",
  "cardano_anchor_tx": "..."
}

Cardano preprod tx:  abcd...
  Cexplorer:         https://preprod.cexplorer.io/tx/abcd...
  Cardanoscan:       https://preprod.cardanoscan.io/transaction/abcd...
```

## Third-party verification

Anyone can inspect the resulting `cardano_anchor_tx`:

1. Open Cexplorer / Cardanoscan with the tx hash.
2. Read metadata label `8746`. It holds the batch's checkpoint record:

       {
         "p":        "materios",
         "v":        2,
         "chain":    "<materios_genesis_hex>",
         "blocks":   [from, to],
         "leaves":   N,
         "root":     "<merkle_root_hex>",
         "manifest": "<manifest_hash_hex>"
       }

   The live anchor worker writes it in cardano-serialization-lib's
   detailed-schema encoding, so the label's value reads
   `{"map": [{"k": {"string": "p"}, "v": {"string": "materios"}}, ...]}`.
   Only the anchors a second, Lucid-based worker wrote from 2026-04-18 to
   2026-06-29 hold the record above as it stands.
3. The `chain` field equals the Materios preprod genesis hash:
   `0e46e33f639a56cc8780fd871d9a15e16d99af248526f907cb560cb40849f7bf`.

The label alone proves little: anyone can write a label 8746 record naming
any root. `verifyMateriosCheckpointAnchor` from
`@fluxpointstudios/orynq-sdk-anchors-cardano` proves that the receipt is in
the anchored batch and that a wallet you pin funded the anchor; its
[README](../../packages/anchors-cardano/README.md#verifying-a-receipts-anchor)
lists what it needs and what it trusts.

## CI

`.github/workflows/e2e-proof.yml` runs this demo on every push to `main`
and posts the resulting Cardano tx hash to the workflow's job summary.

## Generating an observer keyfile

```bash
pip install -e packages/orynq-observe
orynq-observe keygen --out observer.json
```

The keyfile is a JSON document with `{ scheme, public, secret }`; store
it with `chmod 0600`.

## Hermetic tests

```bash
pip install -e packages/orynq-observe
pytest e2e-proof/01-pipeline/test_pipeline.py
```

No network access required.

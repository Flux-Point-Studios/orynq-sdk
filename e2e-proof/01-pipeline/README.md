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
* A third party with the returned `cardano_anchor_tx` can replay the
  same proof against [Cexplorer](https://preprod.cexplorer.io) or
  [Cardanoscan](https://preprod.cardanoscan.io) without contacting any
  FPS-controlled endpoint.

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

Anyone can confirm the resulting `cardano_anchor_tx`:

1. Open Cexplorer / Cardanoscan with the tx hash.
2. Decode metadata label `8746`. The structure is:

       {
         "p":        "materios",
         "v":        2,
         "chain":    "<materios_genesis_hex>",
         "blocks":   [from, to],
         "leaves":   N,
         "root":     "<merkle_root_hex>",
         "manifest": "<manifest_hash_hex>"
       }

3. The `chain` field equals the Materios preprod genesis hash:
   `0e46e33f639a56cc8780fd871d9a15e16d99af248526f907cb560cb40849f7bf`.

If the metadata label is present and the chain field matches, the receipt
is anchored to the Materios partner-chain irreversibly. To go further and
prove the specific `content_hash` is in the batch, use demo 4.

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

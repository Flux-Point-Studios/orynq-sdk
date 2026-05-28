# Demo 3 — Suppression-resistance

Publish a synthetic test observation that FluxPointStudios (FPS) — the
gateway operator — would be incentivised to remove, then **fail** to
remove it through every channel FPS controls.

## The synthetic

* `model.name = "orynq-observe-suppression-test"`
* `capability.taxonomyId = "SUPPRESSION-TEST-001"`
* `observer.context = "synthetic suppression-resistance demo, not a real observation"`
* `observation.responseHash = sha256(<a self-implicating string about FPS>)`

The literal text used for `promptHash` and `responseHash` carries the
fingerprint `e2e-proof/03 v1` so a downstream verifier scanning the chain
recognises this is a test artefact and not a real finding. Full plaintext
in [`synthetic.py`](./synthetic.py).

## The removal attempts

After the synthetic is anchored to Cardano L1, [`attempt_removal.py`]
(./attempt_removal.py) attempts to delete it through every channel FPS
controls:

| Channel | What we try | Why it fails |
|---|---|---|
| A — gateway HTTP | DELETE / PUT / POST on `/blobs/{ch}`, `/blobs/{ch}/manifest`, `/receipts/{ch}`, `/observations/{ch}`, `/admin/receipts/{ch}/delete` | The gateway mounts no DELETE route on these prefixes — every attempt returns 404 / 405 / 401 |
| B — Materios L2 chain | Search runtime metadata for any extrinsic on `orinqReceipts` matching `/delete|remove|burn/i` | `pallet-orinq-receipts` defines `submit_receipt_v2`, `attest_*`, but no removal dispatchable exists — the storage is append-only by design |
| C — Cardano L1 reversal | Query the anchor tx on Blockfrost (third-party indexer) and confirm finalisation depth | Cardano transactions past finality cannot be retracted; no FPS-controlled path can re-org Cardano |

If ALL three channels report `removed=False`, the suppression-resistance
property holds for the synthetic's content hash.

## What this proves

The substrate is **append-only by construction**, not by social
convention. Even with full operator access to:

* The gateway storage (we can delete the blob — but a verifier doesn't
  need the blob to verify the anchor)
* The Materios L2 RPC (we can shut it down — but the Cardano L1 metadata
  carries the same content hash)
* The cert-daemon keys (we can refuse to certify new receipts — but
  cannot un-certify already-anchored ones)

we cannot remove an observation once it has been anchored. The Cardano
L1 metadata at label 8746 is the floor.

## Run

```bash
export OBSERVE_API_KEY=matra_...
export OBSERVER_WALLET_JSON=/abs/path/to/observer.json
export BLOCKFROST_PROJECT_ID_PREPROD=preprodXXXX...
./run.sh
```

Output: `result.json` (synthetic publication) + `removal-attempts.json`
(every channel and its response). The script exits non-zero if any
channel reports a successful removal.

## Third-party verification

Replay the suppression-resistance proof yourself:

1. Run the demo. Note the `synthetic_content_hash` and the
   `cardano_anchor_tx`.
2. Wait an hour, a day, a week — whatever you want.
3. Hit any public Cardano indexer (Blockfrost, Koios) and ask for the
   tx. The metadata label `8746` will still be there with the same
   `root` field, and the `chain` will still be the Materios genesis
   `0e46e33f639a56cc8780fd871d9a15e16d99af248526f907cb560cb40849f7bf`.
4. Independently call the gateway's `/blobs/{content_hash}/status` —
   you'll see the same `content_hash` is still indexed.

The synthetic remains discoverable through public channels FPS does
not own.

## Hermetic tests

```bash
pytest e2e-proof/03-suppression-resistance/test_suppression.py -v
```

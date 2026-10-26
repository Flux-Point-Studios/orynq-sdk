# @fluxpointstudios/orynq-sdk-anchors-cardano

Cardano L1 anchors for the Orynq SDK: Proof-of-Intent anchors under transaction metadata label 2222 (see [Verification](../../README.md#verification) in the repository README), and Materios checkpoint anchors under label 8746, which this README covers.

```bash
npm install @fluxpointstudios/orynq-sdk-anchors-cardano
```

## Materios checkpoint anchors (label 8746)

The cert-daemon rolls every certified Materios receipt into a checkpoint batch, and the anchor worker writes the batch's Merkle root and manifest hash to Cardano mainnet under label 8746 and to Materios's `OrinqReceipts.Anchors`. A batch commits to its receipts like this:

- `leaf = sha256("materios-checkpoint-v1" ‖ genesis ‖ receipt_id ‖ cert_hash)`, over the 32-byte values.
- The root is a binary SHA-256 Merkle tree over the leaves in the daemon's order. Leaves and inner nodes hash alike, and an odd last node is paired with itself, so `[a, b, c]` and `[a, b, c, c]` have the same root. Only the leaf count, which the manifest and the record both carry, tells them apart.
- `manifest_hash = sha256(json.dumps(manifest, sort_keys=True))` in Python, with its default `", "` and `": "` separators, over `{materios_chain_id, cardano_network_id, from_block, to_block, count, root}`. `cardano_network_id` is `""` on the live path, and `from_block`/`to_block` are the first and last Materios blocks holding a certification in the batch.
- `anchor_id = sha256(root ‖ manifest_hash)`.

### The record and its two encodings

Every anchor carries one logical record, with its hashes as 64 lowercase hex characters and no `0x`:

```json
{ "p": "materios", "v": 2, "chain": "<chain label>", "root": "<root>", "manifest": "<manifest_hash>", "blocks": [from, to], "leaves": count }
```

`chain` names a Materios genesis, but as a label: [it is not always the genesis the batch commits to](#the-chain-field-is-a-label).

Two encodings of it are on Cardano mainnet, as Koios renders the label's value:

| Encoding | Written by | Label 8746 value |
|---|---|---|
| detailed-schema | anchor-worker-materios, the live path: it builds the record as cardano-serialization-lib detailed-schema JSON and passes it to `add_json_metadatum`, which stores that JSON literally | `{"map": [{"k": {"string": "p"}, "v": {"string": "materios"}}, {"k": {"string": "v"}, "v": {"int": 2}}, …, {"k": {"string": "blocks"}, "v": {"list": [{"int": from}, {"int": to}]}}, {"k": {"string": "leaves"}, "v": {"int": count}}]}` |
| flat | a second, Lucid-based worker, through `attachMetadata`, from 2026-04-18 to 2026-06-29 | the record itself |

`buildMateriosAnchorV2` builds the flat form. `decodeMateriosAnchorRecord` reads both and refuses a record that mixes them, any other `p` or `v` (the Lucid-based worker's wallet also wrote a `v: 3` finality record under this label), and any missing, extra, duplicated or malformed field.

### The `chain` field is a label

`chain` is whatever the worker that wrote the record was told; anchor-worker-materios takes it from the job, else from its `MATERIOS_CHAIN_ID` setting, else from a hard-coded `5663079a…`. Nothing hashes it: the genesis a batch commits to is the one in its leaves and its manifest, which is the genesis the cert-daemon was given. In two windows, genuine anchors from the pinned wallets name another chain than that one:

| Cardano blocks (UTC) | Anchors | Written by | `chain` names | Leaves and manifest commit to |
|---|---|---|---|---|
| 13350325 to 13406781 (2026-04-28 17:07 to 2026-05-12 00:17) | 291 | the Lucid-based worker, flat | `0e46e33f639a56cc8780fd871d9a15e16d99af248526f907cb560cb40849f7bf`, the chain the receipts are on, whose anchored block ranges start again near zero on 2026-04-28 | `bc0531cb311281565036fb397a376f0e0fa37005589655f97a7924b2729a164c`, the previous chain's genesis, which the cert-daemon kept until 2026-05-12 |
| 13618944 to 13941551 (2026-06-30 23:43 to 2026-09-14 22:26) | 1672 | anchor-worker-materios, detailed-schema | `5663079a485b93fdc9e386b862b4cf8d25499427df6b8c5f018535acfd2e5020`, the worker's hard-coded fallback | `0e46e33f639a56cc8780fd871d9a15e16d99af248526f907cb560cb40849f7bf`, the chain the receipts are on |

So the verifier does not compare `chain`. The leaf and the manifest hash already commit to `genesis`, and a pinned wallet's record that carries the claim's root and manifest proves the batch, whatever its label. For a receipt the cert-daemon batched in the first window, claim `genesis` `bc0531cb…`; its dcbor-v1 Cert can also be rebuilt from `cert`: `certFormat.chainId` selects the certificate domain while `genesis` retains the historical checkpoint commitment domain.

### Verifying a receipt's anchor

```ts
import { verifyMateriosCheckpointAnchor, MATERIOS_CHECKPOINT_WALLET_PINS } from "@fluxpointstudios/orynq-sdk-anchors-cardano";
import { createKoiosCheckpointSource } from "@fluxpointstudios/orynq-sdk-anchors-cardano/providers";

const result = await verifyMateriosCheckpointAnchor(
  {
    genesis: "0e46e33f639a56cc8780fd871d9a15e16d99af248526f907cb560cb40849f7bf",
    receiptId,
    cert: { certFormat: { format: "scale-v1", chainId: null }, contentHash, baseRootSha256, storageLocatorHash },
    certifiedBlock,
    inclusion: { leafHashes: batch.leafHashes },
    manifest: { fromBlock: batch.blockRangeStart, toBlock: batch.blockRangeEnd },
    anchorId: batch.anchorId,
    cardano: { txHash: batch.cardanoTxHash },
  },
  {
    source: createKoiosCheckpointSource({ network: "mainnet" }),
    anchorWallets: MATERIOS_CHECKPOINT_WALLET_PINS, // reviewed historical windows through 2026-10-24
  },
);
if (!result.verified) console.error(result.refusal);
```

What a caller supplies:

| Input | Source |
|---|---|
| `genesis`, `receiptId` | The Materios genesis the receipt's leaf and its batch's manifest commit to, and the receipt. The genesis is that of the chain the receipt is on, except in the [window](#the-chain-field-is-a-label) in which the cert-daemon still used the previous chain's. |
| `cert`, or `certHash` | `OrinqReceipts.Receipts[receipt_id]`. With `cert`, the verifier rebuilds the availability Cert from the receipt's fields, which binds the leaf to its `content_hash`; `certHash` alone (the record's `availability_cert_hash`) leaves that binding unchecked. |
| `certifiedBlock` | The block of the receipt's first `AvailabilityCertified` event, as an events indexer reports it. |
| `inclusion` | The batch's `leafHashes`, or the leaf's `index`, the batch's `count` and the Merkle `path`. The gateway's batch record (`GET /batches/{anchorId}` or `GET /batches/by-leaf/{leaf}`) lists the leaves. |
| `manifest` | The batch's `blockRangeStart` and `blockRangeEnd`; `cardanoNetworkId` only if the daemon set `CARDANO_NETWORK_ID`. |
| `anchorId` (optional) | An anchor id to cross-check, from `OrinqReceipts.Anchors` or the batch record. |
| `cardano` | The batch record's `cardanoTxHash`, or `scanFromBlockHeight`: a Cardano block height at or below the anchor's, from which the verifier lists the pinned wallets' transactions and takes the earliest that anchors the root and passes every check. |
| `anchorWallets` | Explicit `{address, encoding, fromSlot, toSlot}` pins, with inclusive Cardano absolute-slot bounds. A bare wallet address is refused: possession of a still-live historical key must not authorize later records or another encoding. The exported historical pins cover the documented Lucid window and the detailed-schema worker through 2026-10-24; review new windows before extending them. `addr1v8jk9tqygmwd7xvf86pkz2033ahf0zrzdeesz0wy25my7xqgduf4l` funds every anchor the live path writes; `addr1qx2h3pcsp6l9lxc0nujfdrczrmmstvju024xxvjcu2ywptslud3z94x5tgw8p0aefdjm8wxwrt0j49y384nuxgsjd9xq89stdk` funded the Lucid-based worker's flat anchors. |
| `minConfirmations` (optional) | Confirmations the tx's block needs, counting that block as one. The default, 15, is the depth the gateway's L1 check calls settled; 2160, Cardano's security parameter k, gives a stronger finality margin under the consensus assumptions. The 2025-11-21 partition means 15 cannot be described as a never-rolled-back depth. |

The result names the first check that failed in `refusal`, lists every check run in `checks`, and reports the leaf, root, manifest hash, anchor id, tx, encoding, block height and confirmations it established. The checks, in order:

| Check | Refuses when |
|---|---|
| `input` | The claim or options are malformed. |
| `leaf` | The receipt's recomputed leaf is not in the claimed leaf list. |
| `root` | The path does not have the shape a tree of exactly `count` leaves gives the leaf's index (`rootFromPath`). |
| `anchor_id` | `sha256(root ‖ manifest_hash)` differs from the claimed anchor id. |
| `tx` | The tx is not in a Cardano block, or a scan finds no pinned-wallet tx anchoring the root. |
| `wallet` | The tx spends no input, an unpinned input, or uses a pinned key outside its encoding/slot window; missing slot evidence also refuses. |
| `record` | Label 8746 is absent or decodes to no `p: "materios"`, `v: 2` record. The verifier reports its `chain` label and does not compare it. |
| `anchored_root` | The record's root is not the root. |
| `leaves` | The record's leaf count is not `count`, as with `[a, b, c, c]` claimed for `[a, b, c]`. |
| `blocks` | The record's block range is not the manifest's, or does not hold `certifiedBlock`. |
| `manifest` | The record's manifest is not `manifest_hash`. |
| `confirmations` | The tx's block has fewer than `minConfirmations` confirmations. |

An anchor reaches Cardano within about an hour of certification on the live path: the cert-daemon flushes a batch every 60 minutes, or at 100 leaves, and on 2026-10-24 the time from receipt submission to the Cardano tx measured a median of 31 minutes and a maximum of 63. Until the tx lands the verifier refuses with `tx`, and until it is deep enough, with `confirmations`.

### Trust assumptions

- **The chain source.** The verifier believes what its source says about which block holds the tx, how deep that block is, what the tx spends and what metadata it carries. `createKoiosCheckpointSource` trusts the Koios operator; give it the `baseUrl` of a Koios you run to remove that trust, or pass any `MateriosCheckpointSource`.
- **The pinned wallets.** Anyone can write a label 8746 record naming any root, so a record proves something only because a wallet you pinned funded it. A wallet pin is trusted only for its explicit record encoding and inclusive slot window. An expired pin is a refusal even if the key is still used by an operator service.
- **The leaf list is off chain.** Materios stores no batch membership, so the leaf list or Merkle path comes from FPS's gateway. The anchored root makes a forged list fail, but a withheld one leaves inclusion unprovable.
- **Materios Anchors is a cross-check only.** The runtime accepts an anchor from any signed origin and never checks its id against its root and manifest, so a claimed `anchorId` is compared and nothing more.
- **Materios is not read.** The receipt's fields or cert hash are taken as the caller gives them; `verifyReceipt` in `@fluxpointstudios/orynq-sdk-anchors-materios` checks the Materios side.

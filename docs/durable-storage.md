# Long-term durable off-chain trace storage (issue #61)

An on-chain anchor proves a trace bundle with a given Merkle root existed at a
point in time — but to *audit* the trace, a verifier needs the raw bundle. Orynq
makes durable storage a first-class concern:

- `pinTraceFor()` — pin a manifest (and chunk artifacts) to multiple backends with
  redundancy (`@fluxpointstudios/orynq-sdk-storage-adapters`).
- `createS3WormAdapter()` — AWS S3 Object Lock (WORM) for regulatory-grade
  retention.
- `storageRefs[]` in anchor metadata — the trace becomes **self-locating**: a
  verifier can fetch + check the bundle from the txHash alone.
- `verifyAnchor(provider, txHash, root, { fetchBundle: true })` — auto-fetch the
  bundle from the anchor's storage refs.

## Pin with redundancy

```ts
import {
  pinTraceFor,
  createArweaveAdapter,
  createS3WormAdapter,
} from "@fluxpointstudios/orynq-sdk-storage-adapters";

const { refs } = await pinTraceFor(manifest, {
  adapters: [
    createArweaveAdapter({ wallet }),
    createS3WormAdapter({ bucket: "audit", region: "us-east-1", retentionYears: 7 }),
  ],
  redundancy: "all", // every backend must succeed
});
```

## Embed storage refs in the anchor + auto-fetch on verify

```ts
import { createAnchorEntryFromManifest, buildAnchorMetadata, verifyAnchor } from "@fluxpointstudios/orynq-sdk-anchors-cardano";

const entry = createAnchorEntryFromManifest(manifest, { storageRefs: refs });
const meta = buildAnchorMetadata(entry); // anchors[].storageRefs[] is carried on-chain

// Later, an auditor needs only the txHash:
const result = await verifyAnchor(provider, txHash, rootHash, { fetchBundle: true });
result.bundle; // fetched + integrity-checked against the anchor rootHash
```

Backward compatible: `storageRefs` is optional everywhere; old anchors (with only
`storageUri`, or neither) keep parsing and verifying.

## Cost-per-year comparison across adapters

Indicative only — confirm current pricing with each provider. Assumes a ~50 KB
compressed trace bundle, 5-year horizon.

| Adapter | Model | One-time | Recurring | 5-yr total (≈) | Best for |
| --- | --- | --- | --- | --- | --- |
| `arweaveAdapter` | pay-once, store-forever | ~$0.01–0.05 / bundle | none | ~$0.01–0.05 | 100+ yr audits; no ongoing ops |
| `s3WormAdapter` | S3 Standard + Object Lock | none | storage + requests | ~$0.01–0.10 | regulatory (COMPLIANCE mode) |
| `ipfsAdapter` | pinning service subscription | none | per-GB pin / month | depends on plan | cheap + flexible, *needs active pinning* |
| `materiosBlobAdapter` | partner-chain blob gateway | none | gateway terms | depends | uniform Materios retention semantics |

Takeaways:
- **Arweave** has the best long-horizon economics (pay once) and no "did the bill
  lapse?" risk — ideal as the durable anchor of a redundancy set.
- **S3-WORM (COMPLIANCE)** gives a regulator-recognized retention guarantee that
  even the root account can't delete before the retain-until date.
- **IPFS** is cheapest to start but is the only option whose data can *disappear*
  if pinning lapses (see below). Pair it with Arweave or S3-WORM, never alone for
  long horizons.

## Retention-bond pattern for IPFS pinning services

IPFS content is only retained while *someone pins it*. A lapsed pinning bill can
silently lose your audit trail. Mitigations:

1. **Redundancy, not reliance.** Use `pinTraceFor({ redundancy: "all" })` with at
   least one pay-once (Arweave) or WORM (S3) backend so IPFS is a fast cache, not
   the system of record.
2. **Pre-fund a retention bond.** Pre-pay the pinning service for the full audit
   horizon (e.g. 7 years) at pin time, rather than monthly — turning a recurring
   liability into a one-time cost recorded alongside the anchor.
3. **Monitor + re-pin.** Periodically `verify()` each `StorageRef`; if an IPFS pin
   is gone, re-pin from a surviving backend before it propagates out of the DHT.
4. **Record the bond reference.** Keep the pinning receipt / bond id in the
   trace metadata so an auditor can confirm retention was funded, not just claimed.

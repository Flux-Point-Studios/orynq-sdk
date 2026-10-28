/** Verify Python bundles with the actual TypeScript verifier and hash functions. */
import { verifyBundle, createBundle } from "../../packages/process-trace/src/bundle.ts";
import { computeSpanHash } from "../../packages/process-trace/src/merkle.ts";
import { computeEventHash, computeRollingHash, computeRootHash } from "../../packages/process-trace/src/rolling-hash.ts";
import { DEFAULT_EVENT_VISIBILITY } from "../../packages/process-trace/src/types.ts";
import { canonicalize } from "../../packages/core/src/utils/canonical-json.ts";
import { createHash } from "node:crypto";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const bundle = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const run = bundle.privateRun;
const eventHashes = await Promise.all(run.events.map(computeEventHash));
const spanHashes = await Promise.all(run.spans.map(span => computeSpanHash(
  span,
  span.eventIds.map(id => run.events.find(event => event.id === id))
    .sort((a, b) => a.seq - b.seq).map(event => event.hash),
)));
const rebuilt = await createBundle(run);
process.stdout.write(JSON.stringify({
  report: await verifyBundle(bundle),
  eventHashes,
  spanHashes,
  rollingHash: await computeRollingHash(run.events),
  rootHash: await computeRootHash(run.rollingHash, run.spans),
  publicView: rebuilt.publicView,
  contentHash: createHash("sha256").update(canonicalize(rebuilt.publicView)).digest("hex"),
  defaults: DEFAULT_EVENT_VISIBILITY,
  collation: new Intl.Collator().resolvedOptions().locale,
}));

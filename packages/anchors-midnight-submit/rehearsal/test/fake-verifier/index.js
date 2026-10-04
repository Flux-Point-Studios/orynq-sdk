// Stands in for the packed verify package under verify-all.mjs: answers as the W2 verifier
// does (status by severity, the failing checks by name) over the chain described in
// $FAKE_CHAIN, and appends every transaction hash it is asked about, with the source it was
// asked through, to $FAKE_LOG. KNOWN_AUTHORS is the real verifier's own code, from the build at
// $ORYNQ_VERIFY_DIST, so every document verify-all opens or forges meets the real checks.
import { appendFileSync, readFileSync } from "node:fs";

const chain = JSON.parse(readFileSync(process.env.FAKE_CHAIN, "utf8"));
const SEVERITY = ["invalid", "conflict", "unavailable", "unverified-finality", "unauthenticated", "author-revoked"];

export const { KNOWN_AUTHORS_TRUST_ROOTS, knownAuthors, openKnownAuthors, signKnownAuthors } = await import(process.env.ORYNQ_VERIFY_DIST);
export const REGISTRY_VERIFIER_KEY_SHA256 = { anchor: "85dc57a4", anchor_hiding: "081384ce" };
export const blockfrostEndpoints = (network) => ({ operator: "blockfrost", network });
export const midnightSource = (endpoints) => ({ operator: endpoints.operator, network: endpoints.network });

export async function verifyMidnightAnchor(request, options) {
  appendFileSync(process.env.FAKE_LOG, `${request.txHash} ${options.source.operator} ${options.source.network}\n`);
  const tx = chain.transactions[request.txHash];
  const failed = [];
  let author = null;
  const done = (assurance) => {
    const status = SEVERITY.find((s) => failed.some(([, severity]) => severity === s)) ?? "valid";
    return { status, assurance, txHash: request.txHash, block: tx ? { height: tx.height, hash: tx.blockHash } : null, anchor: tx?.anchor ?? null, author, verifiedFields: [], finality: null, notes: [], checks: failed.map(([name, , detail]) => ({ name, ok: false, detail: detail ?? "fake" })) };
  };
  if (!tx) {
    failed.push(["indexer", "invalid", `the indexer knows no transaction ${request.txHash}`]);
    return done("none");
  }
  if (tx.verdict) return { ...done(tx.verdict.assurance), status: tx.verdict.status };
  const registry = options.registries[0];
  if (!tx.anchor || registry.address !== chain.registry.address) {
    failed.push(["anchor", "invalid"]);
    return done("consensus-verified");
  }
  if (registry.deployHeight !== chain.registry.deployHeight) failed.push(["registry-deploy", "invalid"]);
  const { anchor } = tx;
  const expect = request.expect;
  if (expect.kind !== anchor.kind || (anchor.kind === 1 ? expect.entry.rootHash !== anchor.rootHash : expect.attribute !== anchor.attribute)) failed.push(["expectation", "invalid"]);
  const authors = options.knownAuthors;
  const skipped = options.finality === "skip";
  if (skipped || options.maxSetChanges === 0 || authors.serial === 0) failed.push(["finality", "unverified-finality"]);
  if (request.expectedAuthor !== undefined) {
    if (request.expectedAuthor !== anchor.author) failed.push(["author", "unauthenticated"]);
  } else {
    author = { ...authors.author(request.network, anchor.author, tx.height), key: anchor.author };
    if (author.status === "unknown") failed.push(["author", "unauthenticated"]);
    if (author.status === "outside-window") failed.push(["author", "author-revoked"]);
  }
  return done(skipped || failed.some(([name]) => name === "finality") ? "multi-path" : "consensus-verified");
}

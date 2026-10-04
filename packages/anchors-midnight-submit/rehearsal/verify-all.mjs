// Verifies every preprod rehearsal anchor with the W2 verifier, in a process of its own that
// installs only the packed @fluxpointstudios/orynq-sdk-anchors-midnight tarball: no wallet, no
// key, no repository. It reads through Blockfrost preprod, a different operator from the hosted
// endpoints the writes went through, and trusts only the preprod-only KNOWN_AUTHORS root.
// It exits 0 only when gate.mjs, copied beside it, finds nothing the evidence pack could not claim.
//   node verify-all.mjs EVIDENCE_DIR BLOCKFROST_PROJECT_ID_FILE > verified.json
// EVIDENCE_DIR holds raw.json, bundles.json, known-authors/, crash.log and crash.log.status.
import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { judge, parseCrashLog, parseCrashStatus, ROTATION_LABELS } from "./gate.mjs";

// The verify package must be the copy npm unpacked into this directory from the tarball. A link
// to a source tree, or a package found in a parent directory, is code this process never
// installed, so it is refused before it is loaded.
const PACKAGE = "@fluxpointstudios/orynq-sdk-anchors-midnight";
const installed = `${realpathSync(dirname(fileURLToPath(import.meta.url)))}/node_modules/`;
const resolved = realpathSync(fileURLToPath(import.meta.resolve(PACKAGE)));
if (!resolved.startsWith(installed)) {
  process.stderr.write(`verify-all: ${PACKAGE} resolves to ${resolved}, outside ${installed}: install the packed tarball into this directory\n`);
  process.exit(1);
}
const { blockfrostEndpoints, knownAuthors, midnightSource, verifyMidnightAnchor, REGISTRY_VERIFIER_KEY_SHA256 } = await import(PACKAGE);

const [dir, projectIdFile] = process.argv.slice(2);
const read = (name) => JSON.parse(readFileSync(`${dir}/${name}`, "utf8"));
const raw = read("raw.json");
const bundles = read("bundles.json");
const root = readFileSync(`${dir}/known-authors/root.pub`, "utf8").trim();
const signed = [1, 2, 3].map((n) => read(`known-authors/signed-${n}.json`)[0]);
const authorsFrom = (...serials) => knownAuthors({ documents: serials.map((n) => signed[n - 1]), trustRoots: [root] });
const source = midnightSource(blockfrostEndpoints("preprod", projectIdFile));
const registry = {
  generation: 1,
  address: raw.deploy.address,
  deployTxHash: raw.deploy.txHash,
  deployHeight: raw.deploy.blockHeight,
  runtimeSpecVersion: 1000300,
  circuits: { anchor: { vkSha256: REGISTRY_VERIFIER_KEY_SHA256.anchor }, anchor_hiding: { vkSha256: REGISTRY_VERIFIER_KEY_SHA256.anchor_hiding } },
};
const bundleOf = (label) => bundles.find((b) => b.label === label);
const expectOf = (a) => {
  const b = bundleOf(a.bundle);
  return a.kind === 1 ? { kind: 1, entry: { rootHash: b.rootHash, manifestHash: b.manifestHash, merkleRoot: b.merkleRoot } } : { kind: 2, attribute: a.attribute };
};
const summary = (r) => ({
  txHash: r.txHash,
  status: r.status,
  assurance: r.assurance,
  block: r.block,
  author: r.author && { status: r.author.status, id: r.author.id, role: r.author.role },
  verifiedFields: r.verifiedFields,
  finality: r.finality && (r.finality.finalized ? { setChanges: r.finality.setChanges, justified: r.finality.justified.height, requests: r.finality.requests } : { reason: r.finality.reason }),
  failed: r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
  notes: r.notes,
});
const verify = async (txHash, expect, options = {}, extra = {}) =>
  summary(await verifyMidnightAnchor({ network: "preprod", txHash, expect, ...extra }, { source, registries: [registry], knownAuthors: authorsFrom(1, 2, 3), ...options }));

const out = { verifier: "@fluxpointstudios/orynq-sdk-anchors-midnight (packed tarball), separate process, no wallet", source: "blockfrost preprod", trustRoot: root, anchors: {}, rotation: {}, negatives: {} };
for (const [name, a] of Object.entries(raw.anchors)) {
  if (ROTATION_LABELS.includes(name)) continue;
  out.anchors[name] = { kind: a.kind, ...(await verify(a.txHash, expectOf(a))) };
  process.stderr.write(`${name}: ${out.anchors[name].status} ${out.anchors[name].assurance}\n`);
}
const docSets = { "serial 1": [1], "serial 2": [1, 2], "serial 3": [1, 2, 3], "serial 3 with serial 1 passed again": [3, 1] };
for (const [set, serials] of Object.entries(docSets)) {
  out.rotation[set] = {};
  for (const label of ROTATION_LABELS) {
    const a = raw.anchors[label];
    const r = await verify(a.txHash, expectOf(a), { knownAuthors: authorsFrom(...serials) });
    out.rotation[set][label] = { height: a.blockHeight, author: r.author, status: r.status, assurance: r.assurance };
  }
  process.stderr.write(`${set}: ${JSON.stringify(Object.fromEntries(Object.entries(out.rotation[set]).map(([k, v]) => [k, v.status])))}\n`);
}
try {
  knownAuthors({ documents: [{ ...signed[2], signatures: [{ key: "ab".repeat(32), signature: signed[2].signatures[0].signature }] }], trustRoots: [root] });
  out.rotation.forgedSignature = "ACCEPTED";
} catch (error) {
  out.rotation.forgedSignature = `refused: ${error.message}`;
}

const k1 = Object.values(raw.anchors).find((a) => a.kind === 1 && a.bundle === "git-head");
const k2 = Object.values(raw.anchors).find((a) => a.kind === 2);
const other = bundleOf("uname");
const random = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
const negatives = {
  "kind 1 against another bundle's entry": () => verify(k1.txHash, { kind: 1, entry: { rootHash: other.rootHash, manifestHash: other.manifestHash, merkleRoot: other.merkleRoot } }),
  "kind 2 against another attribute": () => verify(k2.txHash, { kind: 2, attribute: random() }),
  "a kind-1 anchor read as kind 2": () => verify(k1.txHash, { kind: 2, attribute: k1.attribute }),
  "a stranger as the expected author": () => verify(k1.txHash, expectOf(k1), {}, { expectedAuthor: random() }),
  "a transaction hash no chain holds": () => verify(random(), expectOf(k1)),
  "the registry deploy read as an anchor": () => verify(raw.deploy.txHash, expectOf(k1)),
  "the DUST registration read as an anchor": () => verify(raw.funding.walletA.registration.txHash, expectOf(k1)),
  "finality skipped": () => verify(k1.txHash, expectOf(k1), { finality: "skip" }),
  "a registry pinned at another deploy height": () => verify(k1.txHash, expectOf(k1), { registries: [{ ...registry, deployHeight: registry.deployHeight - 1 }] }),
  "a registry at another address": () => verify(k1.txHash, expectOf(k1), { registries: [{ ...registry, address: random() }] }),
  "no KNOWN_AUTHORS document and no checkpoint": () => verify(k1.txHash, expectOf(k1), { knownAuthors: knownAuthors({ documents: [], trustRoots: [root] }) }),
  "a checkpoint too far below for a zero set-change budget": () => verify(k1.txHash, expectOf(k1), { maxSetChanges: 0 }),
};
for (const [name, run] of Object.entries(negatives)) {
  out.negatives[name] = await run();
  process.stderr.write(`negative ${name}: ${out.negatives[name].status}\n`);
}
const text = (name) => readFileSync(`${dir}/${name}`, "utf8");
out.gate = judge({ raw, verified: out, crash: parseCrashLog(text("crash.log")), crashStatus: parseCrashStatus(text("crash.log.status")) });
for (const failure of out.gate.failures) process.stderr.write(`GATE: ${failure}\n`);
console.log(JSON.stringify(out, null, 1));
process.exit(out.gate.failures.length === 0 ? 0 : 1);

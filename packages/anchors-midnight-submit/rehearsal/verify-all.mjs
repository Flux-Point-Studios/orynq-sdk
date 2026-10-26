// Verifies every preprod rehearsal anchor with the W2 verifier, in a process of its own that
// imports only the packed @fluxpointstudios/orynq-sdk-anchors-midnight tarball and gate.mjs. It
// reads through Blockfrost preprod, the operator the writes went through too, and trusts only
// the preprod-only KNOWN_AUTHORS root.
// It exits 0 only when gate.mjs, copied beside it, finds nothing the evidence pack could not claim.
//   node verify-all.mjs EVIDENCE_DIR BLOCKFROST_PROJECT_ID_FILE > verified.json
// EVIDENCE_DIR holds raw.json, bundles.json, known-authors/, crash.log and crash.log.status.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { forgeKnownAuthors, judge, parseCrashLog, parseCrashStatus, ROTATION_LABELS } from "./gate.mjs";

// The verify package must be the copy npm unpacked into this directory from a tarball that sits
// beside this script and still has the integrity npm checked when it installed it. A link to a
// source tree, a package found in a parent directory, or one npm installed from a directory is
// code no tarball pins, so it is refused before it is loaded.
const PACKAGE = "@fluxpointstudios/orynq-sdk-anchors-midnight";
const here = realpathSync(dirname(fileURLToPath(import.meta.url)));
const refuse = (why) => {
  process.stderr.write(`verify-all: ${why}\n`);
  process.exit(1);
};
const resolved = realpathSync(fileURLToPath(import.meta.resolve(PACKAGE)));
if (!resolved.startsWith(`${here}/node_modules/`)) refuse(`${PACKAGE} resolves to ${resolved}, outside ${here}/node_modules/: install the packed tarball into this directory`);
const lockFile = `${here}/package-lock.json`;
const lock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, "utf8")).packages?.[`node_modules/${PACKAGE}`] : undefined;
if (!lock) refuse(`${lockFile} records no install of ${PACKAGE}: install the packed tarball into this directory with npm`);
if (!/^file:[^/]+\.tgz$/.test(lock.resolved ?? "")) refuse(`npm installed ${PACKAGE} from ${lock.resolved}, not from a packed tarball in this directory`);
const tarballPath = `${here}/${lock.resolved.slice("file:".length)}`;
const tarball = existsSync(tarballPath) ? readFileSync(tarballPath) : null;
if (!tarball || `sha512-${createHash("sha512").update(tarball).digest("base64")}` !== lock.integrity) refuse(`${tarballPath} does not have the integrity ${lock.integrity} npm recorded when it installed ${PACKAGE}`);
const { blockfrostEndpoints, knownAuthors, midnightSource, openKnownAuthors, signKnownAuthors, verifyMidnightAnchor, KNOWN_AUTHORS_TRUST_ROOTS, REGISTRY_VERIFIER_KEY_SHA256 } = await import(PACKAGE);

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
  commitment: r.anchor?.commitment ?? null,
  author: r.author && { status: r.author.status, id: r.author.id, role: r.author.role },
  verifiedFields: r.verifiedFields,
  finality: r.finality && (r.finality.finalized ? { setChanges: r.finality.setChanges, justified: r.finality.justified.height, requests: r.finality.requests } : { reason: r.finality.reason }),
  failed: r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
  notes: r.notes,
});
const verify = async (txHash, expect, options = {}, extra = {}) =>
  summary(await verifyMidnightAnchor({ network: "preprod", txHash, expect, ...extra }, { source, registries: [registry], knownAuthors: authorsFrom(1, 2, 3), ...options }));

const out = {
  verifier: "@fluxpointstudios/orynq-sdk-anchors-midnight (packed tarball), separate process, no wallet",
  source: "blockfrost preprod",
  package: { name: PACKAGE, version: lock.version, resolved: lock.resolved, integrity: lock.integrity, sha256: createHash("sha256").update(tarball).digest("hex") },
  trustRoot: root,
  shippedTrustRoots: [...KNOWN_AUTHORS_TRUST_ROOTS],
  knownAuthorsDocuments: signed.map((s) => {
    const d = JSON.parse(s.document);
    return { serial: d.serial, networks: Object.keys(d.networks) };
  }),
  anchors: {},
  rotation: {},
  forgedDocuments: {},
  refusedTransactions: {},
  negatives: {},
};
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
    out.rotation[set][label] = { block: r.block, author: r.author, status: r.status, assurance: r.assurance };
  }
  process.stderr.write(`${set}: ${JSON.stringify(Object.fromEntries(Object.entries(out.rotation[set]).map(([k, v]) => [k, v.status])))}\n`);
}
for (const [name, { signed: forged, trustRoots }] of Object.entries(forgeKnownAuthors(signed[2], root, signKnownAuthors, crypto.getRandomValues(new Uint8Array(32))))) {
  let outcome = "opened";
  try {
    openKnownAuthors(forged, trustRoots);
  } catch (error) {
    outcome = `refused: ${error.message}`;
  }
  out.forgedDocuments[name] = { ...forged, trustRoots, outcome };
  process.stderr.write(`forged ${name}: ${outcome}\n`);
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
for (const [name, n] of Object.entries(raw.negatives ?? {})) {
  out.refusedTransactions[name] = await verify(n.txHash, expectOf(k1));
  process.stderr.write(`refused transaction ${name}: ${out.refusedTransactions[name].status}\n`);
}
const text = (name) => readFileSync(`${dir}/${name}`, "utf8");
out.gate = judge({ raw, verified: out, crash: parseCrashLog(text("crash.log")), crashStatus: parseCrashStatus(text("crash.log.status")) });
for (const failure of out.gate.failures) process.stderr.write(`GATE: ${failure}\n`);
console.log(JSON.stringify(out, null, 1));
process.exit(out.gate.failures.length === 0 ? 0 : 1);

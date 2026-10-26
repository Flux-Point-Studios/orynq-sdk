// Composes the preprod evidence pack from what the rehearsal recorded (evidence/raw.json, the
// crash drill's log and every aborted attempt archived beside it), the separate verifier's output
// (evidence/verified.json), the KNOWN_AUTHORS drill documents, the rehearsal's journals and the
// private kind-2 openings. It writes nothing unless gate.mjs passes every claim and every aborted
// attempt, every kind-2 opening recomputes the commitment the verifier read, and the scan finds
// no window of any secret the rehearsal held, in five encodings, with positive controls. Each
// statement is built only from what those checks established; README.md maps every statement to
// its check. Prints counts only.
//   node --import tsx compose.ts REHEARSAL_DIR OUT.json
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as L from "@midnight-ntwrk/ledger-v8";
import { mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { DatabaseSync } from "node:sqlite";
import { hiddenDigest, hidingCommitment, readAuthorSecret, readPrivateFile, openKnownAuthors } from "../../anchors-midnight/src/index.js";
import { windowHits } from "../../anchors-midnight/src/__tests__/privacy-scan.js";
import { abortedDrills, INVALID_TRANSACTION, judge, parseCrashLog, parseCrashStatus, ROTATION_EXPECTED, ROTATION_LABELS, unrecordedAnchors } from "./gate.mjs";
import recorded from "./wallets.json" with { type: "json" };
import { toolingCommit, installedPins } from "./tooling.js";
import { packedFiles, packedTreeIdentity } from "./evidence-integrity.mjs";

const head = toolingCommit();
const [dir, out] = process.argv.slice(2) as [string, string];
const text = (p: string) => readFileSync(`${dir}/${p}`, "utf8");
const json = (p: string) => JSON.parse(text(p));
const raw = json("evidence/raw.json");
const verified = json("evidence/verified.json");
const bundles: Array<{ label: string; kind: number; rootHash: string; manifestHash: string; merkleRoot: string }> = json("bundles/index.json");
const crash = parseCrashLog(text("evidence/crash.log"));
const crashStatus = parseCrashStatus(text("evidence/crash.log.status"));
// Each crash-drill attempt archived as aborted, every entry of its directory as the gate judges it.
const listing = (at: string) => readdirSync(at, { withFileTypes: true });
const archived = (at: string) =>
  Object.fromEntries(
    listing(at).map((f) => {
      if (!f.isFile()) return [f.name, null];
      const bytes = readFileSync(`${at}/${f.name}`);
      return [f.name, { sha256: createHash("sha256").update(bytes).digest("hex"), text: bytes.toString("utf8") }];
    }),
  );
const aborted = abortedDrills(
  listing(`${dir}/evidence`)
    .filter((e) => e.name.startsWith("crash-drill-aborted-"))
    .map((e) => ({ name: e.name, files: e.isDirectory() ? archived(`${dir}/evidence/${e.name}`) : null })),
);
const SECRETS = `${process.env.HOME}/.secrets/orynq-midnight-preprod`;

// Every transaction the rehearsal's journals saw land.
const journalLanded = readdirSync(SECRETS)
  .filter((f) => /^journal-.+\.sqlite$/.test(f))
  .flatMap((f) => {
    const db = new DatabaseSync(`${SECRETS}/${f}`, { readOnly: true });
    try {
      return db.prepare("select tx_hash from attempts where state = 'landed'").all().map((r) => r.tx_hash as string);
    } finally {
      db.close();
    }
  });
type Opening = { txHash: string; rootHash: string; manifestHash: string; merkleRoot: string; salt: string };
const openings: Record<string, Opening> = JSON.parse(readPrivateFile(`${SECRETS}/receipts.json`));
const kind2 = Object.entries(raw.anchors as Record<string, { kind: number; txHash: string; attribute: string }>).filter(([, a]) => a.kind === 2);
// Each kind-2 opening, checked here on the operator host, recomputes the commitment the verifier
// read from the chain for its anchor.
const unopened = kind2.flatMap(([name, a]) => {
  const o = openings[name];
  if (o?.txHash !== a.txHash) return [`kind-2 anchor ${name}: the private receipts hold no opening for ${a.txHash}`];
  const opened = Buffer.from(hidingCommitment(hiddenDigest(o, a.attribute), o.salt)).toString("hex");
  const read = verified.anchors[name]?.commitment;
  return opened === read ? [] : [`kind-2 anchor ${name}: its opening recomputes ${opened}, not the commitment ${read} the verifier read`];
});
const { failures, facts } = judge({ raw, verified, crash, crashStatus, head });
// Recheck evidence that can be changed between verifier and composition, rather than publishing
// unchecked JSON claims. The tarball is copied beside the evidence by finish.sh.
try {
  const tarball = readFileSync(`${dir}/evidence/verify-package.tgz`);
  if (createHash("sha256").update(tarball).digest("hex") !== verified.package.sha256 || `sha512-${createHash("sha512").update(tarball).digest("base64")}` !== verified.package.integrity) throw new Error("tarball hashes differ");
  if (JSON.stringify(packedTreeIdentity(tarball)) !== JSON.stringify(verified.package.installedTree)) throw new Error("installed tree fingerprint differs");
  const manifest = JSON.parse((packedFiles(tarball).get("package.json") as Buffer).toString("utf8"));
  if (manifest.name !== verified.package.name || manifest.version !== verified.package.version) throw new Error("tarball manifest differs");
} catch { failures.push("the verifier package tarball is absent or differs from the verified identity"); }
try {
  const documents = [1, 2, 3].map(n => json(`evidence/known-authors/signed-${n}.json`)[0]);
  documents.forEach((signed, i) => {
    const opened = openKnownAuthors(signed, [verified.trustRoot]);
    if (opened.serial !== i + 1 || JSON.stringify(Object.keys(JSON.parse(signed.document).networks)) !== '["preprod"]') throw new Error("document mismatch");
  });
  const serial3 = documents[2];
  const reopened = JSON.parse(serial3.document);
  for (const network of Object.values(reopened.networks) as Array<{ authors: Array<{validTo: unknown}> }>) for (const author of network.authors) author.validTo = null;
  const expected = `${JSON.stringify(reopened, null, 2)}\n`;
  if (expected === serial3.document) throw new Error("no closed window was forged");
  if (JSON.stringify(raw.pins) !== JSON.stringify(installedPins())) throw new Error("installed pins differ from writer");
  const forged = verified.forgedDocuments;
  const rootNames = ["serial 3 with every author window reopened, under the trust root's signature on serial 3", "that document signed by a stranger, under the trust root's key"] as const;
  const third = forged["that document signed by a stranger, under the stranger's key"], control = forged["positive control: that document signed by a stranger, with the stranger as the trust root"];
  for (const f of Object.values(forged) as any[]) if (f.document !== expected) throw new Error("forged document shape differs");
  if (JSON.stringify(forged[rootNames[0]].signatures) !== JSON.stringify(serial3.signatures)) throw new Error("original signature differs");
  if (forged[rootNames[1]].signatures.length !== 1 || forged[rootNames[1]].signatures[0].key !== verified.trustRoot || forged[rootNames[1]].signatures[0].signature !== third.signatures[0].signature) throw new Error("forged root-key binding differs");
  if (JSON.stringify(third.signatures) !== JSON.stringify(control.signatures) || third.signatures.length !== 1 || third.signatures[0].key === verified.trustRoot || JSON.stringify(control.trustRoots) !== JSON.stringify([third.signatures[0].key])) throw new Error("stranger control differs");
  for (const name of [...rootNames, "that document signed by a stranger, under the stranger's key"]) if (JSON.stringify(forged[name].trustRoots) !== JSON.stringify([verified.trustRoot])) throw new Error("forgery trust root differs");
  openKnownAuthors(control, control.trustRoots);
} catch { failures.push("published KNOWN_AUTHORS documents or forgery controls do not match their signed evidence"); }
for (const [name, negative] of Object.entries(raw.negatives ?? {}) as Array<[string, any]>) {
  try {
    const tx = L.Transaction.deserialize("signature", "proof", "binding", Buffer.from(negative.bytes, "hex"));
    const actions = [...(tx.intents?.values() ?? [])].flatMap(intent => intent.actions);
    if (tx.transactionHash() !== negative.txHash || actions.length !== 1 || !(actions[0] instanceof L.MaintenanceUpdate) || String(actions[0].address) !== raw.deploy.address || negative.address !== raw.deploy.address) throw new Error("negative transaction binding differs");
    const update = actions[0], [change] = update.updates;
    if (update.counter !== 0n || update.updates.length !== 1) throw new Error("maintenance counter or update count differs");
    if (name === "ReplaceAuthority, unsigned") {
      if (!(change instanceof L.ReplaceAuthority) || change.authority.committee.length !== 0 || change.authority.threshold !== 0 || change.authority.counter !== 1n || update.signatures.length !== 0) throw new Error("unsigned authority update differs");
    } else {
      if (update.signatures.length !== 1 || update.signatures[0]![0] !== 0n) throw new Error("stranger signature index differs");
      if (name.startsWith("VerifierKeyRemove") ? !(change instanceof L.VerifierKeyRemove) || change.operation !== "anchor" : !(change instanceof L.VerifierKeyInsert) || change.operation !== "rewrite") throw new Error("verifier-key operation differs");
    }
  } catch { failures.push(`negative ${name}: serialized bytes do not bind the recorded transaction and deployed update address`); }
}
if (bundles.some((bundle: any) => bundle.toolingCommit !== head)) failures.push("rehearsal bundles were not traced at the composing commit");
failures.push(...unrecordedAnchors(raw, journalLanded), ...unopened, ...aborted.failures);
if (failures.length) {
  for (const failure of failures) process.stderr.write(`GATE: ${failure}\n`);
  process.stderr.write(`no pack written: ${failures.length} claims are not established\n`);
  process.exit(1);
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
};
const anchors = Object.entries(raw.anchors as Record<string, any>).map(([name, a]) => {
  const b = bundles.find((x) => x.label === a.bundle);
  return {
    name,
    kind: a.kind,
    txHash: a.txHash,
    blockHeight: a.blockHeight,
    blockHash: a.blockHash,
    wallet: a.wallet,
    commitment: a.commitment,
    attribute: a.attribute,
    author: a.author,
    ...(a.kind === 1 && b ? { entry: { rootHash: b.rootHash, manifestHash: b.manifestHash, merkleRoot: b.merkleRoot }, bundle: a.bundle } : { bundle: a.bundle }),
    ...(a.drill ? { drill: a.drill } : {}),
    proveMs: a.proveMs,
    payFeeMs: a.payFeeMs,
    submitToIndexedMs: a.landedAfterMs,
    declaredFeeSpeck: a.declaredFee,
    finalBytes: a.bytes,
    verifier: ROTATION_LABELS.includes(name) ? { documents: "serial 3", ...verified.rotation["serial 3"][name] } : verified.anchors[name],
  };
});
const timed = (kind: number, field: string) => anchors.filter((a) => a.kind === kind && typeof (a as any)[field] === "number").map((a) => (a as any)[field] as number);
const stats = (xs: number[]) => (xs.length ? { n: xs.length, p50: quantile(xs, 0.5), p95: quantile(xs, 0.95), max: Math.max(...xs) } : null);
const fees = anchors.map((a) => BigInt(a.declaredFeeSpeck ?? 0));

const { anchors: counted, crashDrill, nodeNegatives, forgedDocuments, verifierNegatives, anchorRefusals } = facts;
const sameBlock = facts.sameBlock!;
const rotation = Object.entries(ROTATION_EXPECTED as Record<string, Record<string, string>>)
  .map(([set, want]) => `${set}: ${ROTATION_LABELS.map((l: string) => `${l} ${want[l]}`).join(", ")}`)
  .join("; ");
const refusals = nodeNegatives.map((n) => `${n.name}: ${n.refusal.data}, ${n.refusedBy}`).join("; ");
const windows = crashDrill.map((d) =>
  d.mode === "kill-before"
    ? `once after the journal row was written and before the bytes went to the node (crash.ts logged "${d.said}", and the restart broadcast those bytes once)`
    : `once after the node accepted the bytes (crash.ts logged "${d.said}", and the restart broadcast nothing)`,
);
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const inWords = (xs: unknown[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : String(xs[0]));
const attempts = aborted.attempts.map(
  (a) => `${a.archive}, whose ${count(a.steps.length, "step")} exited ${inWords(a.steps.map((s) => s.exit))}, none of them at a kill point, and whose crash journal held no row in any of its ${count(a.log.length, "logged event")}`,
);
const abortedStatement = attempts.length
  ? [`Before that drill, ${count(attempts.length, "earlier attempt")} aborted before any kill point, and journalCrashDrill.abortedAttempts discloses ${attempts.length === 1 ? "it" : "each"} with each archived file's sha256, which its MANIFEST.sha256 records: ${attempts.join("; ")}.`]
  : [];
const refusalStatement = anchorRefusals.length
  ? [
      `The node refused ${count(anchorRefusals.length, "anchor transaction")} when it was submitted, which run.ts recorded as the node answered (${anchorRefusals.map((r) => `${r.label}: ${r.txHash}, ${r.code} ${typeof r.data === "string" ? r.data : JSON.stringify(r.data)}, at ${r.at}`).join("; ")}), and a later transaction for the same label landed: the anchor the pack records and the verifier checked for it (${anchorRefusals.map((r) => `${r.label}: ${r.landedAs}`).join("; ")}).`,
    ]
  : [];
const statements = [
  `All ${counted.total} anchors this rehearsal wrote outside the rotation drill, ${counted.total} distinct transactions (${counted.byKind[1]} kind 1, ${counted.byKind[2]} kind 2) with the ${counted.crash} crash-drill anchors and the same-block pair among them, verified valid at consensus-verified assurance, each with the commitment the rehearsal recorded.`,
  `The verifier ran in verify-all.mjs, a separate process that imports nothing but Node built-ins, gate.mjs, evidence-integrity.mjs and the verify package, and reads through Blockfrost preprod. It loaded the verify package only from its own node_modules, where npm installed it from ${facts.package!.resolved} (sha256 ${facts.package!.sha256}), a tarball that still had the integrity npm recorded and whose file tree matched every installed package file.`,
  "Every transaction the rehearsal's journals recorded as landed, other than the registry deploy, is one of these anchors or one of the rotation drill's four, and every recorded anchor is in a journal as landed.",
  ...refusalStatement,
  `The rehearsal submitted ${sameBlock.anchors[0]} from ${sameBlock.wallets[0]} and ${sameBlock.anchors[1]} from ${sameBlock.wallets[1]} in round ${sameBlock.round}, and the verifier places both in block ${sameBlock.height} (${sameBlock.hash}).`,
  `The four rotation-drill anchors gave the expected verdict under each set of KNOWN_AUTHORS documents (${rotation}).`,
  `The verify package answered each forged KNOWN_AUTHORS document as the gate requires (${forgedDocuments.map((f) => `${f.name}: ${f.outcome}`).join("; ")}). Ed25519 verification refused both forgeries under the trust root's key, and the same document opened under the stranger's signature with the stranger as trust root.`,
  `Blockfrost's preprod node answered each of the ${nodeNegatives.length} maintenance transactions at submission with JSON-RPC error ${INVALID_TRANSACTION} "Invalid Transaction" and the maintenance authority's own custom code (${refusals}). Blockfrost's indexer lists none of them, asked by the rehearsal after each refusal and by the verifier, and the registry state Blockfrost's node reported afterwards still passes the immutability check.`,
  `The journal crash drill killed the submitter with SIGKILL (exit 137) ${windows.join(", and ")}; each restart landed exactly the transaction its journal held.`,
  ...abortedStatement,
  `Each of the ${verifierNegatives} verifier negatives returned its expected status from its expected check.`,
  `The operator's private receipts hold an opening (root, manifest, merkle, salt) for each of the ${kind2.length} kind-2 anchors, and each recomputes the commitment the verifier read for its anchor. None of them is in this pack: the scan below finds no 8-byte window of any of them in five encodings, and finds windows of the salts and root hashes in the receipts.`,
  `The KNOWN_AUTHORS documents here are signed by trust root ${facts.trustRoot}, which is not among the trust roots the verify package ships, and each names only the preprod network.`,
];

const pack = {
  format: "orynq-midnight-evidence/v1",
  network: "preprod",
  purpose: "Every write recorded here was found on preprod by the separate verifier",
  date: new Date().toISOString(),
  commit: head,
  chain: raw.chain,
  pins: { ...installedPins(), verifierKeys: verified.verifierKeys },
  wallets: { A: recorded.walletA.addresses, B: recorded.walletB.addresses },
  funding: raw.funding,
  registry: {
    address: raw.deploy.address,
    deployTxHash: raw.deploy.txHash,
    deployHeight: raw.deploy.blockHeight,
    deployBlockHash: raw.deploy.blockHash,
    preparedOnFinalBytes: raw.deploy.prepared,
    readback: raw.deploy.readback,
    landedAfterMs: raw.deploy.landedAfterMs ?? { absent: "resumed in another process" },
    prepareMs: raw.deploy.prepared.prepareMs ?? { absent: "resumed in another process" },
    dustSpeck: { before: raw.deploy.dustBefore ?? { absent: "resumed in another process" }, after: raw.deploy.dustAfter ?? { absent: "wallet sync interrupted after landing" } },
  },
  anchors,
  ...(anchorRefusals.length ? { anchorRefusals } : {}),
  sameBlock: { ...raw.sameBlock, anchors: sameBlock.anchors, verifiedBlock: { height: sameBlock.height, hash: sameBlock.hash } },
  nodeEnforcedNegatives: nodeNegatives.map((n) => ({ name: n.name, txHash: n.txHash, bytes: raw.negatives[n.name].bytes, address: raw.negatives[n.name].address, operator: raw.negatives[n.name].operator, refusal: n.refusal, refusedBy: n.refusedBy, onChain: 0, blockfrost: verified.refusedTransactions[n.name] })),
  registryAfterNegatives: raw.negativesAfter,
  knownAuthorsDrill: {
    trustRoot: verified.trustRoot,
    keys: raw.rotation.keys,
    documents: [1, 2, 3].map((n) => json(`evidence/known-authors/signed-${n}.json`)[0]),
    expected: ROTATION_EXPECTED,
    verdicts: verified.rotation,
    forgedDocuments: verified.forgedDocuments,
    shippedTrustRoots: verified.shippedTrustRoots,
  },
  journalCrashDrill: { windows: crashDrill, steps: crashStatus, log: crash, ...(aborted.attempts.length ? { abortedAttempts: aborted.attempts } : {}) },
  verifierNegatives: verified.negatives,
  verifier: { process: verified.verifier, source: verified.source, package: verified.package },
  measurements: {
    declaredFeeSpeck: { perTransaction: [...new Set(fees.map(String))], total: String(fees.reduce((s, f) => s + f, 0n)), deploy: raw.deploy.prepared.declaredFee },
    proveMs: { kind1: stats(timed(1, "proveMs")), kind2: stats(timed(2, "proveMs")) },
    payFeeMs: { kind1: stats(timed(1, "payFeeMs")), kind2: stats(timed(2, "payFeeMs")) },
    submitToIndexedMs: { kind1: stats(timed(1, "submitToIndexedMs")), kind2: stats(timed(2, "submitToIndexedMs")) },
  },
  statements,
};
const body = `${JSON.stringify(pack, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1)}\n`;

// Every secret the rehearsal held, and the private receipts that must hold the openings.
const hex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const mnemonic = (name: string) => {
  try { return mnemonicToEntropy(readPrivateFile(`${SECRETS}/${name}`).trim(), wordlist); }
  catch { throw new Error(`Invalid rehearsal wallet mnemonic in ${name}`); }
};
const projectId = readPrivateFile(`${process.env.HOME}/.secrets/blockfrost-midnight-preprod.project_id`).trim();
if (!/^[a-z]{1,32}[A-Za-z0-9]{32}$/.test(projectId)) throw new Error("Invalid rehearsal Blockfrost project id");
const projectSecret = projectId.slice(-32);
const secrets: Array<[string, Uint8Array]> = [
  ["blockfrost project-id suffix", /^[0-9a-f]{32}$/i.test(projectSecret) ? hex(projectSecret) : new Uint8Array(Buffer.from(projectSecret))],
  ["wallet-a mnemonic entropy", mnemonic("wallet-a.mnemonic")],
  ["wallet-b mnemonic entropy", mnemonic("wallet-b.mnemonic")],
  ["author-relay.key", readAuthorSecret(`${SECRETS}/author-relay.key`)],
  ["author-relay-2.key", readAuthorSecret(`${SECRETS}/author-relay-2.key`)],
  ["salt.key", readAuthorSecret(`${SECRETS}/salt.key`)],
  ["known-authors-root.seed", hex(readPrivateFile(`${SECRETS}/known-authors-root.seed`))],
  ...Object.entries(openings).flatMap(([label, o]) => (["rootHash", "manifestHash", "merkleRoot", "salt"] as const).map((f): [string, Uint8Array] => [`${label}.${f}`, hex(o[f])])),
];
const bytes = new Uint8Array(Buffer.from(body));
const receipts = new Uint8Array(Buffer.from(readPrivateFile(`${SECRETS}/receipts.json`)));
const scan = {
  secretsScanned: secrets.length,
  windowsOfSecretsInPack: secrets.reduce((s, [, v]) => s + windowHits(bytes, v), 0) + (body.includes(projectId) ? 1 : 0),
  positiveControls: {
    openingWindowsInPrivateReceipts: Object.entries(openings).flatMap(([, o]) => [o.salt, o.rootHash]).reduce((s, v) => s + windowHits(receipts, hex(v)), 0),
    attributeWindowsInPack: anchors.filter((a) => a.kind === 2).reduce((s, a) => s + windowHits(bytes, hex(a.attribute)), 0),
  },
};
console.log(JSON.stringify(scan));
if (scan.windowsOfSecretsInPack !== 0 || scan.positiveControls.openingWindowsInPrivateReceipts === 0 || scan.positiveControls.attributeWindowsInPack === 0) {
  process.stderr.write("no pack written: the privacy scan failed\n");
  process.exit(1);
}
writeFileSync(out, body.replace(/\n$/, "").replace(/\}$/, `,\n "privacyScan": ${JSON.stringify(scan)}\n}\n`));

// Composes the preprod evidence pack from what the rehearsal recorded (evidence/raw.json, the
// crash drill's log), the separate verifier's output (evidence/verified.json), the KNOWN_AUTHORS
// drill documents and the rehearsal's journals. It writes nothing unless gate.mjs passes every
// claim and the scan finds no window of any secret the rehearsal held, in five encodings, with
// positive controls; each statement is built from what the gate established. Prints counts only.
//   node --import tsx compose.ts REHEARSAL_DIR OUT.json
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readAuthorSecret, readPrivateFile, REGISTRY_VERIFIER_KEY_SHA256 } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { windowHits } from "../../anchors-midnight/src/__tests__/privacy-scan.js";
import { INVALID_TRANSACTION, judge, parseCrashLog, parseCrashStatus, ROTATION_EXPECTED, ROTATION_LABELS, unrecordedAnchors } from "./gate.mjs";
import recorded from "./wallets.json" with { type: "json" };

const [dir, out] = process.argv.slice(2) as [string, string];
const text = (p: string) => readFileSync(`${dir}/${p}`, "utf8");
const json = (p: string) => JSON.parse(text(p));
const raw = json("evidence/raw.json");
const verified = json("evidence/verified.json");
const bundles: Array<{ label: string; kind: number; rootHash: string; manifestHash: string; merkleRoot: string }> = json("bundles/index.json");
const crash = parseCrashLog(text("evidence/crash.log"));
const crashStatus = parseCrashStatus(text("evidence/crash.log.status"));
const SECRETS = `${process.env.HOME}/.secrets/orynq-midnight-preprod`;
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: new URL(".", import.meta.url), encoding: "utf8" }).trim();

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
const { failures, facts } = judge({ raw, verified, crash, crashStatus });
failures.push(...unrecordedAnchors(raw, journalLanded));
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

const { anchors: counted, crashDrill, nodeNegatives } = facts;
const sameBlock: { height: number; anchors: string[] } = facts.sameBlock!;
const rotation = Object.entries(ROTATION_EXPECTED as Record<string, Record<string, string>>)
  .map(([set, want]) => `${set}: ${ROTATION_LABELS.map((l: string) => `${l} ${want[l]}`).join(", ")}`)
  .join("; ");
const refusals = nodeNegatives.map((n: { name: string; data: string; refusedBy: string }) => `${n.name}: ${n.data}, ${n.refusedBy}`).join("; ");
const windows = crashDrill.map((d: { mode: string }) =>
  d.mode === "kill-before" ? "once after its journal row was written and before any byte was broadcast (the restart broadcast those bytes once)" : "once after the node had accepted the bytes (the restart broadcast nothing)",
);
const statements = [
  `All ${counted.total} anchors this rehearsal wrote outside the rotation drill (${counted.byKind[1]} kind 1, ${counted.byKind[2]} kind 2), the ${counted.crash} crash-drill anchors and the same-block pair among them, verified valid at consensus-verified assurance with the W2 verifier, run in a separate process that installed only the packed verify package (no wallet, no key, no repository) and read through Blockfrost preprod, while every write went through Midnight's hosted preprod endpoints. Every transaction the rehearsal's journals saw land, other than the registry deploy, is one of these anchors or one of the rotation drill's four.`,
  `Wallets A and B each wrote one of these anchors into block ${sameBlock.height} (${sameBlock.anchors.join(" and ")}).`,
  `The four rotation-drill anchors gave the expected verdict under each set of KNOWN_AUTHORS documents (${rotation}), and a document with a forged signature was refused.`,
  `The node refused each of the ${nodeNegatives.length} maintenance transactions at submission with its own JSON-RPC answer ${INVALID_TRANSACTION} Invalid Transaction and the maintenance authority's own custom code (${refusals}); the indexer lists none of them, and the registry state the node reported afterwards still passes the immutability check.`,
  `The journal crash drill killed the submitter with SIGKILL ${windows.join(", and ")}; each restart landed exactly the transaction its journal held.`,
  `Each of the ${facts.verifierNegatives} verifier negatives returned its expected status from its expected check.`,
  "Kind-2 openings (root, manifest, merkle, salt) were checked privately on the operator host and are not in this pack; the scan below finds no window of any of them.",
  "The KNOWN_AUTHORS documents here are signed with a preprod-only trust-root key generated for this drill; they are not the mainnet trust root.",
];

const pack = {
  format: "orynq-midnight-evidence/v1",
  network: "preprod",
  purpose: "W3 preprod rehearsal of @fluxpointstudios/orynq-sdk-anchors-midnight-submit: test tokens only, no mainnet write",
  date: new Date().toISOString(),
  commit: head,
  chain: raw.chain,
  pins: { compactc: "0.31.1", ledger: "@midnight-ntwrk/ledger-v8 8.1.3", walletSdk: "1.2.0 (facade 4.1.0, dust-wallet 4.2.0)", zkir: "2.1.1", verifierKeys: REGISTRY_VERIFIER_KEY_SHA256 },
  wallets: { A: recorded.walletA.addresses, B: recorded.walletB.addresses },
  funding: raw.funding,
  registry: {
    address: raw.deploy.address,
    deployTxHash: raw.deploy.txHash,
    deployHeight: raw.deploy.blockHeight,
    deployBlockHash: raw.deploy.blockHash,
    preparedOnFinalBytes: raw.deploy.prepared,
    readback: raw.deploy.readback,
    landedAfterMs: raw.deploy.landedAfterMs,
    dustSpeck: { before: raw.deploy.dustBefore, after: raw.deploy.dustAfter },
  },
  anchors,
  sameBlock: { ...raw.sameBlock, anchors: sameBlock.anchors },
  nodeEnforcedNegatives: nodeNegatives.map((n: { name: string; txHash: string; code: number; message: string; data: string; refusedBy: string }) => ({ name: n.name, txHash: n.txHash, refusal: { code: n.code, message: n.message, data: n.data }, refusedBy: n.refusedBy, onChain: 0 })),
  registryAfterNegatives: raw.negativesAfter,
  knownAuthorsDrill: {
    trustRoot: verified.trustRoot,
    keys: raw.rotation.keys,
    documents: [1, 2, 3].map((n) => json(`evidence/known-authors/signed-${n}.json`)[0]),
    expected: ROTATION_EXPECTED,
    verdicts: verified.rotation,
  },
  journalCrashDrill: { windows: crashDrill, steps: crashStatus, log: crash },
  verifierNegatives: verified.negatives,
  verifier: { process: verified.verifier, source: verified.source },
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
const openings: Record<string, { rootHash: string; manifestHash: string; merkleRoot: string; salt: string }> = JSON.parse(readPrivateFile(`${SECRETS}/receipts.json`));
const secrets: Array<[string, Uint8Array]> = [
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
  windowsOfSecretsInPack: secrets.reduce((s, [, v]) => s + windowHits(bytes, v), 0),
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

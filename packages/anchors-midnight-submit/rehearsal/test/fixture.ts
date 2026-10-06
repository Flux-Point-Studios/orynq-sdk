// A complete, honest preprod rehearsal as its files would hold it, with fresh random hashes:
// what run.ts and crash.ts record, what verify-all.mjs returns, the journals, the drill's
// KNOWN_AUTHORS documents (signed by a fresh Ed25519 trust root), the kind-2 openings and the
// 0600 secrets compose.ts scans for. Tests break one thing.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { hiddenDigest, hidingCommitment } from "../../../anchors-midnight/src/commitment.js";
import { ed25519PublicKey } from "../../../anchors-midnight/src/ed25519.js";
import { signKnownAuthors } from "../../../anchors-midnight/src/known-authors.js";

const h = () => randomBytes(32).toString("hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
// The built verify package, whose KNOWN_AUTHORS code the stand-in verify package runs.
export const VERIFY_DIST = new URL("../../../anchors-midnight/dist/index.js", import.meta.url).pathname;

// Every directory a test makes lives under the rehearsal's own .tmp and is removed after its file.
const made: string[] = [];
export function scratch(prefix: string) {
  const parent = new URL("../.tmp/", import.meta.url).pathname;
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(`${parent}${prefix}-`);
  made.push(dir);
  return dir;
}
export const removeScratch = () => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
};
const DEPLOY = 1000;

type Anchor = Record<string, any>;
export interface Rehearsal {
  raw: Record<string, any>;
  verified: Record<string, any>;
  crash: Array<Record<string, any>>;
  crashStatus: string[];
  bundles: Array<Record<string, any>>;
  journals: Record<string, Array<{ tx_hash: string; state: string }>>;
  documents: Array<{ document: string; signatures: Array<{ key: string; signature: string }> }>;
  root: string;
  rootSeed: string;
  openings: Record<string, { txHash: string; rootHash: string; manifestHash: string; merkleRoot: string; salt: string }>;
}

export function honestRehearsal(): Rehearsal {
  const keys = { relay1: h(), relay2: h() };
  const bundles: Array<Record<string, any>> = [];
  const anchors: Record<string, Anchor> = {};
  const openings: Rehearsal["openings"] = {};
  const anchor = (name: string, kind: 1 | 2, height: number, wallet = "walletA", author = keys.relay1, extra: Anchor = {}) => {
    const bundle = { label: name, kind, exit: 0, rootHash: h(), manifestHash: h(), merkleRoot: h(), modelManifestHash: h() };
    bundles.push(bundle);
    const txHash = h();
    let commitment = h();
    if (kind === 2) {
      const salt = h();
      openings[name] = { txHash, rootHash: bundle.rootHash, manifestHash: bundle.manifestHash, merkleRoot: bundle.merkleRoot, salt };
      commitment = hex(hidingCommitment(hiddenDigest(bundle, bundle.modelManifestHash), salt));
    }
    anchors[name] = {
      txHash,
      blockHeight: height,
      blockHash: h(),
      kind,
      commitment,
      attribute: kind === 2 ? bundle.modelManifestHash : "00".repeat(32),
      author,
      wallet,
      proveMs: 20_000 + height,
      payFeeMs: 900,
      declaredFee: "310000000000000",
      bytes: 9000,
      submittedAt: 1_759_600_000_000 + height,
      landedAfterMs: 18_000,
      bundle: name,
      ...extra,
    };
  };
  ["git-head", "contract-hashes", "compactc-version", "zk-material", "preprod-chain", "preprod-runtime", "preprod-ledger", "git-log", "commitment-suite", "node-version", "pnpm-lock-midnight", "uname"].forEach((l, i) => anchor(l, 1, 1010 + i));
  ["hidden-broadcast-suite", "hidden-relay-suite", "hidden-keys-suite"].forEach((l, i) => anchor(l, 2, 1030 + i));
  anchor("same-block-a-1", 1, 1040, "walletA", keys.relay1, { round: 1 });
  anchor("same-block-b-1", 1, 1040, "walletB", keys.relay1, { round: 1, blockHash: anchors["same-block-a-1"]!.blockHash });
  anchor("crash-before-broadcast", 1, 1050, "walletA", keys.relay1, { drill: "journal crash window" });
  anchor("crash-after-broadcast", 1, 1052, "walletA", keys.relay1, { drill: "journal crash window" });
  anchor("rotation-old-before", 1, 1060);
  anchor("rotation-old-after", 1, 1062);
  anchor("rotation-new-after", 1, 1064, "walletA", keys.relay2);
  anchor("revoked-new-after", 1, 1066, "walletA", keys.relay2);

  // midnight-node's custom codes for the maintenance authority's own refusals: 136 ThresholdMissed
  // for an unsigned update, 134 KeyNotInCommittee for a signature at index 0 of an empty committee.
  const refusal = (custom: number) => ({ code: 1010, message: "Invalid Transaction", data: `Custom error: ${custom}` });
  const [deployAddress, deployTxHash] = [h(), h()];
  const raw = {
    chain: { hosted: { chain: "Midnight Preprod", specVersion: 1000300 } },
    funding: { walletA: { registration: { txHash: h() } }, walletB: { registration: { txHash: h() } } },
    deploy: {
      address: deployAddress,
      txHash: deployTxHash,
      blockHeight: DEPLOY,
      blockHash: h(),
      prepared: { address: deployAddress, txHash: deployTxHash, declaredFee: "420000000000000" },
      readback: { indexerStateBytes: 4000, nodeStateBytes: 4000, byteEqual: true, immutable: true },
      landedAfterMs: 20_000,
      dustBefore: "9",
      dustAfter: "8",
    },
    anchors,
    sameBlock: { rounds: [{ round: 1 }], coLanded: { round: 1, height: 1040, blockHash: anchors["same-block-a-1"]!.blockHash, txHashes: [anchors["same-block-a-1"]!.txHash, anchors["same-block-b-1"]!.txHash] } },
    negatives: {
      "ReplaceAuthority, unsigned": { txHash: h(), rejected: true, by: "node author_submitExtrinsic", refusal: refusal(136), onChain: 0 },
      "VerifierKeyRemove(anchor), signed by a stranger at index 0": { txHash: h(), rejected: true, by: "node author_submitExtrinsic", refusal: refusal(134), onChain: 0 },
      "VerifierKeyInsert(rewrite), signed by a stranger at index 0": { txHash: h(), rejected: true, by: "node author_submitExtrinsic", refusal: refusal(134), onChain: 0 },
    },
    negativesAfter: { registryStillImmutable: true, checkedAt: "2026-10-05T00:00:00.000Z" },
    rotation: { keys },
  };

  const rootSeed = randomBytes(32);
  const root = hex(ed25519PublicKey(rootSeed));
  const relay = (key: string, id: string, validFrom: number, validTo: number | null) => ({ key, id, role: "relay", validFrom, validTo });
  const rotatedAt = anchors["rotation-old-before"]!.blockHeight;
  const revokedAt = anchors["rotation-new-after"]!.blockHeight;
  const documents = [
    [relay(keys.relay1, "fluxpoint-relay-preprod-1", DEPLOY, null)],
    [relay(keys.relay1, "fluxpoint-relay-preprod-1", DEPLOY, rotatedAt), relay(keys.relay2, "fluxpoint-relay-preprod-2", rotatedAt + 1, null)],
    [relay(keys.relay1, "fluxpoint-relay-preprod-1", DEPLOY, rotatedAt), relay(keys.relay2, "fluxpoint-relay-preprod-2", rotatedAt + 1, revokedAt)],
  ].map((authors, i) => signKnownAuthors(`${JSON.stringify({ format: "orynq-known-authors/v1", serial: i + 1, issued: "2026-10-05T00:00:00.000Z", networks: { preprod: { authors, checkpoints: [] } } }, null, 2)}\n`, rootSeed));

  const rotation = ["rotation-old-before", "rotation-old-after", "rotation-new-after", "revoked-new-after"];
  const valid = (a: Anchor) => ({ txHash: a.txHash, kind: a.kind, status: "valid", assurance: "consensus-verified", block: { height: a.blockHeight, hash: a.blockHash }, commitment: a.commitment, author: { status: "known", id: "fluxpoint-relay-preprod-1", role: "relay" }, verifiedFields: a.kind === 1 ? ["rootHash", "manifestHash", "merkleRoot"] : ["committedAttribute"], finality: { setChanges: 3, justified: a.blockHeight + 2, requests: 4 }, failed: [], notes: [] });
  const matrix: Record<string, Record<string, string>> = {
    "serial 1": { "rotation-old-before": "valid", "rotation-old-after": "valid", "rotation-new-after": "unauthenticated", "revoked-new-after": "unauthenticated" },
    "serial 2": { "rotation-old-before": "valid", "rotation-old-after": "author-revoked", "rotation-new-after": "valid", "revoked-new-after": "valid" },
    "serial 3": { "rotation-old-before": "valid", "rotation-old-after": "author-revoked", "rotation-new-after": "valid", "revoked-new-after": "author-revoked" },
    "serial 3 with serial 1 passed again": { "rotation-old-before": "valid", "rotation-old-after": "author-revoked", "rotation-new-after": "valid", "revoked-new-after": "author-revoked" },
  };
  const negative = (status: string, assurance: string, ...failed: string[]) => ({ status, assurance, block: null, commitment: null, author: null, verifiedFields: [], finality: null, failed: failed.map((c) => `${c}: as recorded`), notes: [] });
  const signatureFails = "refused: the known-authors document's signature by a trust root does not verify";
  const tarball = randomBytes(64);
  const verified = {
    verifier: "@fluxpointstudios/orynq-sdk-anchors-midnight (packed tarball), separate process, no wallet",
    source: "blockfrost preprod",
    package: {
      name: "@fluxpointstudios/orynq-sdk-anchors-midnight",
      version: "0.1.0",
      resolved: "file:fluxpointstudios-orynq-sdk-anchors-midnight-0.1.0.tgz",
      integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
      sha256: createHash("sha256").update(tarball).digest("hex"),
    },
    trustRoot: root,
    shippedTrustRoots: [],
    knownAuthorsDocuments: [1, 2, 3].map((serial) => ({ serial, networks: ["preprod"] })),
    anchors: Object.fromEntries(Object.entries(anchors).filter(([n]) => !rotation.includes(n)).map(([n, a]) => [n, valid(a)])),
    rotation: Object.fromEntries(Object.entries(matrix).map(([set, want]) => [set, Object.fromEntries(Object.entries(want).map(([label, status]) => [label, { block: { height: anchors[label]!.blockHeight, hash: anchors[label]!.blockHash }, author: null, status, assurance: "consensus-verified" }]))])),
    forgedDocuments: {
      "serial 3 with every author window reopened, under the trust root's signature on serial 3": { outcome: signatureFails },
      "that document signed by a stranger, under the trust root's key": { outcome: signatureFails },
      "that document signed by a stranger, under the stranger's key": { outcome: "refused: the known-authors document carries no signature by a trust root" },
      "positive control: that document signed by a stranger, with the stranger as the trust root": { outcome: "opened" },
    },
    refusedTransactions: Object.fromEntries(Object.entries(raw.negatives).map(([name, n]) => [name, { ...negative("invalid", "none"), txHash: n.txHash, failed: [`indexer: the indexer knows no transaction ${n.txHash}`] }])),
    negatives: {
      "kind 1 against another bundle's entry": negative("invalid", "consensus-verified", "expectation"),
      "kind 2 against another attribute": negative("invalid", "consensus-verified", "expectation"),
      "a kind-1 anchor read as kind 2": negative("invalid", "consensus-verified", "expectation"),
      "a stranger as the expected author": negative("unauthenticated", "consensus-verified", "author"),
      "a transaction hash no chain holds": negative("invalid", "none", "indexer"),
      "the registry deploy read as an anchor": negative("invalid", "consensus-verified", "anchor"),
      "the DUST registration read as an anchor": negative("invalid", "consensus-verified", "anchor"),
      "finality skipped": negative("unverified-finality", "multi-path", "finality", "registry-deploy/finality"),
      "a registry pinned at another deploy height": negative("invalid", "consensus-verified", "registry-deploy"),
      "a registry at another address": negative("invalid", "consensus-verified", "anchor"),
      "no KNOWN_AUTHORS document and no checkpoint": negative("unverified-finality", "multi-path", "finality", "author", "registry-deploy/finality"),
      "a checkpoint too far below for a zero set-change budget": negative("unverified-finality", "multi-path", "finality"),
    },
  };

  const T1 = anchors["crash-before-broadcast"]!;
  const T2 = anchors["crash-after-broadcast"]!;
  const row = (a: Anchor, state: string, broadcasts: number) => ({ tx_hash: a.txHash, state, broadcasts, height: state === "landed" ? a.blockHeight : null });
  const receipt = (a: Anchor) => ({ txHash: a.txHash, blockHeight: a.blockHeight, blockHash: a.blockHash, kind: a.kind, commitment: a.commitment, attribute: a.attribute, author: a.author });
  const ev = (mode: string, label: string, event: string, extra: Record<string, unknown>) => ({ at: "2026-10-05T00:00:00.000Z", mode, label, event, ...extra });
  const crash = [
    ev("kill-before", "crash-before-broadcast", "dying before broadcast", { txHash: T1.txHash, rows: [row(T1, "pending", 0)] }),
    ev("recover", "crash-before-broadcast", "restarted", { rows: [row(T1, "pending", 0)] }),
    ev("recover", "crash-before-broadcast", "reconciled", { rows: [row(T1, "pending", 0)] }),
    ev("recover", "crash-before-broadcast", "broadcast", { txHash: T1.txHash }),
    ev("recover", "crash-before-broadcast", "landed", { receipt: receipt(T1), rows: [row(T1, "landed", 1)] }),
    ev("kill-after", "crash-after-broadcast", "dying after the node accepted the bytes", { txHash: T2.txHash, rows: [row(T1, "landed", 1), row(T2, "pending", 0)] }),
    ev("recover", "crash-after-broadcast", "restarted", { rows: [row(T1, "landed", 1), row(T2, "pending", 0)] }),
    ev("recover", "crash-after-broadcast", "reconciled", { rows: [row(T1, "landed", 1), row(T2, "landed", 0)] }),
    ev("recover", "crash-after-broadcast", "landed", { receipt: receipt(T2), rows: [row(T1, "landed", 1), row(T2, "landed", 0)] }),
  ];
  const crashStatus = [
    "crash.ts kill-before crash-before-broadcast exit=137",
    "crash.ts recover crash-before-broadcast exit=0",
    "crash.ts kill-after crash-after-broadcast exit=137",
    "crash.ts recover crash-after-broadcast exit=0",
  ];

  const landedIn = (pick: (name: string, a: Anchor) => boolean) => Object.entries(anchors).filter(([n, a]) => pick(n, a)).map(([, a]) => ({ tx_hash: a.txHash, state: "landed" }));
  const journals = {
    "journal-walletA.sqlite": landedIn((n, a) => a.wallet === "walletA" && !n.startsWith("crash-")),
    "journal-walletB.sqlite": landedIn((_, a) => a.wallet === "walletB"),
    "journal-crash.sqlite": landedIn((n) => n.startsWith("crash-")),
    "journal-deploy.sqlite": [{ tx_hash: raw.deploy.txHash, state: "landed" }],
  };
  bundles.push({ label: "unused-extra", kind: 1, exit: 0, rootHash: h(), manifestHash: h(), merkleRoot: h(), modelManifestHash: h() });
  return { raw, verified, crash, crashStatus, bundles, journals, documents, root, rootSeed: hex(rootSeed), openings };
}

// Writes the rehearsal where the scripts read it: DIR/evidence/{raw.json, verified.json,
// crash.log, crash.log.status, known-authors/}, DIR/bundles/index.json, and the secrets and
// journals under HOME/.secrets/orynq-midnight-preprod (0700, files 0600).
export function writeRehearsal(dir: string, home: string, r: Rehearsal) {
  const secrets = `${home}/.secrets/orynq-midnight-preprod`;
  for (const d of [`${dir}/evidence/known-authors`, `${dir}/bundles`, secrets]) mkdirSync(d, { recursive: true });
  chmodSync(`${home}/.secrets`, 0o700);
  chmodSync(secrets, 0o700);
  const json = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v, null, 1));
  json(`${dir}/evidence/raw.json`, r.raw);
  json(`${dir}/evidence/verified.json`, r.verified);
  writeFileSync(`${dir}/evidence/crash.log`, r.crash.map((e) => `${JSON.stringify(e)}\n`).join(""));
  writeFileSync(`${dir}/evidence/crash.log.status`, r.crashStatus.map((l) => `${l}\n`).join(""));
  json(`${dir}/bundles/index.json`, r.bundles);
  r.documents.forEach((d, i) => json(`${dir}/evidence/known-authors/signed-${i + 1}.json`, [d]));
  writeFileSync(`${dir}/evidence/known-authors/root.pub`, `${r.root}\n`);
  const secret = (name: string, text: string) => writeFileSync(`${secrets}/${name}`, `${text}\n`, { mode: 0o600 });
  for (const name of ["author-relay.key", "author-relay-2.key", "salt.key"]) secret(name, h());
  secret("known-authors-root.seed", r.rootSeed);
  secret("receipts.json", JSON.stringify(r.openings));
  for (const [name, rows] of Object.entries(r.journals)) {
    const db = new DatabaseSync(`${secrets}/${name}`);
    db.exec("create table attempts (id integer primary key, key text not null, tx_hash text not null unique, bytes blob not null, ttl_ms integer not null, state text not null, broadcasts integer not null default 0, height integer, block_hash text)");
    const insert = db.prepare("insert into attempts (key, tx_hash, bytes, ttl_ms, state) values (?, ?, ?, ?, ?)");
    rows.forEach((row, i) => insert.run(`k${i}`, row.tx_hash, new Uint8Array([1]), 0, row.state));
    db.close();
    chmodSync(`${secrets}/${name}`, 0o600);
  }
}

// The chain the stand-in verify package (test/fake-verifier) answers from: every recorded anchor,
// the deploy and wallet A's DUST registration, with `verdicts` overriding named anchors.
export function fakeChain(r: Rehearsal, verdicts: Record<string, { status: string; assurance: string }> = {}) {
  const bundle = (label: string) => r.bundles.find((b) => b.label === label)!;
  const transactions: Record<string, unknown> = {
    [r.raw.deploy.txHash]: { height: r.raw.deploy.blockHeight, blockHash: r.raw.deploy.blockHash },
    [r.raw.funding.walletA.registration.txHash]: { height: 990, blockHash: "00".repeat(32) },
  };
  for (const [name, a] of Object.entries(r.raw.anchors as Record<string, any>)) {
    const b = bundle(a.bundle);
    transactions[a.txHash] = { height: a.blockHeight, blockHash: a.blockHash, anchor: { kind: a.kind, rootHash: b.rootHash, commitment: a.commitment, attribute: a.attribute, author: a.author }, ...(verdicts[name] ? { verdict: verdicts[name] } : {}) };
  }
  return { registry: { address: r.raw.deploy.address, deployHeight: r.raw.deploy.blockHeight }, transactions };
}

// A consumer directory whose only package is the stand-in verify package, installed as a copy
// the way npm installs a packed tarball, with the tarball beside it and npm's lock entry for it,
// or linked to its source the way npm installs a directory.
export const FAKE_TARBALL = "fluxpointstudios-orynq-sdk-anchors-midnight-0.0.0-fake.tgz";
export function fakeConsumer(consumer: string, install: "copy" | "link" = "copy") {
  const source = new URL("./fake-verifier", import.meta.url).pathname;
  const target = `${consumer}/node_modules/@fluxpointstudios/orynq-sdk-anchors-midnight`;
  mkdirSync(`${consumer}/node_modules/@fluxpointstudios`, { recursive: true });
  if (install === "link") return symlinkSync(source, target);
  cpSync(source, target, { recursive: true });
  const tarball = readFileSync(`${source}/index.js`);
  writeFileSync(`${consumer}/${FAKE_TARBALL}`, tarball);
  const entry = { version: "0.0.0-fake", resolved: `file:${FAKE_TARBALL}`, integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}` };
  writeFileSync(`${consumer}/package-lock.json`, JSON.stringify({ name: "consumer", lockfileVersion: 3, packages: { "node_modules/@fluxpointstudios/orynq-sdk-anchors-midnight": entry } }, null, 1));
}

// The preprod rehearsal of the submit package, phase by phase, against Midnight preprod with
// test tokens only. Everything public it learns goes to evidence/raw.json; openings, journals,
// wallet state and keys stay in ~/.secrets/orynq-midnight-preprod (0700, files 0600).
//   node --import tsx run.ts PHASE...   phases: chain funding deploy kind1 kind2 sameblock negatives rotation
// Run under nice 19. Each phase resumes from evidence/raw.json and skips work already recorded.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as L from "@midnight-ntwrk/ledger-v8";
import {
  assertRegistryState,
  blockfrostEndpoints,
  compiledVerifierKeys,
  createAuthorKeyFile,
  midnightSource,
  readAuthorSecret,
  authorKey,
  type MidnightSource,
} from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import {
  MIDNIGHT_HOSTED_PREPROD,
  assertChainIdentity,
  declaredFee,
  ensurePrivateDir,
  formatDust,
  nodeRefusal,
  openWallet,
  provingService,
  registryDeployer,
  registryOperator,
  type OperatorWallet,
} from "../src/index.js";
import { NODE_NEGATIVES } from "./gate.mjs";
import recorded from "./wallets.json" with { type: "json" };

const HOME = process.env.HOME!;
const SECRETS = `${HOME}/.secrets/orynq-midnight-preprod`;
const ZK = `${HOME}/.cache/orynq-midnight/zk`;
const RAW = new URL("./evidence/raw.json", import.meta.url);
mkdirSync(new URL("./evidence/", import.meta.url), { recursive: true });
ensurePrivateDir(`${SECRETS}/state`);
const OVERHEAD = BigInt(process.env.FEE_OVERHEAD_SPECK ?? "0");

const source: MidnightSource = midnightSource(MIDNIGHT_HOSTED_PREPROD);

type Raw = Record<string, any>;
const raw: Raw = existsSync(RAW) ? JSON.parse(readFileSync(RAW, "utf8")) : {};
const save = () => writeFileSync(RAW, JSON.stringify(raw, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1));
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
type TracedBundle = { label: string; kind: 1 | 2; rootHash: string; manifestHash: string; merkleRoot: string; modelManifestHash: string };
const bundles: TracedBundle[] = JSON.parse(readFileSync(new URL("./bundles/index.json", import.meta.url), "utf8"));
const bundle = (label: string) => {
  const b = bundles.find((x) => x.label === label);
  if (!b) throw new Error(`bundles/index.json holds no bundle ${label}`);
  return b;
};
const entryOf = (b: TracedBundle) => ({ rootHash: b.rootHash, manifestHash: b.manifestHash, merkleRoot: b.merkleRoot });

// Timings and fees of every transaction this process sends, keyed by its hash.
const metrics = new Map<string, Record<string, unknown>>();
let pendingProve = 0;
const prover = (() => {
  const real = provingService(ZK);
  return {
    async prove(tx: L.UnprovenTransaction) {
      const t = performance.now();
      const out = await real.prove(tx);
      pendingProve = performance.now() - t;
      return out;
    },
  };
})();
function instrument(wallet: OperatorWallet, label: string) {
  let payMs = 0;
  return {
    async payFee(tx: Parameters<OperatorWallet["payFee"]>[0], ttl: Date) {
      const t = performance.now();
      const out = await wallet.payFee(tx, ttl);
      payMs = performance.now() - t;
      return out;
    },
    async submit(tx: L.FinalizedTransaction) {
      metrics.set(tx.transactionHash(), { wallet: label, proveMs: Math.round(pendingProve), payFeeMs: Math.round(payMs), declaredFee: declaredFee(tx), bytes: tx.serialize().length, submittedAt: Date.now() });
      await wallet.submit(tx);
    },
    discard: (tx: L.FinalizedTransaction) => wallet.discard(tx),
  };
}

const wallets = new Map<string, OperatorWallet>();
async function wallet(which: "walletA" | "walletB") {
  if (!wallets.has(which)) {
    const t = Date.now();
    const w = await openWallet({
      network: "preprod",
      mnemonicFile: `${SECRETS}/${which === "walletA" ? "wallet-a" : "wallet-b"}.mnemonic`,
      endpoints: MIDNIGHT_HOSTED_PREPROD,
      source,
      zkDir: ZK,
      expectedAddresses: recorded[which].addresses,
      stateFile: `${SECRETS}/state/${which}-midnight.state.json`,
      costParameters: { additionalFeeOverhead: OVERHEAD, feeBlocksMargin: 5 },
    });
    await w.waitForSync(7_200_000);
    log(`${which} synced in ${(Date.now() - t) / 1000} s`);
    wallets.set(which, w);
  }
  return wallets.get(which)!;
}
const balances = async (which: "walletA" | "walletB") => {
  const b = await (await wallet(which)).balances();
  return { night: b.night, dust: b.dust, dustDisplay: formatDust(b.dust), nightUtxos: b.nightUtxos, registered: b.registeredNightUtxos };
};

// One operator per wallet and author key; `wrap` gives a fresh one whose fee wallet it wraps,
// which the caller closes.
const operators = new Map<string, ReturnType<typeof registryOperator>>();
async function operator(which: "walletA" | "walletB", authorFile: string, wrap?: (w: ReturnType<typeof instrument>) => ReturnType<typeof instrument>) {
  const make = async () => {
    const fee = instrument(await wallet(which), which);
    return registryOperator({
      network: "preprod",
      wallet: wrap ? wrap(fee) : fee,
      source,
      prover,
      journalPath: `${SECRETS}/journal-${which}.sqlite`,
      authorKeyFile: authorFile,
      saltKeyFile: `${SECRETS}/salt.key`,
      registry: raw.deploy.address,
    });
  };
  if (wrap) return make();
  const key = `${which}:${authorFile}`;
  if (!operators.has(key)) operators.set(key, await make());
  return operators.get(key)!;
}

// Every anchor this rehearsal wrote, with what it cost and how long it took.
async function recordAnchor(name: string, which: "walletA" | "walletB", receipt: { txHash: string; blockHeight: number; blockHash: string; kind: number; commitment: string; attribute: string; author: string }, extra: Record<string, unknown> = {}) {
  const m = metrics.get(receipt.txHash) ?? {};
  raw.anchors ??= {};
  raw.anchors[name] = { ...receipt, wallet: which, ...m, landedAfterMs: m.submittedAt ? Date.now() - (m.submittedAt as number) : null, ...extra };
  save();
  log(`${name}: ${receipt.txHash} at ${receipt.blockHeight} (${which}, fee ${m.declaredFee} SPECK)`);
}

const phases: Record<string, () => Promise<void>> = {
  async chain() {
    raw.chain = { hosted: await assertChainIdentity(source, "preprod") };
    const bf = midnightSource(blockfrostEndpoints("preprod", `${HOME}/.secrets/blockfrost-midnight-preprod.project_id`));
    raw.chain.blockfrost = await assertChainIdentity(bf, "preprod");
    save();
    log("chain", raw.chain);
  },

  async funding() {
    raw.funding ??= {};
    for (const which of ["walletA", "walletB"] as const) {
      const w = await wallet(which);
      const before = await balances(which);
      raw.funding[which] = { before };
      if (before.nightUtxos > before.registered) {
        const t = Date.now();
        const txHash = await w.registerNightForDust();
        raw.funding[which].registration = { txHash, submittedAt: new Date(t).toISOString() };
        log(`${which} registered NIGHT for DUST: ${txHash}`);
      }
      save();
    }
    for (const which of ["walletA", "walletB"] as const) {
      const t = Date.now();
      for (;;) {
        const b = await balances(which);
        if (b.dust > 10n ** 15n) {
          raw.funding[which].dustReady = { ...b, afterMs: Date.now() - t, at: new Date().toISOString() };
          break;
        }
        await new Promise((r) => setTimeout(r, 20_000));
      }
      save();
      log(`${which} DUST ${raw.funding[which].dustReady.dustDisplay}`);
    }
  },

  async deploy() {
    if (raw.deploy?.txHash) return log("deploy already recorded", raw.deploy.address);
    const w = await wallet("walletA");
    const dustBefore = (await balances("walletA")).dust;
    const deployer = registryDeployer({ network: "preprod", wallet: instrument(w, "walletA"), source, prover, journalPath: `${SECRETS}/journal-deploy.sqlite` });
    const t = performance.now();
    const prepared = await deployer.prepare();
    const prepareMs = performance.now() - t;
    raw.deploy = { prepared: { address: prepared.address, txHash: prepared.txHash, runtime: prepared.runtime, authority: prepared.authority, verifierKeys: prepared.verifierKeys, declaredFee: prepared.declaredFee, ttl: prepared.ttl, bytes: prepared.bytes.length, prepareMs: Math.round(prepareMs) } };
    save();
    const deployment = await deployer.submit(prepared);
    deployer.close();
    raw.deploy = { ...raw.deploy, ...deployment, landedAfterMs: Date.now() - (metrics.get(prepared.txHash)!.submittedAt as number), dustBefore, dustAfter: (await balances("walletA")).dust };
    // Readback from two paths: the indexer's state for the deploy action and the node's state.
    const [indexed] = await source.indexer.transactions(deployment.txHash);
    const indexerState = indexed!.contractActions.find((a) => a.address === deployment.address)!.state;
    const nodeState = (await source.node.call<string>("midnight_contractState", [deployment.address, `0x${deployment.blockHash}`])).replace(/^0x/, "");
    for (const state of [indexerState, nodeState]) assertRegistryState(L.ContractState.deserialize(Buffer.from(state, "hex")));
    raw.deploy.readback = { indexerStateBytes: indexerState.length / 2, nodeStateBytes: nodeState.length / 2, byteEqual: indexerState === nodeState, immutable: true };
    save();
    log("deployed", raw.deploy);
  },

  async kind1() {
    const op = await operator("walletA", `${SECRETS}/author-relay.key`);
    for (const label of ["git-head", "contract-hashes", "compactc-version", "zk-material", "preprod-chain", "preprod-runtime", "preprod-ledger", "git-log", "commitment-suite", "node-version", "pnpm-lock-midnight", "uname"]) {
      if (raw.anchors?.[label]) continue;
      const before = (await balances("walletA")).dust;
      const receipt = await op.anchor(entryOf(bundle(label)));
      await recordAnchor(label, "walletA", receipt, { bundle: label, dustBefore: before, dustAfter: (await balances("walletA")).dust });
    }
  },

  async kind2() {
    const op = await operator("walletA", `${SECRETS}/author-relay.key`);
    const receiptsFile = `${SECRETS}/receipts.json`;
    const openings: Record<string, unknown> = existsSync(receiptsFile) ? JSON.parse(readFileSync(receiptsFile, "utf8")) : {};
    for (const label of ["hidden-broadcast-suite", "hidden-relay-suite", "hidden-keys-suite"]) {
      if (raw.anchors?.[label]) continue;
      const b = bundle(label);
      const before = (await balances("walletA")).dust;
      const { opening, ...receipt } = await op.anchorHiding(entryOf(b), b.modelManifestHash);
      openings[label] = { txHash: receipt.txHash, ...opening };
      writeFileSync(`${receiptsFile}.next`, JSON.stringify(openings, null, 1), { mode: 0o600 });
      renameSync(`${receiptsFile}.next`, receiptsFile);
      await recordAnchor(label, "walletA", receipt, { bundle: label, dustBefore: before, dustAfter: (await balances("walletA")).dust });
    }
  },

  async sameblock() {
    if (raw.sameBlock?.coLanded) return log("same-block pair already recorded");
    raw.sameBlock = { rounds: [] };
    const rounds = bundles.filter((b) => /^same-block-a-\d+$/.test(b.label)).length;
    for (let round = 1; round <= rounds; round++) {
      const [bundleA, bundleB] = [bundle(`same-block-a-${round}`), bundle(`same-block-b-${round}`)];
      let arrived = 0;
      let release!: () => void;
      const together = new Promise<void>((r) => (release = r));
      const gate = (w: ReturnType<typeof instrument>) => ({
        ...w,
        async submit(tx: L.FinalizedTransaction) {
          if (++arrived === 2) release();
          await together;
          return w.submit(tx);
        },
      });
      const opA = await operator("walletA", `${SECRETS}/author-relay.key`, gate);
      const opB = await operator("walletB", `${SECRETS}/author-relay.key`, gate);
      const [a, b] = await Promise.all([opA.anchor(entryOf(bundleA)), opB.anchor(entryOf(bundleB))]).finally(() => {
        opA.close();
        opB.close();
      });
      await recordAnchor(`same-block-a-${round}`, "walletA", a, { bundle: bundleA.label, round });
      await recordAnchor(`same-block-b-${round}`, "walletB", b, { bundle: bundleB.label, round });
      raw.sameBlock.rounds.push({ round, a: { txHash: a.txHash, height: a.blockHeight }, b: { txHash: b.txHash, height: b.blockHeight } });
      save();
      if (a.blockHeight === b.blockHeight) {
        raw.sameBlock.coLanded = { round, height: a.blockHeight, blockHash: a.blockHash, txHashes: [a.txHash, b.txHash] };
        save();
        return log("same block", raw.sameBlock.coLanded);
      }
      log(`round ${round}: heights ${a.blockHeight} and ${b.blockHeight}`);
    }
    throw new Error(`no same-block pair in ${rounds} rounds`);
  },

  async negatives() {
    raw.negatives ??= {};
    const w = instrument(await wallet("walletA"), "walletA");
    const address = raw.deploy.address as string;
    const stranger = L.sampleSigningKey();
    // Keyed by the evidence gate's case names, so the type check refuses a case the gate holds no
    // expected refusal for, and a case the gate expects but nothing sends.
    const cases: Record<keyof typeof NODE_NEGATIVES, () => L.MaintenanceUpdate> = {
      "ReplaceAuthority, unsigned": () => new L.MaintenanceUpdate(address, [new L.ReplaceAuthority(new L.ContractMaintenanceAuthority([], 0, 1n))], 0n),
      "VerifierKeyRemove(anchor), signed by a stranger at index 0": () => {
        const u = new L.MaintenanceUpdate(address, [new L.VerifierKeyRemove("anchor", new L.ContractOperationVersion("v3"))], 0n);
        return u.addSignature(0n, L.signData(stranger, u.dataToSign));
      },
      "VerifierKeyInsert(rewrite), signed by a stranger at index 0": () => {
        const u = new L.MaintenanceUpdate(address, [new L.VerifierKeyInsert("rewrite", new L.ContractOperationVersionedVerifierKey("v3", compiledVerifierKeys().anchor))], 0n);
        return u.addSignature(0n, L.signData(stranger, u.dataToSign));
      },
    };
    for (const [name, update] of Object.entries(cases)) {
      if (raw.negatives[name]) continue;
      const ttl = new Date(Date.now() + 15 * 60_000);
      const tx = L.Transaction.fromParts("preprod", undefined, undefined, L.Intent.new(ttl).addMaintenanceUpdate(update()));
      const final = await w.payFee(await prover.prove(tx), ttl);
      const txHash = final.transactionHash();
      try {
        await w.submit(final);
        raw.negatives[name] = { txHash, rejected: false, note: "THE NODE ACCEPTED A MAINTENANCE UPDATE" };
      } catch (error) {
        // Only the node's own JSON-RPC answer is a rejection; any other failure may have delivered
        // the bytes, so the case stays unresolved. A recorded case is never sent again: its outcome
        // stands until someone looks at it.
        const refusal = nodeRefusal(error);
        raw.negatives[name] = refusal ? { txHash, rejected: true, by: "node author_submitExtrinsic", refusal } : { txHash, rejected: null, unresolved: (error as Error).message.slice(0, 400) };
      }
      await new Promise((r) => setTimeout(r, 20_000));
      raw.negatives[name].onChain = (await source.indexer.transactions(txHash)).length;
      save();
      log(name, raw.negatives[name]);
    }
    const state = (await source.node.call<string>("midnight_contractState", [address])).replace(/^0x/, "");
    assertRegistryState(L.ContractState.deserialize(Buffer.from(state, "hex")));
    raw.negativesAfter = { registryStillImmutable: true, checkedAt: new Date().toISOString() };
    save();
  },

  async rotation() {
    raw.rotation ??= {};
    const relay2 = `${SECRETS}/author-relay-2.key`;
    if (!existsSync(relay2)) createAuthorKeyFile(relay2);
    raw.rotation.keys = { relay1: Buffer.from(authorKey(readAuthorSecret(`${SECRETS}/author-relay.key`))).toString("hex"), relay2: Buffer.from(authorKey(readAuthorSecret(relay2))).toString("hex") };
    const one = await operator("walletA", `${SECRETS}/author-relay.key`);
    const two = await operator("walletA", relay2);
    const steps: Array<[string, typeof one]> = [["rotation-old-before", one], ["rotation-old-after", one], ["rotation-new-after", two], ["revoked-new-after", two]];
    for (const [label, op] of steps) {
      if (raw.anchors?.[label]) continue;
      const receipt = await op.anchor(entryOf(bundle(label)));
      await recordAnchor(label, "walletA", receipt, { bundle: label, author: receipt.author });
    }
    save();
  },
};

try {
  for (const name of process.argv.slice(2)) {
    log(`phase ${name}`);
    await phases[name]!();
  }
} finally {
  for (const op of operators.values()) op.close();
  for (const w of wallets.values()) await w.close();
  save();
}
process.exit(0);

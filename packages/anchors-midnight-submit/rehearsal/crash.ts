// The journal crash-window drill, one process per step, against preprod with wallet A:
//   kill-before LABEL   the process dies (SIGKILL) after the journal row is written, before any byte is broadcast
//   kill-after LABEL    the process dies after the node accepted the bytes, before the journal counted the broadcast
//   recover LABEL       a new process reconciles by txHash and finishes the same anchor
// Each step prints one JSON line with the journal's rows for the anchor's key.
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { midnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { MIDNIGHT_HOSTED_PREPROD, openWallet, provingService, registryOperator } from "../src/index.js";
import { CRASH_WINDOWS } from "./gate.mjs";
import recorded from "./wallets.json" with { type: "json" };

const [mode, label] = process.argv.slice(2) as ["kill-before" | "kill-after" | "recover", keyof typeof CRASH_WINDOWS];
// Each label has the one kill mode the evidence gate expects, and dies with the gate's words.
const crashWindow = CRASH_WINDOWS[label];
if (!crashWindow || (mode !== "recover" && mode !== crashWindow.mode)) throw new Error(`crash.ts: ${mode} ${label} is not a crash window the evidence gate knows`);
const HOME = process.env.HOME!;
const SECRETS = `${HOME}/.secrets/orynq-midnight-preprod`;
const JOURNAL = `${SECRETS}/journal-crash.sqlite`;
const source = midnightSource(MIDNIGHT_HOSTED_PREPROD);
const RAW = new URL("./evidence/raw.json", import.meta.url);
const raw = JSON.parse(readFileSync(RAW, "utf8"));
const bundles: Array<{ label: string; rootHash: string; manifestHash: string; merkleRoot: string }> = JSON.parse(readFileSync(new URL("./bundles/index.json", import.meta.url), "utf8"));
const b = bundles.find((x) => x.label === label);
if (!b) throw new Error(`bundles/index.json holds no bundle ${label}`);
const rows = () => {
  const db = new DatabaseSync(JOURNAL);
  try {
    return db.prepare("select tx_hash, state, broadcasts, height from attempts order by id").all();
  } finally {
    db.close();
  }
};
const say = (event: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), mode, label, event, ...extra }));

const wallet = await openWallet({
  network: "preprod",
  mnemonicFile: `${SECRETS}/wallet-a.mnemonic`,
  endpoints: MIDNIGHT_HOSTED_PREPROD,
  source,
  zkDir: `${HOME}/.cache/orynq-midnight/zk`,
  expectedAddresses: recorded.walletA.addresses,
  stateFile: `${SECRETS}/state/walletA-midnight.state.json`,
});
await wallet.waitForSync(7_200_000);
const die = (event: string, txHash: string) => {
  say(event, { txHash, rows: rows() });
  process.kill(process.pid, "SIGKILL");
};
const fee = {
  payFee: wallet.payFee,
  discard: wallet.discard,
  submit: async (tx: Parameters<typeof wallet.submit>[0]) => {
    if (mode === "kill-before") return die(crashWindow.dying, tx.transactionHash());
    await wallet.submit(tx);
    if (mode === "kill-after") return die(crashWindow.dying, tx.transactionHash());
    say("broadcast", { txHash: tx.transactionHash() });
  },
};
const operator = registryOperator({
  network: "preprod",
  wallet: fee,
  source,
  prover: provingService(`${HOME}/.cache/orynq-midnight/zk`),
  journalPath: JOURNAL,
  authorKeyFile: `${SECRETS}/author-relay.key`,
  registry: raw.deploy.address,
});
if (mode === "recover") {
  say("restarted", { rows: rows() });
  // Bytes the node accepted show up in the indexer within a few blocks; reconcile settles their
  // row by txHash. Bytes that never left stay pending, and anchor() resends exactly them.
  for (let i = 0; i < 9 && (await operator.reconcile()).some((r) => r.state === "pending"); i++) await new Promise((r) => setTimeout(r, 10_000));
  say("reconciled", { rows: rows() });
}
const receipt = await operator.anchor({ rootHash: b.rootHash, manifestHash: b.manifestHash, merkleRoot: b.merkleRoot });
// The drill's anchor joins every other anchor in raw.json, so the separate verifier checks it too.
const now = JSON.parse(readFileSync(RAW, "utf8"));
now.anchors = { ...now.anchors, [label]: { ...receipt, wallet: "walletA", bundle: label, drill: "journal crash window" } };
writeFileSync(RAW, JSON.stringify(now, null, 1));
say("landed", { receipt, rows: rows() });
operator.close();
await wallet.close();
process.exit(0);

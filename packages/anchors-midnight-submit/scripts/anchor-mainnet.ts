// Writes the anchors a plan names to the immutable orynq-anchor-registry on Midnight MAINNET, under
// the FPS author key, for deci to run at his own terminal after deploy-mainnet. Every check fails
// closed and comes before any key is loaded or any byte is sent (mainnet-session.ts holds the gates,
// the confirmation and the way out it shares with deploy-mainnet):
//   the process carries no Claude Code environment, and its input and output are a terminal;
//   the plan names exactly a registry and its entries, with no field it does not define;
//   the node is Midnight Mainnet (system_chain, genesis) on runtime 1000300;
//   the node holds exactly the immutable registry at the plan's address (committee [],
//   threshold 1, counter 0, the pinned verifier keys);
//   the mnemonic derives exactly the recorded wallet, which holds at least the DUST floor
//   whenever confirming an anchor may send bytes.
// For each entry in order it prints the exact summary of the final, balanced bytes and sends them
// only after the token it shows, which names their transaction hash, is typed at that terminal.
// It then reads the anchor back from the node, final and carrying exactly those bytes, and appends
// what anyone may know of it (label, kind, transaction, block, commitment, kind 2's attribute,
// registry, author key) to the results file. An anchor the journal still holds, as after a run
// that failed between its broadcast and its readback, is resumed as deploy-mainnet resumes a
// deploy, and an entry the results file records is not sent again. The gates stop accidents, not
// code running as deci; see deploy-mainnet.
//   node --import tsx scripts/anchor-mainnet.ts --plan PLAN.json [--mnemonic F] [--wallet-record F]
//        [--blockfrost F] [--zk DIR] [--journal F] [--dust-floor DUST] [--author-key F] [--salt-key F]
//        [--results F]
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { includedTransactionIndex, writePrivateFile, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { anchorSummary, provingService, readAnchorPlan, registryOperator, registryStateOnNode, type AnchorReceipt } from "../src/index.js";
import { home, mainnetScript } from "./mainnet-session.js";

const STATE = `${home}/.local/state/orynq-midnight`;
const SECRETS = `${home}/.secrets/orynq-midnight-mainnet`;
const { option, run, requireDustFloor, confirm } = mainnetScript({
  name: "anchor-mainnet",
  noun: "anchor",
  does: "writes mainnet anchors",
  flags: {
    plan: undefined,
    journal: `${STATE}/mainnet-anchors.sqlite`,
    "author-key": `${SECRETS}/author-relay.key`,
    "salt-key": `${SECRETS}/salt.key`,
    results: `${STATE}/mainnet-anchors.json`,
  },
});

interface Recorded {
  label: string;
  kind: 1 | 2;
  txHash: string;
  block: number;
  blockHash: string;
  commitment: string;
  attribute?: string;
  registry: string;
  author: string;
}

const FINALITY_MINUTES = 10;

// The node's word that the anchor's block is final and carries exactly its bytes: its finalized
// head is at or past the block, its block at that height is the one the indexer named, and that
// block's body holds the bytes as exactly one bare Midnight.send_mn_transaction. verifyMidnightAnchor
// shows finality from a trusted GRANDPA checkpoint instead of the node's word.
async function finalOnNode(source: MidnightSource, label: string, { blockHeight, blockHash, txHash }: AnchorReceipt, bytes: Uint8Array) {
  const until = Date.now() + FINALITY_MINUTES * 60_000;
  process.stdout.write(`\n${label} landed in block ${blockHeight} (${blockHash}); waiting until the node finalizes it...\n`);
  for (;;) {
    const head = await source.node.call<{ number: string }>("chain_getHeader", [await source.node.call<string>("chain_getFinalizedHead")]);
    if (Number(head.number) >= blockHeight) break;
    if (Date.now() > until) throw new Error(`block ${blockHeight} is not final on the node after ${FINALITY_MINUTES} minutes; anchor ${txHash} landed, and a rerun reads it back`);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  const canonical = (await source.node.call<string>("chain_getBlockHash", [blockHeight])).replace(/^0x/, "");
  if (canonical !== blockHash) throw new Error(`the node's final block ${blockHeight} is ${canonical}, not ${blockHash}, where the indexer places anchor ${txHash}`);
  const { block } = await source.node.call<{ block: { extrinsics: string[] } }>("chain_getBlock", [`0x${blockHash}`]);
  const extrinsics = block.extrinsics.map((e) => new Uint8Array(Buffer.from(e.replace(/^0x/, ""), "hex")));
  if (includedTransactionIndex(extrinsics, bytes) === null) throw new Error(`the node's block ${blockHeight} does not carry the anchor's bytes as exactly one Midnight.send_mn_transaction`);
}

await run(async (connect) => {
  const plan = readAnchorPlan(option("plan"));
  const resultsPath = option("results");
  const results: Recorded[] = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : [];
  if (!Array.isArray(results)) throw new Error(`${resultsPath} does not hold a list of anchors`);
  // Replaces the results file only once the new list is wholly written and flushed, owner-only.
  const record = (row: Recorded) => {
    results.push(row);
    const next = `${resultsPath}.${process.pid}.next`;
    writePrivateFile(next, JSON.stringify(results, null, 1));
    renameSync(next, resultsPath);
  };

  const { source, chain, syncWallet } = await connect();
  if (!(await registryStateOnNode(source, plan.registry))) throw new Error(`the mainnet node holds no contract at ${plan.registry}`);
  process.stdout.write(`registry ${plan.registry} holds the immutable registry: committee [], threshold 1, counter 0, the pinned verifier keys\n`);
  const wallet = await syncWallet();
  for (const path of [option("journal"), resultsPath]) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const operator = registryOperator({
    network: "mainnet",
    wallet,
    source,
    prover: provingService(option("zk")),
    journalPath: option("journal"),
    authorKeyFile: option("author-key"),
    saltKeyFile: option("salt-key"),
    registry: plan.registry,
  });
  try {
    for (const planned of plan.entries) {
      const resumed = await operator.journalled(planned);
      const done = results.find((row) => row.label === planned.label);
      if (done) {
        if (resumed?.journal?.state !== "landed" || resumed.txHash !== done.txHash) {
          throw new Error(`${resultsPath} records ${planned.label} as ${done.txHash}, which the journal does not hold landed for this entry of the plan`);
        }
        process.stdout.write(`\n${planned.label}: anchored as ${done.txHash}, read back and recorded; nothing to send\n`);
        continue;
      }
      const { dust } = await wallet.balances();
      requireDustFloor(dust, resumed);
      const prepared = resumed ?? (await operator.prepare(planned));
      await confirm(prepared, anchorSummary({ chain, wallet: wallet.addresses, dust, label: planned.label, prepared }), () => operator.discard(prepared));
      const receipt = await operator.submit(prepared);
      await finalOnNode(source, planned.label, receipt, prepared.bytes);
      record({
        label: planned.label,
        kind: receipt.kind,
        txHash: receipt.txHash,
        block: receipt.blockHeight,
        blockHash: receipt.blockHash,
        commitment: receipt.commitment,
        ...(receipt.kind === 2 ? { attribute: receipt.attribute } : {}),
        registry: receipt.registry,
        author: receipt.author,
      });
      process.stdout.write(`${planned.label}: final on the node, carrying exactly the confirmed bytes; recorded\n`);
    }
  } finally {
    operator.close();
  }
  process.stdout.write(`\n${results.length} anchor${results.length === 1 ? " is" : "s are"} recorded in ${resultsPath}; send that file back.\n`);
});

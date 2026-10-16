// Run by deci at his own terminal. --pre-authorize approves the bounded intent before sync;
// without it, every final transaction requires its existing per-bytes confirmation.
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { includedTransactionIndex, writePrivateFile, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { chainView } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import {
  anchorSummary,
  assertFpsRegistry,
  provingService,
  readAnchorPlan,
  readJsonFile,
  registryOperator,
  registryStateOnNode,
  type AnchorReceipt,
  type PreparedAnchor,
  type RegistryOperator,
} from "../src/index.js";
import { DEPLOY_JOURNAL, SECRETS, STATE, mainnetScript } from "./mainnet-session.js";

const { option, run, requireDustFloor, confirm, authorize } = mainnetScript({
  name: "anchor-mainnet",
  noun: "anchor",
  does: "writes mainnet anchors",
  flags: {
    plan: undefined,
    "deploy-journal": DEPLOY_JOURNAL,
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

// The anchor as the node holds it final: the block the node's finalized chain holds at the
// anchor's height is the one the journal names, and that block's body holds the bytes as exactly
// one bare Midnight.send_mn_transaction. While the finalized chain holds another block there, the
// journal settles the anchor afresh from the chain (operator.relocate): into the block it landed
// in since, which is then awaited the same way, or out of the journal once the chain carried it
// past its TTL unseen. verifyMidnightAnchor shows finality from a trusted GRANDPA checkpoint
// instead of the node's word.
async function finalOnNode(source: MidnightSource, operator: RegistryOperator, label: string, prepared: PreparedAnchor, landed: AnchorReceipt): Promise<AnchorReceipt> {
  const chain = chainView(source, "mainnet");
  const awaiting = ({ blockHeight, blockHash }: AnchorReceipt) => {
    process.stdout.write(`\n${label} landed in block ${blockHeight} (${blockHash}); waiting until the node finalizes it...\n`);
    return Date.now() + FINALITY_MINUTES * 60_000;
  };
  let receipt = landed;
  let until = awaiting(receipt);
  let told: string | null = null;
  for (;;) {
    const final = await chain.finalHash(receipt.blockHeight);
    if (final === receipt.blockHash) break;
    if (final !== null) {
      if (told !== final) process.stdout.write(`the node's final block ${receipt.blockHeight} is ${final}, not ${receipt.blockHash}; settling ${label} afresh from the chain...\n`);
      told = final;
      const relocated = await operator.relocate(prepared);
      if (relocated.blockHash !== receipt.blockHash) {
        receipt = relocated;
        until = awaiting(receipt);
        continue;
      }
    }
    if (Date.now() > until) {
      throw new Error(
        final === null
          ? `block ${receipt.blockHeight} is not final on the node after ${FINALITY_MINUTES} minutes; anchor ${receipt.txHash} landed, and a rerun reads it back`
          : `the node's final block ${receipt.blockHeight} is ${final}, not ${receipt.blockHash}, where the indexer places anchor ${receipt.txHash}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  const body = await source.node.call<{ block: { extrinsics: string[] } } | null>("chain_getBlock", [`0x${receipt.blockHash}`]);
  if (body === null) throw new Error(`the node holds no body for its final block ${receipt.blockHeight} (${receipt.blockHash})`);
  const extrinsics = body.block.extrinsics.map((e) => new Uint8Array(Buffer.from(e.replace(/^0x/, ""), "hex")));
  if (includedTransactionIndex(extrinsics, prepared.bytes) === null) throw new Error(`the node's block ${receipt.blockHeight} does not carry the anchor's bytes as exactly one Midnight.send_mn_transaction`);
  return receipt;
}

await run(async (connect) => {
  const plan = readAnchorPlan(option("plan"));
  assertFpsRegistry("mainnet", plan.registry, option("deploy-journal"));
  await authorize({ path: option("plan"), value: plan });
  const resultsPath = option("results");
  // The results file as it stands now: another run may have added to it since this one started.
  const recorded = (): Recorded[] => {
    const rows: unknown = existsSync(resultsPath) ? readJsonFile(resultsPath) : [];
    if (!Array.isArray(rows)) throw new Error(`${resultsPath} does not hold a list of anchors`);
    return rows;
  };
  // A results file that is not a list is refused before the chain is read.
  recorded();
  // Adds `row` to the results file as it stands, replacing the file only once the new list is
  // wholly written and flushed, owner-only.
  const record = (row: Recorded) => {
    const rows = recorded();
    const existing = rows.find((saved) => saved.label === row.label);
    if (existing) {
      if (existing.txHash !== row.txHash) throw new Error(`${resultsPath} already records ${row.label} with another transaction`);
      return;
    }
    const next = `${resultsPath}.${process.pid}.next`;
    writePrivateFile(next, JSON.stringify([...rows, row], null, 1));
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
    rebroadcastMillis: 60_000,
    authorKeyFile: option("author-key"),
    saltKeyFile: option("salt-key"),
    registry: plan.registry,
  });
  try {
    for (const planned of plan.entries) {
      const resumed = await operator.journalled(planned);
      const done = recorded().find((row) => row.label === planned.label);
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
      await confirm(prepared, anchorSummary({ entry: planned.entry, chain, wallet: wallet.addresses, dust, label: planned.label, prepared }), () => operator.discard(prepared));
      const receipt = await finalOnNode(source, operator, planned.label, prepared, await operator.submit(prepared));
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
  const count = recorded().length;
  process.stdout.write(`\n${count} anchor${count === 1 ? " is" : "s are"} recorded in ${resultsPath}; send that file back.\n`);
});

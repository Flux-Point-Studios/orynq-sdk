import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { includedTransactionIndex } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { chainView } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { confirmOnTerminal, formatDust, parseDust } from "../src/preflight.js";
import { readJsonFile } from "../src/json-file.js";
import { proofReleaseOperator, proofReleaseJournal, PROOF_RELEASE_LABELS } from "../src/proof-release.js";
import { proofReleaseIntent, type ProofReleaseIntent } from "../runner/proof-release-intent.js";
import { mainnetScript, STATE } from "./mainnet-session.js";

const { option, run } = mainnetScript({
  name: "proofs-mainnet", noun: "deploy", does: "deploys the proof contract and posts its first demonstrations",
  flags: { plan: undefined, "plan-sha256": undefined, "expires-at": undefined, journal: proofReleaseJournal(`${STATE}/runner`) },
});

await run(async connect => {
  const intent = readJsonFile(option("plan"), option("plan-sha256")) as ProofReleaseIntent;
  const maxFee = typeof intent.maxFeeDust === "string" ? parseDust(intent.maxFeeDust) : null;
  if (maxFee === null || maxFee > 10_000_000_000_000n || JSON.stringify(intent) !== JSON.stringify({ ...proofReleaseIntent(), maxFeeDust: intent.maxFeeDust })) throw new Error("Proof release plan differs from the allowlisted intent");
  const expiresAt = Date.parse(option("expires-at"));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 24 * 3600_000) throw new Error("Invalid proof release expiry");
  const { source, syncWallet } = await connect();
  const wallet = await syncWallet();
  if (wallet.addresses.unshielded !== intent.payer) throw new Error("Proof release payer mismatch");
  mkdirSync(dirname(option("journal")), { recursive: true, mode: 0o700 });
  const operator = proofReleaseOperator({ network: "mainnet", source, wallet, paramsDir: option("zk"), journalPath: option("journal"), expiresAt });
  try {
    for (const label of PROOF_RELEASE_LABELS) {
      const held = await operator.held(label);
      if (!held && (await wallet.balances()).dust < parseDust(option("dust-floor"))!) throw new Error("Available DUST is below the configured floor");
      const prepared = held ?? await operator.prepare(label);
      if (prepared.declaredFee > maxFee || prepared.ttl.getTime() > expiresAt || Date.now() >= expiresAt) {
        if (!held) await operator.discard(prepared);
        throw new Error("Proof release fee or expiry exceeds the approved intent");
      }
      const summary = [
        `network ${intent.network}`, `label ${label}`, `contract ${prepared.address}`,
        `code hash ${intent.codeHash}`, `initial state ${intent.initialStateSha256}`, `authority ${intent.authority}`,
        ...(prepared.statement ? [`statement ${JSON.stringify(prepared.statement)}`] : []),
        `paid from ${prepared.payer}`, `fee (declared) ${formatDust(prepared.declaredFee)} DUST`,
        `valid until ${prepared.ttl.toISOString()}`, `proof tx hash ${prepared.txHash}`,
      ].join("\n");
      process.stdout.write(`${summary}\n`);
      const accepted = held?.journal?.state === "landed" || await confirmOnTerminal({ input: process.stdin, output: process.stdout, token: `ANCHOR ${prepared.txHash.slice(0, 16)}`, what: `proof release ${label}` });
      if (!accepted) {
        if (!held) await operator.discard(prepared);
        throw new Error("Proof release was not confirmed");
      }
      const receipt = await operator.submit(prepared);
      const chain = chainView(source, "mainnet");
      const until = Date.now() + 600_000;
      while (await chain.finalHash(receipt.height) !== receipt.blockHash) {
        if (Date.now() >= until) throw new Error("Proof release landed but finality readback timed out");
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      const body = await source.node.call<{ block: { extrinsics: string[] } }>("chain_getBlock", [`0x${receipt.blockHash}`]);
      if (includedTransactionIndex(body.block.extrinsics.map(value => Buffer.from(value.replace(/^0x/, ""), "hex")), prepared.bytes) === null) throw new Error("Final block does not contain the submitted bytes");
      process.stdout.write(`${label} node-final readback: tx ${receipt.txHash} block ${receipt.height} ${receipt.blockHash}\n`);
    }
  } finally {
    operator.close();
  }
});

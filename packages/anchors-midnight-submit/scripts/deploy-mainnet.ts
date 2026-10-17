// Run by deci at his own terminal. --pre-authorize approves the bounded intent before sync;
// without it, every final transaction requires its existing per-bytes confirmation.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { includedTransactionIndex } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { deploySummary, provingService, registryDeployer, registryStateOnNode } from "../src/index.js";
import { DEPLOY_JOURNAL, mainnetScript } from "./mainnet-session.js";

const { option, run, requireDustFloor, confirm, authorize } = mainnetScript({
  name: "deploy-mainnet",
  noun: "deploy",
  does: "runs a mainnet deploy",
  flags: { journal: DEPLOY_JOURNAL },
});

await run(async (connect) => {
  await authorize();
  const { source, chain, syncWallet } = await connect();
  const wallet = await syncWallet();
  const { dust } = await wallet.balances();
  const journalPath = option("journal");
  mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
  const deployer = registryDeployer({ network: "mainnet", wallet, source, prover: provingService(option("zk")), journalPath, rebroadcastMillis: 60_000 });
  try {
    const resumed = await deployer.journalled();
    requireDustFloor(dust, resumed);
    const prepared = resumed ?? (await deployer.prepare());
    await confirm(prepared, deploySummary({ chain, wallet: wallet.addresses, dust, prepared }), () => deployer.discard(prepared));
    const deployment = await deployer.submit(prepared);
    const body = await source.node.call<{ block: { extrinsics: string[] } } | null>("chain_getBlock", [`0x${deployment.blockHash}`]);
    const extrinsics = body?.block.extrinsics.map((value) => new Uint8Array(Buffer.from(value.replace(/^0x/, ""), "hex"))) ?? [];
    if (includedTransactionIndex(extrinsics, prepared.bytes) === null) throw new Error("the node's block does not carry the deploy's bytes as exactly one Midnight.send_mn_transaction");
    if (!(await registryStateOnNode(source, deployment.address))) throw new Error(`the node holds no contract at ${deployment.address}`);
    process.stdout.write(`\ndeployed and read back from the node: ${JSON.stringify(deployment, null, 1)}\n`);
  } finally {
    deployer.close();
  }
});

// Deploys the immutable orynq-anchor-registry on Midnight MAINNET, for deci to run at his own
// terminal. Every check fails closed and comes before anything is sent (mainnet-session.ts holds
// the gates, the confirmation and the way out it shares with anchor-mainnet):
//   the process carries no Claude Code or Codex environment, and its input and output are a terminal;
//   the node is Midnight Mainnet (system_chain, genesis) on runtime 1000300;
//   the mnemonic derives exactly the recorded wallet, which holds at least the DUST floor
//   before preparing new bytes (journalled bytes already carry their fee);
//   the final, balanced bytes deploy exactly the registry's initial state (committee [],
//   threshold 1, counter 0, the pinned verifier keys).
// It then prints the exact summary and sends those bytes only after the token it shows, which
// names the bytes' transaction hash, is typed at that terminal; no flag, pipe, file or
// environment variable confirms. A deploy the journal still holds, as after a run that failed
// between its broadcast and its readback, is resumed instead of prepared anew: its bytes pass the
// same checks, the summary shows it as the journal holds it, and nothing is sent again before its
// token is typed. These gates stop accidents: an agent session running the script as it is,
// input from a pipe or a file, bytes other than the summarized ones. They do not stop code
// running as deci, which can drop the agent variables, drive a pseudo-terminal and type back
// the token it reads. Under the "ship now, harden after" decision the protection is procedural,
// deci running this himself; the custody boundary is the planned separate-uid or FIDO2 signer.
//   node --import tsx scripts/deploy-mainnet.ts [--mnemonic F] [--wallet-record F] [--blockfrost F]
//        [--wallet-state F] [--zk DIR] [--journal F] [--dust-floor DUST]
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { deploySummary, provingService, registryDeployer, registryStateOnNode } from "../src/index.js";
import { DEPLOY_JOURNAL, mainnetScript } from "./mainnet-session.js";

const { option, run, requireDustFloor, confirm } = mainnetScript({
  name: "deploy-mainnet",
  noun: "deploy",
  does: "runs a mainnet deploy",
  flags: { journal: DEPLOY_JOURNAL },
});

await run(async (connect) => {
  const { source, chain, syncWallet } = await connect();
  const wallet = await syncWallet();
  const { dust } = await wallet.balances();
  const journalPath = option("journal");
  mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
  const deployer = registryDeployer({ network: "mainnet", wallet, source, prover: provingService(option("zk")), journalPath });
  try {
    const resumed = await deployer.journalled();
    requireDustFloor(dust, resumed);
    const prepared = resumed ?? (await deployer.prepare());
    await confirm(prepared, deploySummary({ chain, wallet: wallet.addresses, dust, prepared }), () => deployer.discard(prepared));
    const deployment = await deployer.submit(prepared);
    if (!(await registryStateOnNode(source, deployment.address))) throw new Error(`the node holds no contract at ${deployment.address}`);
    process.stdout.write(`\ndeployed and read back from the node: ${JSON.stringify(deployment, null, 1)}\n`);
  } finally {
    deployer.close();
  }
});

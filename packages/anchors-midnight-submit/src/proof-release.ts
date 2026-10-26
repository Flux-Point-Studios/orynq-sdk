import { existsSync } from "node:fs";
import { join } from "node:path";
import * as L from "@midnight-ntwrk/ledger-v8";
import { type MidnightNetwork, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { chainView, openJournal, type AnchorKey } from "@fluxpointstudios/orynq-sdk-anchors-midnight/journal";
import { assertProofDeploy, assertPostedProof, buildProofDeploy, buildProofCall, proofProvider, PROOF_PINS, type ProofStatement } from "@fluxpointstudios/orynq-sdk-midnight-prover";
import { PROOF_RELEASE_CAPABILITY, PROOF_RELEASE_EVENT, proofReleaseStatements } from "../runner/proof-release-intent.js";
import { assertConfirmedHash, assertKnownRuntime, confirmedSends, declaredFee, finalTransaction, finalizeChecked, type FeeWallet, type PreparedBytes } from "./submission.js";

export const PROOF_RELEASE_LABELS = ["deploy", "proveCapability", "proveRolling1"] as const;
export type ProofReleaseLabel = typeof PROOF_RELEASE_LABELS[number];
export const proofReleaseJournal = (root: string) => join(root, "proof-release.sqlite");
const deployKey = (network: MidnightNetwork): AnchorKey => ({ network, registry: "proof-deploy", author: "", kind: 0, commitment: PROOF_PINS.initialStateSha256, attribute: "" });
const callKey = (network: MidnightNetwork, address: string, circuit: ProofStatement["circuit"]): AnchorKey => ({ network, registry: address, author: "", kind: circuit === "proveCapability" ? 2 : 1, commitment: PROOF_PINS.codeHash, attribute: "" });

export function landedProofDeploy(network: MidnightNetwork, path: string) {
  if (!existsSync(path)) return null;
  const journal = openJournal(path);
  try {
    const row = journal.live(deployKey(network));
    return row?.state === "landed" ? { address: assertProofDeploy(row.bytes, "final"), txHash: row.txHash, height: row.height, blockHash: row.blockHash } : null;
  } finally {
    journal.close();
  }
}

export function proofReleaseComplete(network: MidnightNetwork, path: string): boolean {
  const deploy = landedProofDeploy(network, path);
  if (!deploy) return false;
  const journal = openJournal(path);
  try {
    for (const circuit of ["proveCapability", "proveRolling1"] as const) {
      const row = journal.live(callKey(network, deploy.address, circuit));
      if (row?.state !== "landed") return false;
      const statement = proofReleaseStatements(row.ttl.getTime() / 1000).find(value => value.circuit === circuit)!;
      assertPostedProof(row.bytes, deploy.address, statement, row.ttl.getTime() - 1000);
    }
    return true;
  } finally {
    journal.close();
  }
}

export interface PreparedProofRelease extends PreparedBytes {
  label: ProofReleaseLabel;
  address: string;
  statement?: ProofStatement;
}

export function proofReleaseOperator(options: {
  network: MidnightNetwork; source: MidnightSource; wallet: FeeWallet; paramsDir: string; journalPath: string; expiresAt: number;
}) {
  const { network, source, wallet } = options;
  const journal = openJournal(options.journalPath);
  const chain = chainView(source, network);
  const provider = proofProvider(options.paramsDir);
  const prover = { prove: (tx: L.UnprovenTransaction) => tx.prove(provider, L.CostModel.initialCostModel()) };
  const address = () => {
    const landed = journal.live(deployKey(network));
    if (landed?.state !== "landed") throw new Error("Proof deploy has not landed");
    return assertProofDeploy(landed.bytes, "final");
  };
  const key = (label: ProofReleaseLabel): AnchorKey => {
    if (!(PROOF_RELEASE_LABELS as readonly string[]).includes(label)) throw new Error("Unknown proof release label");
    return label === "deploy" ? deployKey(network) : callKey(network, address(), label);
  };
  const sender = (label: ProofReleaseLabel) => confirmedSends({ journal, chain, wallet, network, pollMillis: 3000 }, key(label), label, "a proof release transaction");
  const describe = (label: ProofReleaseLabel, bytes: Uint8Array, ttl: Date, payer?: string, held?: PreparedBytes["journal"]): PreparedProofRelease => {
    key(label);
    const final = finalTransaction(bytes);
    if (![...(final.intents?.values() ?? [])].every(intent => intent.ttl.getTime() === ttl.getTime())) throw new Error("Proof release transaction TTL differs from its approved summary");
    const target = label === "deploy" ? assertProofDeploy(bytes, "final") : address();
    const statement = proofReleaseStatements(ttl.getTime() / 1000).find(value => value.circuit === label);
    if (statement) assertPostedProof(bytes, target, statement, ttl.getTime() - 1000);
    return { network, label, address: target, txHash: final.transactionHash(), bytes, ttl, declaredFee: declaredFee(final), ...(statement ? { statement } : {}), ...(payer ? { payer } : {}), ...(held ? { journal: held } : {}) };
  };
  return {
    async held(label: ProofReleaseLabel) {
      const row = await sender(label).held();
      return row ? describe(label, row.bytes, row.ttl, row.payer, { state: row.state, broadcasts: row.broadcasts, expired: row.expired }) : null;
    },
    async prepare(label: ProofReleaseLabel): Promise<PreparedProofRelease> {
      key(label);
      await assertKnownRuntime(source, network);
      const notAfter = Math.floor(Math.min(Date.now() + 3540_000, options.expiresAt) / 1000);
      if (notAfter * 1000 <= Date.now()) throw new Error("Proof release approval has expired");
      const ttl = new Date(notAfter * 1000);
      const statement = proofReleaseStatements(notAfter).find(value => value.circuit === label);
      const tx = label === "deploy" ? buildProofDeploy(network, ttl).tx : buildProofCall({ network, address: address(), statement: statement!, witness: label === "proveCapability" ? { capability: PROOF_RELEASE_CAPABILITY } : { eventDigest: PROOF_RELEASE_EVENT } }).tx;
      const { bytes } = await finalizeChecked(wallet, prover, tx, ttl, bytes => { describe(label, bytes, ttl); });
      return describe(label, bytes, ttl, wallet.addresses.unshielded);
    },
    async submit(prepared: PreparedProofRelease) {
      assertConfirmedHash(prepared);
      const checked = describe(prepared.label, prepared.bytes, prepared.ttl, prepared.payer, prepared.journal);
      return sender(prepared.label).submit(checked);
    },
    discard: (prepared: PreparedProofRelease) => wallet.discard(finalTransaction(prepared.bytes)),
    close: () => journal.close(),
  };
}

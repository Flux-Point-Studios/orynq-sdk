import * as L from "@midnight-ntwrk/ledger-v8";
import { buildProofCall, type ProofNetwork, type ProofStatement, type ProofWitness } from "./onchain.js";
import { assertPostedProof } from "./posted.js";
import { proofProvider } from "./proof-material.js";

export interface ProofWallet {
  readonly network: ProofNetwork;
  payFee(tx: L.Transaction<L.SignatureEnabled, L.Proof, L.PreBinding>, ttl: Date): Promise<L.FinalizedTransaction>;
  submit(tx: L.FinalizedTransaction): Promise<void>;
}

export async function post(options: {
  network: ProofNetwork; address: string; statement: ProofStatement; witness: ProofWitness;
  paramsDir: string; wallet: ProofWallet;
}) {
  if (options.wallet.network !== options.network) throw new Error("Wallet network mismatch");
  const statement = { ...options.statement };
  const now = Math.floor(Date.now() / 1000);
  if (statement.notAfter <= now || statement.notAfter > now + 3600) throw new Error("Proof deadline must be within the next hour");
  const witness = "capability" in options.witness ? { capability: new Uint8Array(options.witness.capability) } : { eventDigest: options.witness.eventDigest };
  try {
    const { tx, ttl } = buildProofCall({ network: options.network, address: options.address, statement, witness });
    const proven = await tx.prove(proofProvider(options.paramsDir), L.CostModel.initialCostModel());
    const final = await options.wallet.payFee(proven, ttl);
    const bytes = final.serialize();
    assertPostedProof(bytes, options.address, statement, Date.now());
    await options.wallet.submit(final);
    return { txHash: final.transactionHash(), address: options.address, statement };
  } finally {
    if ("capability" in witness) witness.capability.fill(0);
  }
}

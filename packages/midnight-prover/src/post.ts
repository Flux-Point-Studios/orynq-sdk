import * as L from "@midnight-ntwrk/ledger-v8";
import { nodeRefusal, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { assertProofWitness, buildProofCall, proofStateOnNode, type ProofNetwork, type ProofStatement, type ProofWitness } from "./onchain.js";
import { assertPostedProof } from "./posted.js";
import { proofProvider } from "./proof-material.js";

export interface ProofWallet {
  readonly network: ProofNetwork;
  payFee(tx: L.Transaction<L.SignatureEnabled, L.Proof, L.PreBinding>, ttl: Date): Promise<L.FinalizedTransaction>;
  submit(tx: L.FinalizedTransaction): Promise<void>;
  discard(tx: L.FinalizedTransaction): Promise<void>;
}

export async function post(options: {
  network: ProofNetwork; address: string; statement: ProofStatement; witness: ProofWitness;
  paramsDir: string; wallet: ProofWallet; source: MidnightSource;
}) {
  const { network, address, paramsDir, wallet, source, witness: suppliedWitness } = options;
  if (wallet.network !== network) throw new Error("Wallet network mismatch");
  if (source.network !== network) throw new Error("Proof source network mismatch");
  const statement = { ...options.statement };
  const witness = "capability" in suppliedWitness ? { capability: new Uint8Array(suppliedWitness.capability) } : { eventDigest: suppliedWitness.eventDigest };
  try {
    assertProofWitness(witness);
    const now = Math.floor(Date.now() / 1000);
    if (statement.notAfter <= now || statement.notAfter > now + 3600) throw new Error("Proof deadline must be within the next hour");
    for (let attempt = 1; ; attempt++) {
      if (statement.notAfter * 1000 <= Date.now()) throw new Error("Proof deadline passed");
      let final: L.FinalizedTransaction | undefined;
      try {
        const state = await proofStateOnNode(source, address);
        const { tx, ttl } = buildProofCall({ network, address, statement, witness, state });
        const proven = await tx.prove(proofProvider(paramsDir), L.CostModel.initialCostModel());
        final = await wallet.payFee(proven, ttl);
        try { assertPostedProof(final.serialize(), address, statement, Date.now()); }
        catch (error) { await wallet.discard(final); final = undefined; throw error; }
        await wallet.submit(final);
        return { txHash: final.transactionHash(), address, statement };
      } catch (error) {
        // Ledger-8 transcript failures (including gas) use Custom 104; other refusals do not retry.
        if (final) {
          const refusal = nodeRefusal(error);
          if (refusal?.code !== 1010 || refusal.data !== "Custom error: 104") throw error;
          await wallet.discard(final);
        } else if (!(error instanceof Error) || !/\bran out of gas budget\b/.test(error.message)) throw error;
        if (attempt >= 3) throw error;
      }
    }
  } finally {
    if ("capability" in witness) witness.capability.fill(0);
  }
}

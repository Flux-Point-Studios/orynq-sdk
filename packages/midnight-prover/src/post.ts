import * as L from "@midnight-ntwrk/ledger-v8";
import type { MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
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
  if (options.wallet.network !== options.network) throw new Error("Wallet network mismatch");
  assertProofWitness(options.witness);
  if (options.source.network !== options.network) throw new Error("Proof source network mismatch");
  const statement = { ...options.statement };
  const now = Math.floor(Date.now() / 1000);
  if (statement.notAfter <= now || statement.notAfter > now + 3600) throw new Error("Proof deadline must be within the next hour");
  const witness = "capability" in options.witness ? { capability: new Uint8Array(options.witness.capability) } : { eventDigest: options.witness.eventDigest };
  try {
    for (let attempt = 1; ; attempt++) {
      if (statement.notAfter * 1000 <= Date.now()) throw new Error("Proof deadline passed");
      let final: L.FinalizedTransaction | undefined;
      try {
        const state = await proofStateOnNode(options.source, options.address);
        const { tx, ttl } = buildProofCall({ network: options.network, address: options.address, statement, witness, state });
        const proven = await tx.prove(proofProvider(options.paramsDir), L.CostModel.initialCostModel());
        final = await options.wallet.payFee(proven, ttl);
        try { assertPostedProof(final.serialize(), options.address, statement, Date.now()); }
        catch (error) { await options.wallet.discard(final); final = undefined; throw error; }
        await options.wallet.submit(final);
        return { txHash: final.transactionHash(), address: options.address, statement };
      } catch (error) {
        // Only an explicit gas rejection permits new bytes; an ambiguous send may have landed.
        if (!(error instanceof Error) || !/\bran out of gas budget\b/.test(error.message)) throw error;
        if (final) await options.wallet.discard(final);
        if (attempt >= 3) throw error;
      }
    }
  } finally {
    if ("capability" in witness) witness.capability.fill(0);
  }
}

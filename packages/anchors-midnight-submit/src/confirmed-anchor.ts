import { verifyMidnightAnchor, type MidnightSource, type VerifyResult } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import type { AnchorReceipt, PreparedAnchor } from "./operator.js";

export type LandedVerifier = typeof verifyMidnightAnchor;
const verified = new WeakMap<AnchorReceipt, { source: MidnightSource; report: VerifyResult }>();

// A node's finalized-head answer alone never authorizes a public success record. The public
// verifier must authenticate inclusion/execution from the shipped signed trust checkpoints.
export async function verifyConfirmedAnchor(source: MidnightSource, prepared: PreparedAnchor, receipt: AnchorReceipt, verifier: LandedVerifier = verifyMidnightAnchor): Promise<VerifyResult> {
  if (receipt.network !== prepared.network || receipt.txHash !== prepared.txHash || receipt.registry !== prepared.registry || receipt.author !== prepared.author || receipt.kind !== prepared.kind || receipt.commitment !== prepared.commitment || receipt.attribute !== prepared.attribute) {
    throw new Error("the landed receipt differs from the confirmed anchor; results were not recorded");
  }
  const expect = prepared.kind === 2
    ? { kind: 2 as const, attribute: prepared.attribute }
    : prepared.kind === 3 ? { kind: 3 as const, commitment: prepared.commitment }
    : { kind: 1 as const, commitment: prepared.commitment };
  // Deliberately omit expectedAuthor: a caller-selected pin cannot supply author trust.
  const cached = verified.get(receipt);
  const report = cached?.source === source ? cached.report : await verifier({ network: prepared.network, txHash: prepared.txHash, expect }, { source, finality: "verify" });
  if (report.network !== prepared.network || report.txHash !== prepared.txHash || report.status !== "valid" || report.assurance !== "consensus-verified" || report.author?.status !== "known" ||
    report.author.key !== prepared.author || report.registry?.address !== prepared.registry || report.anchor?.kind !== prepared.kind ||
    report.anchor.address !== prepared.registry || report.anchor.author !== prepared.author || report.anchor.attribute !== prepared.attribute || report.anchor.commitment !== prepared.commitment || report.block?.height !== receipt.blockHeight || report.block.hash !== receipt.blockHash) {
    throw new Error("the anchor lacks consensus-verified known-author confirmation of its exact bytes and block; results were not recorded");
  }
  verified.set(receipt, { source, report });
  return report;
}

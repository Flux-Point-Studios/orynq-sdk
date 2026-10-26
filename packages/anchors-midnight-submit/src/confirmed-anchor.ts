import { verifyMidnightAnchor, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import type { AnchorReceipt, PreparedAnchor } from "./operator.js";

// A node's finalized-head answer alone never authorizes a public success record. The public
// verifier must authenticate inclusion/execution from the shipped signed trust checkpoints.
export async function verifyConfirmedAnchor(source: MidnightSource, prepared: PreparedAnchor, receipt: AnchorReceipt): Promise<void> {
  if (receipt.network !== prepared.network || receipt.txHash !== prepared.txHash || receipt.registry !== prepared.registry || receipt.author !== prepared.author || receipt.kind !== prepared.kind || receipt.commitment !== prepared.commitment || receipt.attribute !== prepared.attribute) {
    throw new Error("the landed receipt differs from the confirmed anchor; results were not recorded");
  }
  const expect = prepared.kind === 2
    ? { kind: 2 as const, attribute: prepared.attribute }
    : prepared.kind === 3 ? { kind: 3 as const, commitment: prepared.commitment }
    : { kind: 1 as const, commitment: prepared.commitment };
  // Deliberately omit expectedAuthor: a caller-selected pin cannot supply author trust.
  const report = await verifyMidnightAnchor({ network: prepared.network, txHash: prepared.txHash, expect }, { source, finality: "verify" });
  if (report.status !== "valid" || report.assurance !== "consensus-verified" || report.author?.status !== "known" ||
    report.author.key !== prepared.author || report.registry?.address !== prepared.registry || report.anchor?.kind !== prepared.kind ||
    report.anchor.commitment !== prepared.commitment || report.block?.height !== receipt.blockHeight || report.block.hash !== receipt.blockHash) {
    throw new Error("the anchor lacks consensus-verified known-author confirmation of its exact bytes and block; results were not recorded");
  }
}

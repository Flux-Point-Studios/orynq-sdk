import { decodeAnchorTransaction, type VerifyResult } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { deployed } from "./fakes.js";
import type { LandedVerifier } from "../src/confirmed-anchor.js";

// Explicit synthetic trust seam for unit tests. Production operators use real consensus proof.
export const fixtureVerifier: LandedVerifier = async (request, { source }) => {
  const [transaction] = await source.indexer.transactions(request.txHash);
  if (!transaction) throw new Error("test fixture lacks the landed transaction");
  const registry = deployed.address;
  const [anchor] = decodeAnchorTransaction(Buffer.from(transaction.raw.replace(/^0x/, ""), "hex"), [registry]).calls;
  if (!anchor) throw new Error("test fixture lacks the exact anchor call");
  return {
    status: "valid", assurance: "consensus-verified", network: request.network, txHash: request.txHash,
    operators: ["synthetic-test-only"], registry: { generation: 1, address: registry },
    block: { height: transaction.block.height, hash: transaction.block.hash }, anchor,
    author: { status: "known", key: anchor.author, id: "synthetic-test-only", role: anchor.kind === 3 ? "batch" : "relay", validFrom: 0, validTo: null },
    verifiedFields: [], notes: [], checks: [], finality: null, knownAuthorsSerial: 1,
  } satisfies VerifyResult;
};

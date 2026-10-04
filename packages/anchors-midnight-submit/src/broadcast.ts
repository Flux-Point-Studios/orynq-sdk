import { midnightExtrinsic, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

// Substrate's "Transaction Already Imported": the node already holds these exact bytes, so a
// second broadcast after a lost answer has nothing left to deliver.
const ALREADY_IMPORTED = /"code":1013\b/;

// Hands the exact final bytes to the node as the bare extrinsic Midnight.send_mn_transaction,
// over the source's JSON-RPC endpoint and its credential headers. Inclusion is learned from the
// indexer by transaction hash, never from this call.
export async function broadcast(source: MidnightSource, bytes: Uint8Array): Promise<void> {
  try {
    await source.node.call<string>("author_submitExtrinsic", [`0x${Buffer.from(midnightExtrinsic(bytes)).toString("hex")}`]);
  } catch (error) {
    if (!ALREADY_IMPORTED.test((error as Error).message)) throw error;
  }
}

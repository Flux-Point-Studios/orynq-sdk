import { midnightExtrinsic, type MidnightSource } from "@fluxpointstudios/orynq-sdk-anchors-midnight";

export interface NodeRefusal {
  code: number;
  message: string;
  data?: unknown;
}

const REFUSAL = /^\S+ node: author_submitExtrinsic failed: (\{.*\})$/s;

// The node's own JSON-RPC answer refusing a submission, as the source reports it. Anything else
// (a transport failure, an HTTP error, a timeout) is null: those bytes may have been delivered.
export function nodeRefusal(error: unknown): NodeRefusal | null {
  const json = error instanceof Error ? REFUSAL.exec(error.message)?.[1] : undefined;
  if (json === undefined) return null;
  const { code, message, data } = JSON.parse(json) as Record<string, unknown>;
  if (!Number.isSafeInteger(code) || typeof message !== "string") return null;
  return { code: code as number, message, ...(data === undefined ? {} : { data }) };
}

// Substrate's "Transaction Already Imported": the node already holds these exact bytes, so a
// second broadcast after a lost answer has nothing left to deliver.
const ALREADY_IMPORTED = 1013;

// Hands the exact final bytes to the node as the bare extrinsic Midnight.send_mn_transaction,
// over the source's JSON-RPC endpoint and its credential headers. Inclusion is learned from the
// indexer by transaction hash, never from this call.
export async function broadcast(source: MidnightSource, bytes: Uint8Array): Promise<void> {
  try {
    await source.node.call<string>("author_submitExtrinsic", [`0x${Buffer.from(midnightExtrinsic(bytes)).toString("hex")}`]);
  } catch (error) {
    if (nodeRefusal(error)?.code !== ALREADY_IMPORTED) throw error;
  }
}

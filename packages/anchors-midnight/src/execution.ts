import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { metadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { SourceConflict, type MidnightSource } from "./source.js";
import { headerFromRpc, headerHash, type BlockHeader, type RpcHeader } from "./substrate.js";
import { toHex } from "./scale.js";
import { provedValue } from "./storage-proof.js";

export const SYSTEM_EVENTS = "0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7";
export const TIMESTAMP_NOW = "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb";
export interface ExecutionRequest { blockHash: string; header: BlockHeader; extrinsicIndex: number; txHash: string }
export type ExecutionOutcome = "SUCCESS" | "PARTIAL_SUCCESS" | "FAILURE";
export interface BlockEffects {
  runtimeSpecVersion: number;
  timestamp: number;
  // First bind the exact bare Midnight send to this body index. Failed System events
  // contain no transaction hash and cannot establish that binding themselves.
  outcome(extrinsicIndex: number, txHash: string): ExecutionOutcome;
  assertApplications(sends: readonly { extrinsicIndex: number; txHash: string }[]): void;
}

const CODE_HASH = "0x39568eeb0802fa59d74ac0bc5c7ab62fc05c23ea947937458a4b011558516138";
const METADATA_SHA256 = "e3e9c651505c98e13f59377f05866b1a554458c5296f2acb0a1756d8ca0cdaa6";
let eventsCodec: ReturnType<ReturnType<typeof getDynamicBuilder>["buildStorage"]>["value"] | undefined;
function pinnedEventsCodec() {
  if (!eventsCodec) {
    const bytes = readFileSync(new URL("../runtime/1000300.scale", import.meta.url));
    if (createHash("sha256").update(bytes).digest("hex") !== METADATA_SHA256) throw new Error("Runtime metadata differs from its pin");
    const storage = getDynamicBuilder(getLookupFn(unifyMetadata(metadata.dec(bytes)))).buildStorage("System", "Events");
    if (storage.keys.enc() !== SYSTEM_EVENTS) throw new Error("Runtime metadata has an unexpected System.Events key");
    eventsCodec = storage.value;
  }
  return eventsCodec;
}

interface ReadProof { at: string; proof: string[] }
interface EventRecord { phase: { type: string; value: number }; event: { type: string; value: { type: string; value: unknown } } }
const terminal = ({ event }: EventRecord) => event.type === "Midnight" && ["TxApplied", "TxPartialSuccess"].includes(event.value.type);
function validateTarget(extrinsicIndex: number, txHash: string) {
  if (!Number.isSafeInteger(extrinsicIndex) || extrinsicIndex < 0 || !/^[0-9a-f]{64}$/.test(txHash)) throw new Error("Invalid execution target");
}

// Call only after GRANDPA has authenticated the target header. Its parent code executes it,
// including on a runtime-upgrade block whose post-state already contains different code.
export async function verifyBlockEffects(node: MidnightSource["node"], request: Pick<ExecutionRequest, "blockHash" | "header">): Promise<BlockEffects> {
  const { header } = request;
  const at = `0x${request.blockHash}`;
  if (toHex(headerHash(header)) !== request.blockHash) throw new Error("Execution header does not match its block");
  const parentAt = `0x${toHex(header.parentHash)}`;
  const [parentJson, parentProof, targetProof] = await node.batch([
    ["chain_getHeader", [parentAt]],
    // A strict extension exposes the committed code hash without fetching the Wasm value.
    ["state_getReadProof", [["0x3a636f646500"], parentAt]],
    ["state_getReadProof", [[SYSTEM_EVENTS, TIMESTAMP_NOW], at]],
  ]) as [RpcHeader, ReadProof, ReadProof];
  try {
    const parent = headerFromRpc(parentJson);
    if (toHex(headerHash(parent)) !== toHex(header.parentHash) || parent.number + 1 !== header.number) throw new Error("Executing parent header does not match the finalized header");
    if (parentProof.at !== parentAt || targetProof.at !== at) throw new Error("Execution proof identifies another block");
    if (provedValue(`0x${toHex(parent.stateRoot)}`, "0x3a636f6465", parentProof.proof, true) !== CODE_HASH) throw new Error("Executing runtime code is not supported");
    const root = `0x${toHex(header.stateRoot)}`;
    const encodedEvents = provedValue(root, SYSTEM_EVENTS, targetProof.proof);
    const time = provedValue(root, TIMESTAMP_NOW, targetProof.proof);
    if (!/^0x[0-9a-f]{16}$/.test(time)) throw new Error("Invalid authenticated timestamp");
    const timestamp = Number(Buffer.from(time.slice(2), "hex").readBigUInt64LE());
    if (!Number.isSafeInteger(timestamp)) throw new Error("Authenticated timestamp exceeds the integer range");
    const records = pinnedEventsCodec().dec(encodedEvents) as EventRecord[];
    return { runtimeSpecVersion: 1000300, timestamp, outcome(extrinsicIndex, txHash) {
      validateTarget(extrinsicIndex, txHash);
      const events = records.filter((event) => event.phase.type === "ApplyExtrinsic" && event.phase.value === extrinsicIndex);
      const system = events.filter(({ event }) => event.type === "System" && ["ExtrinsicSuccess", "ExtrinsicFailed"].includes(event.value.type));
      const midnight = events.filter(({ event }) => event.type === "Midnight");
      const terminals = midnight.filter(terminal);
      if (system.length === 1 && system[0]!.event.value.type === "ExtrinsicFailed" && midnight.length === 0) return "FAILURE";
      if (system.length === 1 && system[0]!.event.value.type === "ExtrinsicSuccess" && terminals.length === 1 && terminals[0]!.event.value.value === `0x${txHash}`) {
        if (terminals[0]!.event.value.type === "TxApplied") return "SUCCESS";
        if (terminals[0]!.event.value.type === "TxPartialSuccess") return "PARTIAL_SUCCESS";
      }
      throw new SourceConflict("Authenticated events do not identify an unambiguous Midnight execution outcome");
    }, assertApplications(sends) {
      const expected = new Map<number, string>();
      for (const send of sends) {
        validateTarget(send.extrinsicIndex, send.txHash);
        if (expected.has(send.extrinsicIndex)) throw new SourceConflict("Duplicate body-bound application index");
        expected.set(send.extrinsicIndex, `0x${send.txHash}`);
      }
      for (const record of records.filter(terminal)) {
        if (record.phase.type !== "ApplyExtrinsic" || expected.get(record.phase.value) !== record.event.value.value) throw new SourceConflict("Unmatched authenticated Midnight application");
      }
    } };
  } catch (error) {
    throw new SourceConflict(error instanceof Error ? error.message : String(error));
  }
}

export async function verifyExecution(node: MidnightSource["node"], request: ExecutionRequest): Promise<{ runtimeSpecVersion: number; timestamp: number }> {
  validateTarget(request.extrinsicIndex, request.txHash);
  const effects = await verifyBlockEffects(node, request);
  if (effects.outcome(request.extrinsicIndex, request.txHash) !== "SUCCESS") throw new SourceConflict("Authenticated events do not prove full execution of this Midnight transaction");
  return { runtimeSpecVersion: effects.runtimeSpecVersion, timestamp: effects.timestamp };
}

import { parseStrictJson, StrictJsonError } from "@fluxpointstudios/orynq-sdk-core/utils";
import { RpcError } from "./errors.js";

// ignoreBOM keeps a byte-order mark in the text, where JSON refuses it.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// The largest request the built-in rules allow, a release.commit of 8 mandates of 258 steps, holds
// about 50,000 values. schemaRules refuses to register an effect kind whose shapes would let a
// valid request hold more than this bound.
//
// The bound limits what a request builds, not what its bytes cost to read. Measured through
// parseJsonPayload on 16 MiB payloads within it (Node 22.23.4, shared 2.1 GHz Xeon vCPU, CPU time
// over 11 runs, peak RSS above the payload):
// - long keys or strings, escaped or raw 4-byte UTF-8: 0.13 to 0.27 s, at most 57 MiB;
// - 65,533 floats of 256 digits, each exactly between two doubles: 0.33 s, 21 MiB;
// - 21,000 floats of about 800 digits, each between two subnormal-range doubles, the worst
//   found: 0.56 to 0.62 s, 18 MiB. JSON.parse and the integer check each convert every float.
export const MAX_REQUEST_VALUES = 65_536;

// A payload is UTF-8 JSON with one meaning; anything else is a JSON-RPC parse error.
export function parseJsonPayload(payload: Uint8Array): unknown {
  let text: string;
  try {
    text = UTF8.decode(payload);
  } catch (cause) {
    throw new RpcError("PARSE_ERROR", { cause });
  }
  try {
    return parseStrictJson(text, payload.byteLength, MAX_REQUEST_VALUES);
  } catch (cause) {
    if (cause instanceof StrictJsonError) throw new RpcError("PARSE_ERROR", { cause });
    throw cause;
  }
}

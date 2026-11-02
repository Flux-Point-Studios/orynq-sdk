import { parseStrictJson, StrictJsonError } from "@fluxpointstudios/orynq-sdk-core/utils";
import { RpcError } from "./errors.js";

// ignoreBOM keeps a byte-order mark in the text, where JSON refuses it.
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// A payload is UTF-8 JSON with one meaning; anything else is a JSON-RPC parse error.
export function parseJsonPayload(payload: Uint8Array): unknown {
  let text: string;
  try {
    text = UTF8.decode(payload);
  } catch (cause) {
    throw new RpcError("PARSE_ERROR", { cause });
  }
  try {
    return parseStrictJson(text, payload.byteLength);
  } catch (cause) {
    if (cause instanceof StrictJsonError) throw new RpcError("PARSE_ERROR", { cause });
    throw cause;
  }
}

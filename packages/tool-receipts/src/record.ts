/**
 * @fileoverview Helpers to record `tool-receipt` events into a trace (issue #60).
 */

import type {
  TraceRun,
  TraceEvent,
  ToolReceiptEvent,
  Visibility,
} from "@fluxpointstudios/orynq-sdk-process-trace";
import { addEvent } from "@fluxpointstudios/orynq-sdk-process-trace";
import { sha256StringHex, canonicalize } from "@fluxpointstudios/orynq-sdk-core/utils";

/**
 * Deterministically hash a request/response payload for the `request.hash` /
 * `response.hash` commitments (canonical JSON, SHA-256 hex). Strings are hashed
 * as-is; everything else is canonicalized first.
 */
export async function hashToolPayload(value: unknown): Promise<string> {
  const serialized = typeof value === "string" ? value : canonicalize(value);
  return sha256StringHex(serialized);
}

export interface AddToolReceiptOptions {
  toolId: string;
  /** Commitment to the request (use {@link hashToolPayload}). */
  request: { hash: string };
  /** Commitment to the response, with an optional retained payload. */
  response: { hash: string; payload?: unknown };
  /** The independently-verifiable signed receipt. */
  receipt: ToolReceiptEvent["receipt"];
  /** Event visibility (default "private" — responses may carry PII). */
  visibility?: Visibility;
}

/**
 * Append a `tool-receipt` event to a span.
 *
 * @returns the recorded {@link ToolReceiptEvent} (with runtime fields).
 */
export async function addToolReceipt(
  run: TraceRun,
  spanId: string,
  opts: AddToolReceiptOptions
): Promise<ToolReceiptEvent> {
  if (!opts.toolId) throw new Error("addToolReceipt: toolId is required");
  if (!opts.receipt) throw new Error("addToolReceipt: receipt is required");

  const event: Omit<ToolReceiptEvent, "id" | "seq" | "timestamp" | "hash"> = {
    kind: "tool-receipt",
    visibility: opts.visibility ?? "private",
    toolId: opts.toolId,
    request: opts.request,
    response: opts.response,
    receipt: opts.receipt,
  };

  const recorded: TraceEvent = await addEvent(run, spanId, event);
  return recorded as ToolReceiptEvent;
}

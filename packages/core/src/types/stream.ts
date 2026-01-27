/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/core/src/types/stream.ts
 * @summary NDJson event types for streaming responses.
 *
 * This file defines the event types used in newline-delimited JSON (NDJson)
 * streaming responses from paid API endpoints. These types support both
 * Flux protocol streaming and general SSE-style streaming.
 *
 * Used by:
 * - Client-side stream parsers
 * - Server-side stream generators
 * - Response interceptors for streaming payment handling
 */

// ---------------------------------------------------------------------------
// Base Event Types
// ---------------------------------------------------------------------------

/**
 * Base interface for all NDJson stream events.
 * All events have a type discriminator and optional metadata.
 */
export interface BaseStreamEvent {
  /** Event type discriminator */
  type: string;
  /** Event timestamp (ISO 8601) */
  timestamp?: string;
  /** Correlation ID for request tracing */
  correlationId?: string;
}

// ---------------------------------------------------------------------------
// Payment Stream Events
// ---------------------------------------------------------------------------

/**
 * Event indicating payment is required to continue the stream.
 */
export interface PaymentRequiredEvent extends BaseStreamEvent {
  type: "payment_required";
  /** Invoice ID for the payment */
  invoiceId: string;
  /** Amount required in atomic units */
  amountUnits: string;
  /** Asset identifier */
  asset: string;
  /** Chain identifier (CAIP-2) */
  chain: string;
  /** Payment timeout in seconds */
  timeoutSeconds?: number;
  /** Full payment request details */
  request?: unknown;
}

/**
 * Event indicating payment has been received.
 */
export interface PaymentReceivedEvent extends BaseStreamEvent {
  type: "payment_received";
  /** Invoice ID that was paid */
  invoiceId: string;
  /** Transaction hash */
  txHash?: string;
  /** Amount received in atomic units */
  amountUnits: string;
}

/**
 * Event indicating payment has been confirmed on-chain.
 */
export interface PaymentConfirmedEvent extends BaseStreamEvent {
  type: "payment_confirmed";
  /** Invoice ID that was confirmed */
  invoiceId: string;
  /** Transaction hash */
  txHash: string;
  /** Number of confirmations */
  confirmations?: number;
}

// ---------------------------------------------------------------------------
// Content Stream Events
// ---------------------------------------------------------------------------

/**
 * Event containing a chunk of content data.
 */
export interface ContentChunkEvent extends BaseStreamEvent {
  type: "content_chunk";
  /** Content data (text, base64 binary, etc.) */
  data: string;
  /** Content encoding: "text" | "base64" | "json" */
  encoding?: "text" | "base64" | "json";
  /** Sequence number for ordering */
  sequence?: number;
  /** Whether this is the final chunk */
  final?: boolean;
}

/**
 * Event containing progress information.
 */
export interface ProgressEvent extends BaseStreamEvent {
  type: "progress";
  /** Progress percentage (0-100) */
  percent?: number;
  /** Current step number */
  current?: number;
  /** Total number of steps */
  total?: number;
  /** Human-readable status message */
  message?: string;
}

/**
 * Event indicating the stream has completed successfully.
 */
export interface CompleteEvent extends BaseStreamEvent {
  type: "complete";
  /** Summary of what was delivered */
  summary?: string;
  /** Total bytes delivered */
  totalBytes?: number;
  /** Total chunks delivered */
  totalChunks?: number;
  /** Final result data, if any */
  result?: unknown;
}

/**
 * Event indicating an error occurred.
 */
export interface ErrorEvent extends BaseStreamEvent {
  type: "error";
  /** Error code */
  code: string;
  /** Error message */
  message: string;
  /** Whether the error is retryable */
  retryable?: boolean;
  /** Suggested retry delay in milliseconds */
  retryAfterMs?: number;
}

// ---------------------------------------------------------------------------
// Metadata Events
// ---------------------------------------------------------------------------

/**
 * Event containing metadata about the stream.
 */
export interface MetadataEvent extends BaseStreamEvent {
  type: "metadata";
  /** Key-value metadata */
  data: Record<string, unknown>;
}

/**
 * Heartbeat event to keep connection alive.
 */
export interface HeartbeatEvent extends BaseStreamEvent {
  type: "heartbeat";
  /** Server timestamp */
  serverTime?: string;
}

// ---------------------------------------------------------------------------
// Union Type
// ---------------------------------------------------------------------------

/**
 * Union of all NDJson stream event types.
 * Discriminated union on the "type" field.
 */
export type NDJsonEvent =
  | PaymentRequiredEvent
  | PaymentReceivedEvent
  | PaymentConfirmedEvent
  | ContentChunkEvent
  | ProgressEvent
  | CompleteEvent
  | ErrorEvent
  | MetadataEvent
  | HeartbeatEvent;

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

/**
 * Type guard for payment required events.
 */
export function isPaymentRequiredEvent(
  event: NDJsonEvent
): event is PaymentRequiredEvent {
  return event.type === "payment_required";
}

/**
 * Type guard for payment received events.
 */
export function isPaymentReceivedEvent(
  event: NDJsonEvent
): event is PaymentReceivedEvent {
  return event.type === "payment_received";
}

/**
 * Type guard for payment confirmed events.
 */
export function isPaymentConfirmedEvent(
  event: NDJsonEvent
): event is PaymentConfirmedEvent {
  return event.type === "payment_confirmed";
}

/**
 * Type guard for content chunk events.
 */
export function isContentChunkEvent(
  event: NDJsonEvent
): event is ContentChunkEvent {
  return event.type === "content_chunk";
}

/**
 * Type guard for progress events.
 */
export function isProgressEvent(event: NDJsonEvent): event is ProgressEvent {
  return event.type === "progress";
}

/**
 * Type guard for complete events.
 */
export function isCompleteEvent(event: NDJsonEvent): event is CompleteEvent {
  return event.type === "complete";
}

/**
 * Type guard for error events.
 */
export function isErrorEvent(event: NDJsonEvent): event is ErrorEvent {
  return event.type === "error";
}

/**
 * Type guard for metadata events.
 */
export function isMetadataEvent(event: NDJsonEvent): event is MetadataEvent {
  return event.type === "metadata";
}

/**
 * Type guard for heartbeat events.
 */
export function isHeartbeatEvent(event: NDJsonEvent): event is HeartbeatEvent {
  return event.type === "heartbeat";
}

/**
 * Check if an event is payment-related.
 */
export function isPaymentEvent(
  event: NDJsonEvent
): event is
  | PaymentRequiredEvent
  | PaymentReceivedEvent
  | PaymentConfirmedEvent {
  return (
    event.type === "payment_required" ||
    event.type === "payment_received" ||
    event.type === "payment_confirmed"
  );
}

// ---------------------------------------------------------------------------
// Stream Parser Utilities
// ---------------------------------------------------------------------------

/**
 * Parse a single line of NDJson into an event object.
 *
 * @param line - A single line of NDJson text
 * @returns Parsed event or null if line is empty/invalid
 */
export function parseNDJsonLine(line: string): NDJsonEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed) as NDJsonEvent;
  } catch {
    return null;
  }
}

/**
 * Serialize an event to NDJson format.
 *
 * @param event - Event to serialize
 * @returns NDJson line (with newline)
 */
export function serializeNDJsonEvent(event: NDJsonEvent): string {
  return JSON.stringify(event) + "\n";
}

/**
 * Create an async iterator from a ReadableStream of NDJson.
 *
 * @param stream - ReadableStream of Uint8Array chunks
 * @returns AsyncGenerator yielding parsed events
 */
export async function* parseNDJsonStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<NDJsonEvent, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");

      // Keep incomplete last line in buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const event = parseNDJsonLine(line);
        if (event) yield event;
      }
    }

    // Process any remaining data
    if (buffer.trim()) {
      const event = parseNDJsonLine(buffer);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

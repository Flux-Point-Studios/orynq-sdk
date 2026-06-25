/**
 * @fileoverview Verification dispatch for tool-call receipts (issue #60).
 *
 * `verifyToolReceipts(bundle, ctx)` verifies every `tool-receipt` event in a
 * bundle; `verifyTrace(bundle, ctx)` additionally runs the full process-trace
 * `verifyBundle()` and folds the receipt result into its `checks` so a single
 * call gives auditors "did the trace verify AND did every tool actually return
 * what the wrapper claims".
 */

import type {
  ToolReceiptEvent,
  TraceBundle,
  TraceVerificationResult,
} from "@fluxpointstudios/orynq-sdk-process-trace";
import { verifyBundle } from "@fluxpointstudios/orynq-sdk-process-trace";
import {
  verifyStripeReceipt,
  verifyGitHubReceipt,
  verifyJwsReceipt,
  verifyHttpMessageReceipt,
  type ToolReceiptVerifyContext,
} from "./schemes.js";

/** A verifier for a single receipt scheme. */
export type ToolReceiptSchemeVerifier = (
  event: ToolReceiptEvent,
  ctx?: ToolReceiptVerifyContext
) => Promise<boolean>;

/** Built-in verifiers keyed by `receipt.scheme`. */
export const BUILTIN_TOOL_RECEIPT_VERIFIERS: Record<string, ToolReceiptSchemeVerifier> = {
  "stripe-webhook": verifyStripeReceipt,
  "github-webhook": verifyGitHubReceipt,
  jws: verifyJwsReceipt,
  "http-message-signatures": verifyHttpMessageReceipt,
};

/** Per-receipt verification result. */
export interface ToolReceiptVerificationResult {
  eventId: string;
  toolId: string;
  scheme: string;
  signer: string;
  verified: boolean;
  error?: string;
}

/** Context for {@link verifyToolReceipts}; extends key resolution with custom schemes. */
export interface VerifyToolReceiptsContext extends ToolReceiptVerifyContext {
  /** Register or override scheme verifiers (e.g. a custom/internal scheme). */
  verifiers?: Record<string, ToolReceiptSchemeVerifier>;
}

/** Extract all `tool-receipt` events from a bundle (ordered by seq). */
export function extractToolReceipts(bundle: TraceBundle): ToolReceiptEvent[] {
  return bundle.privateRun.events.filter(
    (e): e is ToolReceiptEvent => e.kind === "tool-receipt"
  );
}

/** Verify a single tool-receipt event. Never throws — failures land in `error`. */
export async function verifyToolReceipt(
  event: ToolReceiptEvent,
  ctx?: VerifyToolReceiptsContext
): Promise<ToolReceiptVerificationResult> {
  const scheme = event.receipt.scheme;
  const base = {
    eventId: event.id,
    toolId: event.toolId,
    scheme,
    signer: event.receipt.signer,
  };
  const verifier = ctx?.verifiers?.[scheme] ?? BUILTIN_TOOL_RECEIPT_VERIFIERS[scheme];
  if (!verifier) {
    return { ...base, verified: false, error: `no verifier registered for scheme "${scheme}"` };
  }
  try {
    const verified = await verifier(event, ctx);
    return { ...base, verified };
  } catch (error) {
    return {
      ...base,
      verified: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Aggregate outcome over all tool receipts in a bundle. */
export interface ToolReceiptsVerifyOutcome {
  valid: boolean;
  errors: string[];
  results: ToolReceiptVerificationResult[];
}

/** Verify every tool-receipt in a bundle. A trace with no receipts is `valid: true`. */
export async function verifyToolReceipts(
  bundle: TraceBundle,
  ctx?: VerifyToolReceiptsContext
): Promise<ToolReceiptsVerifyOutcome> {
  const events = extractToolReceipts(bundle);
  const results: ToolReceiptVerificationResult[] = [];
  for (const event of events) {
    results.push(await verifyToolReceipt(event, ctx));
  }
  const failed = results.filter((r) => !r.verified);
  return {
    valid: failed.length === 0,
    errors: failed.map(
      (f) => `tool-receipt "${f.toolId}" (${f.scheme}) failed${f.error ? `: ${f.error}` : ""}`
    ),
    results,
  };
}

/** Combined result of {@link verifyTrace}. */
export interface VerifyTraceResult extends TraceVerificationResult {
  toolReceipts: ToolReceiptsVerifyOutcome;
}

/**
 * Verify the whole trace AND its tool receipts in one call. The receipt outcome
 * is folded into `checks.toolReceiptsValid` (so `valid` reflects receipts too)
 * and also returned in full under `toolReceipts`.
 */
export async function verifyTrace(
  bundle: TraceBundle,
  ctx?: VerifyToolReceiptsContext
): Promise<VerifyTraceResult> {
  const outcome = await verifyToolReceipts(bundle, ctx);
  const result = await verifyBundle(bundle, {
    toolReceipts: () => ({ valid: outcome.valid, errors: outcome.errors }),
  });
  return { ...result, toolReceipts: outcome };
}

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
  responseCommitmentHash,
  jwsBindingContext,
  type ToolReceiptVerifyContext,
} from "./schemes.js";
import { hashToolPayload } from "./record.js";

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
  /**
   * True ONLY when the signature cryptographically binds this receipt to THIS
   * trace's runId AND the recorded request hash (self-signed JWS anti-lie path,
   * with a signed `orynqBinding.{runId,requestHash}` that both matched). A JWS
   * with no binding, or one that binds only the runId, is `false` — the request
   * is not authenticated. Always `false` for external webhook schemes
   * (stripe/github/rfc9421): those prove authenticity of the response body but
   * cannot cover our runId/request, so call-binding is not provable by the
   * signature and request-attribution must not be inferred — anti-replay for them
   * relies on the bundle Merkle commitment + the scheme's own timestamp window.
   */
  callBound: boolean;
  /** When not verified, a short machine-readable reason. */
  reason?: string;
  error?: string;
}

/** Case-insensitive, 0x-tolerant hex equality. */
function hexEq(a: string, b: string): boolean {
  const na = a.startsWith("0x") ? a.slice(2) : a;
  const nb = b.startsWith("0x") ? b.slice(2) : b;
  return na.toLowerCase() === nb.toLowerCase();
}

/** Context for {@link verifyToolReceipts}; extends key resolution with custom schemes. */
export interface VerifyToolReceiptsContext extends ToolReceiptVerifyContext {
  /** Register or override scheme verifiers (e.g. a custom/internal scheme). */
  verifiers?: Record<string, ToolReceiptSchemeVerifier>;
  /**
   * The enclosing trace's run id. Self-signed JWS receipts commit to it (and to
   * the request hash) so a genuine receipt cannot be lifted into another trace.
   * {@link verifyToolReceipts} supplies it automatically from the bundle.
   */
  runId?: string;
  /**
   * When true, a receipt whose signature does not provably bind THIS call
   * (runId + request hash) is `verified: false` with reason `call-binding-required`.
   * Use this when request-attribution must be cryptographic: it rejects unbound
   * JWS receipts and all webhook schemes (whose external signatures cannot cover
   * our request). Default false — call-binding is reported via `callBound` but not
   * required.
   */
  requireCallBinding?: boolean;
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
  // `callBound` reflects PROVEN call-binding, computed after the checks below —
  // never assumed from the scheme. Only a self-signed JWS carrying a signed
  // `orynqBinding.{runId,requestHash}` that both match can be call-bound; external
  // webhook schemes never can (their signature cannot cover our runId/request).
  const callBound = false;
  const verifier = ctx?.verifiers?.[scheme] ?? BUILTIN_TOOL_RECEIPT_VERIFIERS[scheme];
  if (!verifier) {
    return {
      ...base,
      callBound,
      verified: false,
      error: `no verifier registered for scheme "${scheme}"`,
    };
  }
  try {
    const sigValid = await verifier(event, ctx);
    if (!sigValid) return { ...base, callBound, verified: false, reason: "signature-invalid" };
    // A valid signature is necessary but NOT sufficient: the signed content
    // must commit to the recorded response, else a genuine receipt for output
    // A can be paired with a fabricated response B (issue #60's core guarantee).
    const commit = await responseCommitmentHash(event);
    if (commit === null) {
      return { ...base, callBound, verified: false, reason: "response-not-bound" };
    }
    if (!hexEq(commit, event.response.hash)) {
      return { ...base, callBound, verified: false, reason: "response-binding-mismatch" };
    }
    // Auditors read the retained human-readable `response.payload`; when present
    // it MUST hash to the bound `response.hash`, else an honest signature can be
    // paired with a fabricated payload the auditor sees.
    if (event.response.payload !== undefined) {
      const payloadHash = await hashToolPayload(event.response.payload);
      if (!hexEq(payloadHash, event.response.hash)) {
        return { ...base, callBound, verified: false, reason: "response-payload-mismatch" };
      }
    }
    // Self-signed JWS receipts additionally commit to a binding context
    // {runId, requestHash}. When present, the enclosing trace's runId AND the
    // recorded request hash MUST both match — this authenticates the request and
    // blocks lifting a genuine receipt into a different trace/request. A JWS that
    // binds only runId (or nothing) is NOT call-bound: its request is
    // unauthenticated. External webhooks can never cover runId/request, so their
    // anti-replay is the bundle Merkle commitment + timestamp.
    let provenCallBound = false;
    if (scheme === "jws") {
      const bound = jwsBindingContext(event);
      if (bound !== null) {
        // A signed binding is a commitment: any mismatch is a hard failure, not a
        // downgrade to "unbound" — the signer attested to a specific call.
        if (ctx?.runId !== undefined && bound.runId !== ctx.runId) {
          return { ...base, callBound, verified: false, reason: "call-binding-mismatch" };
        }
        if (bound.requestHash !== undefined && !hexEq(bound.requestHash, event.request.hash)) {
          return { ...base, callBound, verified: false, reason: "call-binding-mismatch" };
        }
        // Call-binding is PROVEN only when the request hash was signed and matched
        // AND the runId was verified against this trace. Binding only the runId
        // leaves the request unauthenticated → not call-bound.
        provenCallBound =
          bound.requestHash !== undefined &&
          hexEq(bound.requestHash, event.request.hash) &&
          ctx?.runId !== undefined &&
          bound.runId === ctx.runId;
      }
    }
    if (ctx?.requireCallBinding && !provenCallBound) {
      return { ...base, callBound: provenCallBound, verified: false, reason: "call-binding-required" };
    }
    return { ...base, callBound: provenCallBound, verified: true };
  } catch (error) {
    return {
      ...base,
      callBound,
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
  // Bind receipt verification to THIS trace's run id (self-signed anti-replay).
  // An explicit ctx.runId takes precedence for advanced callers.
  const boundCtx: VerifyToolReceiptsContext = {
    ...ctx,
    runId: ctx?.runId ?? bundle.privateRun.id,
  };
  const results: ToolReceiptVerificationResult[] = [];
  for (const event of events) {
    results.push(await verifyToolReceipt(event, boundCtx));
  }
  const failed = results.filter((r) => !r.verified);
  return {
    valid: failed.length === 0,
    errors: failed.map(
      (f) =>
        `tool-receipt "${f.toolId}" (${f.scheme}) failed${f.reason ? ` [${f.reason}]` : ""}${f.error ? `: ${f.error}` : ""}`
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

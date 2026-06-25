/**
 * @summary Main entry point for @fluxpointstudios/orynq-sdk-tool-receipts.
 *
 * Verifiable tool-call receipts for the Orynq process-trace SDK (issue #60).
 * Proves "the tool actually returned this response" — not just "the agent says
 * the tool returned this response" — by independently verifying signed receipts
 * recorded as `tool-receipt` events.
 *
 * Supported schemes: RFC 9421 HTTP Message Signatures, Stripe/GitHub webhook
 * signatures, and generic JWS. Plus a signing-proxy helper to wrap tools that
 * don't sign their responses natively (the "anti-lie" pattern).
 *
 * @example
 * ```typescript
 * import { addToolReceipt, hashToolPayload, verifyTrace } from "@fluxpointstudios/orynq-sdk-tool-receipts";
 *
 * await addToolReceipt(run, span.id, {
 *   toolId: "stripe.charges.create",
 *   request: { hash: await hashToolPayload(req) },
 *   response: { hash: await hashToolPayload(res), payload: res },
 *   receipt: { scheme: "stripe-webhook", signer: "acct_123", signature: sigHeader, signedPayload: rawBody },
 * });
 *
 * const result = await verifyTrace(bundle, { keys: { acct_123: process.env.STRIPE_WEBHOOK_SECRET! } });
 * // result.valid && result.toolReceipts.results[0].verified
 * ```
 */

// Recording helpers
export { addToolReceipt, hashToolPayload } from "./record.js";
export type { AddToolReceiptOptions } from "./record.js";

// Scheme verifiers + key-resolution context
export {
  verifyStripeReceipt,
  verifyGitHubReceipt,
  verifyJwsReceipt,
  verifyHttpMessageReceipt,
} from "./schemes.js";
export type { ToolReceiptVerifyContext } from "./schemes.js";

// Verification dispatch
export {
  BUILTIN_TOOL_RECEIPT_VERIFIERS,
  extractToolReceipts,
  verifyToolReceipt,
  verifyToolReceipts,
  verifyTrace,
} from "./verify.js";
export type {
  ToolReceiptSchemeVerifier,
  ToolReceiptVerificationResult,
  VerifyToolReceiptsContext,
  ToolReceiptsVerifyOutcome,
  VerifyTraceResult,
} from "./verify.js";

// Signing-proxy (anti-lie pattern)
export { createSigningProxy } from "./signing-proxy.js";
export type { SigningProxy, SigningProxyOptions, JwsAlg } from "./signing-proxy.js";

/** Package version. */
export const VERSION = "0.1.0";

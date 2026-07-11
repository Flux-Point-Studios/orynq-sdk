/**
 * @summary Round-3 hardening regression tests for tool-call receipts (#60).
 *
 * GitHub webhook signatures carry no timestamp, so freshness cannot be enforced
 * cryptographically — a genuine receipt replays across traces. When the caller
 * DOES record a `receipt.params.timestamp`, the GitHub verifier must enforce the
 * same tolerance window Stripe uses, so a stale receipt is rejected. Without a
 * timestamp the scheme stays authenticity-only (anti-replay via the bundle
 * Merkle commitment), which we assert still verifies.
 */

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  createTrace,
  addSpan,
  closeSpan,
  finalizeTrace,
} from "@fluxpointstudios/orynq-sdk-process-trace";
import type {
  TraceRun,
  TraceBundle,
  ToolReceiptEvent,
} from "@fluxpointstudios/orynq-sdk-process-trace";
import { addToolReceipt, hashToolPayload, verifyToolReceipts } from "../index.js";

async function traceWith(receipt: ToolReceiptEvent["receipt"], body: string): Promise<TraceBundle> {
  const run: TraceRun = await createTrace({ agentId: "agent-h3" });
  const span = addSpan(run, { name: "tool-call", visibility: "public" });
  await addToolReceipt(run, span.id, {
    toolId: "gh.webhook",
    request: { hash: await hashToolPayload({ q: 1 }) },
    response: { hash: await hashToolPayload(body), payload: body },
    receipt,
  });
  await closeSpan(run, span.id);
  return finalizeTrace(run);
}

describe("GitHub webhook freshness when a timestamp is recorded (#60 round-3)", () => {
  const secret = "gh_webhook_secret";
  const body = JSON.stringify({ action: "opened", number: 42 });
  const t = 1_900_000_000;
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  it("rejects a stale GitHub receipt when params.timestamp is outside tolerance", async () => {
    const bundle = await traceWith(
      {
        scheme: "github-webhook",
        signer: "gh:org/repo",
        signature: sig,
        signedPayload: body,
        params: { timestamp: String(t) },
      },
      body
    );
    const outcome = await verifyToolReceipts(bundle, {
      keys: { "gh:org/repo": secret },
      nowSec: t + 10_000, // far outside the 300s window
      toleranceSec: 300,
    });
    expect(outcome.results[0]!.verified).toBe(false);
    expect(outcome.results[0]!.error).toMatch(/tolerance/i);
  });

  it("verifies a fresh GitHub receipt when params.timestamp is within tolerance", async () => {
    const bundle = await traceWith(
      {
        scheme: "github-webhook",
        signer: "gh:org/repo",
        signature: sig,
        signedPayload: body,
        params: { timestamp: String(t) },
      },
      body
    );
    const outcome = await verifyToolReceipts(bundle, {
      keys: { "gh:org/repo": secret },
      nowSec: t + 30,
      toleranceSec: 300,
    });
    expect(outcome.results[0]!.verified).toBe(true);
  });

  it("still verifies a GitHub receipt with no timestamp (Merkle-committed anti-replay)", async () => {
    const bundle = await traceWith(
      { scheme: "github-webhook", signer: "gh:org/repo", signature: sig, signedPayload: body },
      body
    );
    const outcome = await verifyToolReceipts(bundle, { keys: { "gh:org/repo": secret } });
    expect(outcome.results[0]!.verified).toBe(true);
  });
});

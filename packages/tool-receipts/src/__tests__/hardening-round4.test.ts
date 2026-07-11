/**
 * @summary Round-4 hardening regression tests for tool-call receipts (#60).
 *
 * Closes the request-attribution + call-binding gaps left after round 3:
 *  - A genuine signed JWS response must not be attributable to a FABRICATED
 *    request. A JWS that binds only `runId` (no `requestHash`) is NOT call-bound,
 *    and `callBound` must reflect that.
 *  - `callBound` must be TRUE only when a binding was actually signed AND both
 *    the runId and requestHash matched — never hard-coded per scheme.
 *  - A tampered JWS signature must be caught deterministically (decoded-byte flip).
 *  - The algorithm-confusion guard must reject a DER-encoded SPKI public key fed
 *    into the HMAC path (raw Uint8Array, not just PEM/JWK).
 */

import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
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
import {
  addToolReceipt,
  hashToolPayload,
  verifyToolReceipts,
  createSigningProxy,
} from "../index.js";

const pem = (k: ReturnType<typeof generateKeyPairSync>["publicKey"]): string =>
  k.export({ type: "spki", format: "pem" }).toString();

/** Record a receipt whose request/response payloads are as given. */
async function traceWithReceipt(
  receipt: ToolReceiptEvent["receipt"],
  requestPayload: unknown,
  responsePayload: unknown
): Promise<TraceBundle> {
  const run: TraceRun = await createTrace({ agentId: "agent-h4" });
  const span = addSpan(run, { name: "tool-call", visibility: "public" });
  await addToolReceipt(run, span.id, {
    toolId: "demo.tool",
    request: { hash: await hashToolPayload(requestPayload) },
    response: { hash: await hashToolPayload(responsePayload), payload: responsePayload },
    receipt,
  });
  await closeSpan(run, span.id);
  return finalizeTrace(run);
}

describe("JWS request-attribution (#60 round-4)", () => {
  it("a JWS binding only runId is NOT call-bound (request is unauthenticated)", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const run: TraceRun = await createTrace({ agentId: "agent-h4" });
    // Bind only runId — no requestHash — mimicking a signer that scopes the run
    // but leaves the request unauthenticated.
    const proxy = createSigningProxy({
      signer: "tee://oracle",
      alg: "EdDSA",
      privateKey,
      publicKey: pem(publicKey),
      binding: { runId: run.id },
    });
    const payload = { price: 100 };
    const receipt = proxy.sign(payload);
    const span = addSpan(run, { name: "tool-call", visibility: "public" });
    await addToolReceipt(run, span.id, {
      toolId: "demo.tool",
      request: { hash: await hashToolPayload({ q: "genuine" }) },
      response: { hash: await hashToolPayload(payload), payload },
      receipt,
    });
    await closeSpan(run, span.id);
    const bundle = await finalizeTrace(run);

    const outcome = await verifyToolReceipts(bundle, { keys: { "tee://oracle": pem(publicKey) } });
    // Signature + response binding are honest, so the receipt still verifies...
    expect(outcome.results[0]!.verified).toBe(true);
    // ...but the request was never signed, so it MUST NOT be reported call-bound.
    expect(outcome.results[0]!.callBound).toBe(false);
  });

  it("a fully-bound JWS whose signed requestHash != recorded request.hash is rejected", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const run: TraceRun = await createTrace({ agentId: "agent-h4" });
    const payload = { price: 100 };
    // Signer commits to the hash of the GENUINE request it actually served.
    const genuineRequestHash = await hashToolPayload({ q: "genuine" });
    const proxy = createSigningProxy({
      signer: "tee://oracle",
      alg: "EdDSA",
      privateKey,
      publicKey: pem(publicKey),
      binding: { runId: run.id, requestHash: genuineRequestHash },
    });
    const receipt = proxy.sign(payload);
    // Attacker records the genuine signed response next to a FABRICATED request.
    const span = addSpan(run, { name: "tool-call", visibility: "public" });
    await addToolReceipt(run, span.id, {
      toolId: "demo.tool",
      request: { hash: await hashToolPayload({ q: "FABRICATED" }) },
      response: { hash: await hashToolPayload(payload), payload },
      receipt,
    });
    await closeSpan(run, span.id);
    const bundle = await finalizeTrace(run);

    const outcome = await verifyToolReceipts(bundle, { keys: { "tee://oracle": pem(publicKey) } });
    expect(outcome.results[0]!.verified).toBe(false);
    expect(outcome.results[0]!.reason).toBe("call-binding-mismatch");
  });

  it("a fully-bound JWS matching runId + requestHash is call-bound", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const run: TraceRun = await createTrace({ agentId: "agent-h4" });
    const payload = { price: 100 };
    const req = { q: "genuine" };
    const requestHash = await hashToolPayload(req);
    const proxy = createSigningProxy({
      signer: "tee://oracle",
      alg: "EdDSA",
      privateKey,
      publicKey: pem(publicKey),
      binding: { runId: run.id, requestHash },
    });
    const receipt = proxy.sign(payload);
    const span = addSpan(run, { name: "tool-call", visibility: "public" });
    await addToolReceipt(run, span.id, {
      toolId: "demo.tool",
      request: { hash: requestHash },
      response: { hash: await hashToolPayload(payload), payload },
      receipt,
    });
    await closeSpan(run, span.id);
    const bundle = await finalizeTrace(run);

    const outcome = await verifyToolReceipts(bundle, { keys: { "tee://oracle": pem(publicKey) } });
    expect(outcome.results[0]!.verified).toBe(true);
    expect(outcome.results[0]!.callBound).toBe(true);
  });
});

describe("callBound reflects reality, not scheme (#60 round-4)", () => {
  it("a no-binding JWS is verified but NOT call-bound", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const proxy = createSigningProxy({
      signer: "tee://oracle",
      alg: "EdDSA",
      privateKey,
      publicKey: pem(publicKey),
      // no binding
    });
    const payload = { price: 100 };
    const bundle = await traceWithReceipt(proxy.sign(payload), { q: 1 }, payload);
    const outcome = await verifyToolReceipts(bundle, { keys: { "tee://oracle": pem(publicKey) } });
    expect(outcome.results[0]!.verified).toBe(true);
    expect(outcome.results[0]!.callBound).toBe(false);
  });

  it("requireCallBinding rejects a JWS receipt that did not bind the call", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const proxy = createSigningProxy({
      signer: "tee://oracle",
      alg: "EdDSA",
      privateKey,
      publicKey: pem(publicKey),
    });
    const payload = { price: 100 };
    const bundle = await traceWithReceipt(proxy.sign(payload), { q: 1 }, payload);
    const outcome = await verifyToolReceipts(bundle, {
      keys: { "tee://oracle": pem(publicKey) },
      requireCallBinding: true,
    });
    expect(outcome.results[0]!.verified).toBe(false);
    expect(outcome.results[0]!.reason).toBe("call-binding-required");
  });

  it("webhook receipts are never reported call-bound", async () => {
    const { createHmac } = await import("node:crypto");
    const secret = "gh_webhook_secret";
    const body = JSON.stringify({ action: "opened", number: 42 });
    const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    const bundle = await traceWithReceipt(
      { scheme: "github-webhook", signer: "gh:org/repo", signature: sig, signedPayload: body },
      { q: 1 },
      body
    );
    const outcome = await verifyToolReceipts(bundle, { keys: { "gh:org/repo": secret } });
    expect(outcome.results[0]!.verified).toBe(true);
    expect(outcome.results[0]!.callBound).toBe(false);
  });

  it("requireCallBinding rejects a webhook receipt (request-attribution not provable)", async () => {
    const { createHmac } = await import("node:crypto");
    const secret = "gh_webhook_secret";
    const body = JSON.stringify({ action: "opened", number: 42 });
    const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    const bundle = await traceWithReceipt(
      { scheme: "github-webhook", signer: "gh:org/repo", signature: sig, signedPayload: body },
      { q: 1 },
      body
    );
    const outcome = await verifyToolReceipts(bundle, {
      keys: { "gh:org/repo": secret },
      requireCallBinding: true,
    });
    expect(outcome.results[0]!.verified).toBe(false);
    expect(outcome.results[0]!.reason).toBe("call-binding-required");
  });
});

describe("tampered JWS signature is caught deterministically (#60 round-4)", () => {
  it("flipping a decoded signature byte fails verification", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const proxy = createSigningProxy({ signer: "tee://x", alg: "EdDSA", privateKey, publicKey: pem(publicKey) });
    const payload = { a: 1 };
    const receipt = proxy.sign(payload);
    // Deterministic tamper: flip a byte in the DECODED signature, then re-encode.
    const sigBytes = Buffer.from(receipt.signature, "base64url");
    sigBytes[Math.floor(sigBytes.length / 2)] ^= 0xff;
    receipt.signature = sigBytes.toString("base64url");
    const bundle = await traceWithReceipt(receipt, { q: 1 }, payload);
    const outcome = await verifyToolReceipts(bundle, { keys: { "tee://x": pem(publicKey) } });
    expect(outcome.results[0]!.verified).toBe(false);
  });
});

describe("algorithm-confusion guard covers raw DER SPKI keys (#60 round-4)", () => {
  it("rejects an HS256 JWS whose HMAC 'secret' is a DER-encoded public key (Uint8Array)", async () => {
    // The victim's real ES256 public key, exported as DER SPKI bytes. An attacker
    // sets alg:HS256 and hopes the verifier HMACs with this public material.
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const derSpki = publicKey.export({ type: "spki", format: "der" }) as Buffer;

    // Craft an HS256 JWS the attacker "signs" with the public DER bytes as key.
    const { createHmac } = await import("node:crypto");
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ price: 1 })).toString("base64url");
    const signingInput = `${header}.${body}`;
    const forgedSig = createHmac("sha256", derSpki).update(signingInput).digest("base64url");

    const bundle = await traceWithReceipt(
      {
        scheme: "jws",
        signer: "tee://victim",
        signature: forgedSig,
        signedPayload: signingInput,
      },
      { q: 1 },
      { price: 1 }
    );
    // Auditor resolves the victim's key as raw DER bytes (Uint8Array).
    const outcome = await verifyToolReceipts(bundle, {
      resolveKey: () => new Uint8Array(derSpki),
    });
    expect(outcome.results[0]!.verified).toBe(false);
    // The guard fired (algorithm confusion), landing in `error`, not a silent pass.
    expect(outcome.results[0]!.error ?? "").toMatch(/algorithm confusion|asymmetric public key/i);
  });
});

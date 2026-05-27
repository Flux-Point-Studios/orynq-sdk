/**
 * Submit-flow tests with a mocked fetch boundary.
 */

import { describe, expect, it } from "vitest";

import {
  GatewayError,
  Observation,
  ObserverKeypair,
  SubmissionReceipt,
  SubmitError,
  canonicalContentHash,
  submitObservation,
} from "../index";

async function fixtureKp(): Promise<ObserverKeypair> {
  return ObserverKeypair.fromSeedHex("0x" + "a1".repeat(32));
}

function makeObs(): Observation {
  return new Observation({
    modelName: "claude-opus-4-7",
    modelVersion: "20260201",
    taxonomyId: "AUTO-MONEY-001",
    severity: "high",
    observerContext: "test",
    occurredAt: "2026-11-14T22:13:20Z",
  }).addEvidence({ prompt: "p", response: "r" });
}

interface MockCall {
  url: string;
  init: RequestInit;
}

function mockFetch(
  responses: Array<{ status: number; body: unknown }>,
): { fetchImpl: typeof fetch; calls: MockCall[] } {
  const calls: MockCall[] = [];
  let cursor = 0;
  const fetchImpl: typeof fetch = (async (
    input: URL | RequestInfo,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    calls.push({ url, init: init ?? {} });
    const r = responses[Math.min(cursor, responses.length - 1)];
    cursor += 1;
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("submitObservation", () => {
  it("signs and posts the canonical record", async () => {
    const kp = await fixtureKp();
    const obs = makeObs();
    const record = obs.toRecord(kp.ss58Address);
    const expected = canonicalContentHash(record);
    const { fetchImpl, calls } = mockFetch([
      {
        status: 200,
        body: {
          content_hash: expected,
          accepted_at: 1_700_000_001_000,
          materios_tx: null,
          cardano_anchor_tx: null,
        },
      },
    ]);
    const receipt = await submitObservation({
      record,
      keypair: kp,
      network: "preprod",
      apiKey: "matra_test_token",
      fetchImpl,
      retryBackoffSeconds: 0,
    });
    expect(receipt).toBeInstanceOf(SubmissionReceipt);
    expect(receipt.contentHash).toBe(expected);
    expect(receipt.gatewayStatus).toBe(200);
    expect(receipt.observerSs58).toBe(kp.ss58Address);
    expect(calls.length).toBe(1);
    const sent = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
    expect(sent.content_hash).toBe(expected);
    expect(sent.observer_pubkey).toBe(kp.publicHex);
    expect((sent.observer_signature as string).length).toBe(128);
    expect(sent.schema_version).toBe("ai_capability_observation_v1");
  });

  it("requires apiKey", async () => {
    const kp = await fixtureKp();
    const record = makeObs().toRecord(kp.ss58Address);
    await expect(
      submitObservation({
        record,
        keypair: kp,
        network: "preprod",
        apiKey: "",
      }),
    ).rejects.toBeInstanceOf(SubmitError);
  });

  it("rejects unknown network", async () => {
    const kp = await fixtureKp();
    const record = makeObs().toRecord(kp.ss58Address);
    await expect(
      submitObservation({
        record,
        keypair: kp,
        // @ts-expect-error — bad input by design
        network: "rocketnet",
        apiKey: "matra_test",
      }),
    ).rejects.toBeInstanceOf(SubmitError);
  });

  it("refuses a server content_hash that doesn't match", async () => {
    const kp = await fixtureKp();
    const record = makeObs().toRecord(kp.ss58Address);
    const { fetchImpl } = mockFetch([
      { status: 200, body: { content_hash: "ff".repeat(32), accepted_at: 0 } },
    ]);
    await expect(
      submitObservation({
        record,
        keypair: kp,
        network: "preprod",
        apiKey: "matra_test",
        fetchImpl,
        retryBackoffSeconds: 0,
      }),
    ).rejects.toBeInstanceOf(SubmitError);
  });

  it("raises GatewayError on 4xx", async () => {
    const kp = await fixtureKp();
    const record = makeObs().toRecord(kp.ss58Address);
    const { fetchImpl } = mockFetch([
      {
        status: 401,
        body: { ok: false, code: "AUTH_REJECTED", message: "bad token" },
      },
    ]);
    try {
      await submitObservation({
        record,
        keypair: kp,
        network: "preprod",
        apiKey: "matra_test",
        fetchImpl,
        retryBackoffSeconds: 0,
      });
      expect.fail("expected GatewayError");
    } catch (e) {
      expect(e).toBeInstanceOf(GatewayError);
      expect((e as GatewayError).status).toBe(401);
      expect((e as GatewayError).message).toContain("AUTH_REJECTED");
    }
  });

  it("retries once on 5xx", async () => {
    const kp = await fixtureKp();
    const record = makeObs().toRecord(kp.ss58Address);
    const expected = canonicalContentHash(record);
    const { fetchImpl, calls } = mockFetch([
      { status: 503, body: { ok: false } },
      { status: 200, body: { content_hash: expected, accepted_at: 1 } },
    ]);
    const receipt = await submitObservation({
      record,
      keypair: kp,
      network: "preprod",
      apiKey: "matra_test",
      fetchImpl,
      retryBackoffSeconds: 0,
    });
    expect(receipt.gatewayStatus).toBe(200);
    expect(calls.length).toBe(2);
  });

  it("Observation.submit accepts wallet=ObserverKeypair", async () => {
    const kp = await fixtureKp();
    const obs = makeObs();
    const record = obs.toRecord(kp.ss58Address);
    const expected = canonicalContentHash(record);
    const { fetchImpl } = mockFetch([
      { status: 200, body: { content_hash: expected, accepted_at: 1 } },
    ]);
    // Stub the global fetch since Observation.submit doesn't accept fetchImpl
    // directly. The implementation uses the module's fetch reference.
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const receipt = await obs.submit({
        wallet: kp,
        network: "preprod",
        apiKey: "matra_test",
      });
      expect(receipt.contentHash).toBe(expected);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("SubmissionReceipt.refresh populates materiosTx + cardanoAnchorTx", async () => {
    const kp = await fixtureKp();
    const receipt = new SubmissionReceipt({
      contentHash: "aa".repeat(32),
      gatewayStatus: 200,
      acceptedAt: 1,
      observerSs58: kp.ss58Address,
      body: {},
    });
    const fetchImpl: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          content_hash: "aa".repeat(32),
          materios_tx: "0xdeadbeef",
          cardano_anchor_tx: "cardano_tx_abcdef",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    await receipt.refresh({
      gatewayUrl: "https://example.invalid/preprod-blobs",
      apiKey: "matra_test",
      fetchImpl,
    });
    expect(receipt.materiosTx).toBe("0xdeadbeef");
    expect(receipt.cardanoAnchorTx).toBe("cardano_tx_abcdef");
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize } from "@fluxpointstudios/orynq-sdk-core/utils";
import { toProcessTraceEvent } from "@fluxpointstudios/orynq-sdk-conduct";
import { computeEventHash, getGenesisHash, updateRollingHash } from "@fluxpointstudios/orynq-sdk-process-trace";
import { describe, expect, it } from "vitest";
import { realEvent, type Kind } from "./guard-events.js";
import { sha256 } from "./openings.js";

// Characterization of existing code: each expected digest was computed by Python hashlib over the hex of the bytes, not
// by the code under test. The canonical bodies and their SHA-256 are the cross-language hash vectors.
const CONTEXT = { id: "550e8400-e29b-41d4-a716-000000000000", seq: 0, timestamp: "2026-10-27T00:00:00.000Z", visibility: "private" } as const;
const { vectors }: { vectors: { name: string; canonical: string; sha256: string }[] } =
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../fixtures/hash-vectors.json"), "utf8"));
const vector = (name: string) => vectors.find(v => v.name === name)!;

const KNOWN_EVENTS: readonly { kind: Kind; vector: string; eventHash: string; preimageBytes: number }[] = [
  { kind: "payment-action", vector: "conduct_guard_payment_action_event", eventHash: "709f085696c95052bad4c61d33d2e6488799ec1623c2e837b65a6e21a68903e7", preimageBytes: 563 },
  { kind: "payment-denial-4", vector: "conduct_guard_payment_denial_event", eventHash: "64821de51e579e64dea92eec2449439d22d43988e8619a1a7a2fc7b055c683ea", preimageBytes: 649 },
  { kind: "egress-action", vector: "conduct_guard_egress_action_event", eventHash: "0b6267b041a08142dacdfa8e56dabadce005ae4b5541885974d90b0fc61d2807", preimageBytes: 533 },
];

const GENESIS = "0a39030ff99fb578718bf7a15460aa1f2c1300c612e4813246a33970854712a4";
const ROLL_AFTER_PAYMENT = "2e046373144e9c91a25e2c700bcabc157d5a880bf699d8d0fbad4fdc2bba04ce";

describe("T-B03 known answers for guard events in process-trace", () => {
  it.each(KNOWN_EVENTS)("$kind: canonical body, body SHA-256 and domain-prefixed event hash", async known => {
    const event = toProcessTraceEvent((await realEvent(known.kind, "ascii-min")).guardEvent, CONTEXT);
    const canonical = canonicalize(event);
    expect(canonical).toBe(vector(known.vector).canonical);
    expect(Buffer.from(sha256(canonical)).toString("hex")).toBe(vector(known.vector).sha256);
    expect(Buffer.byteLength(`poi-trace:event:v1|${canonical}`)).toBe(known.preimageBytes);
    expect(await computeEventHash(event)).toBe(known.eventHash);
  });

  it("the genesis rolling hash", async () => {
    expect(await getGenesisHash()).toBe(GENESIS);
  });

  it("one rolling step over the payment event", async () => {
    expect(await updateRollingHash({ currentHash: GENESIS, itemCount: 0 }, KNOWN_EVENTS[0]!.eventHash)).toEqual({ currentHash: ROLL_AFTER_PAYMENT, itemCount: 1 });
  });
});

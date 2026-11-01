import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize } from "@fluxpointstudios/orynq-sdk-core/utils";
import { toProcessTraceEvent } from "@fluxpointstudios/orynq-sdk-conduct";
import { computeEventHash, getGenesisHash, updateRollingHash } from "@fluxpointstudios/orynq-sdk-process-trace";
import { describe, expect, it } from "vitest";
import { realEvent, type Kind } from "./guard-events.js";

// Characterization of existing code: each expected digest was computed by Python hashlib over the hex of the bytes, not
// by the code under test. The canonical bodies and their SHA-256 are the cross-language hash vectors.
const CONTEXT = { id: "550e8400-e29b-41d4-a716-000000000000", seq: 0, timestamp: "2026-10-27T00:00:00.000Z", visibility: "private" } as const;
const { vectors }: { vectors: { name: string; canonical: string; sha256: string }[] } =
  JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../../fixtures/hash-vectors.json"), "utf8"));
const vector = (name: string) => vectors.find(v => v.name === name)!;

const KNOWN_EVENTS: readonly { kind: Kind; vector: string; eventHash: string; preimageBytes: number }[] = [
  { kind: "payment-action", vector: "conduct_guard_payment_action_event", eventHash: "80a61d3af6702016d3597d66cad2fb2b59588534ffb03d7dc44d5fd1e086e156", preimageBytes: 563 },
  { kind: "payment-denial-4", vector: "conduct_guard_payment_denial_event", eventHash: "5e1123d9e980c32b5b15275cd8100576626fe41135dbd6952da9e90af22af4d9", preimageBytes: 649 },
  { kind: "egress-action", vector: "conduct_guard_egress_action_event", eventHash: "7c5a53bf53a1eab002825dca1107894d53d9549f9be756170d05bce4e84ca952", preimageBytes: 533 },
];

const GENESIS = "0a39030ff99fb578718bf7a15460aa1f2c1300c612e4813246a33970854712a4";
const ROLL_AFTER_PAYMENT = "cea4db92ca6783c8274f318e83be8e02cf379ed481dfb35a9b1f1ff73124fb01";

describe("T-B03 known answers for guard events in process-trace", () => {
  it.each(KNOWN_EVENTS)("$kind: canonical body, body SHA-256 and domain-prefixed event hash", async known => {
    const event = toProcessTraceEvent((await realEvent(known.kind, "ascii-min")).guardEvent, CONTEXT);
    const canonical = canonicalize(event);
    expect(canonical).toBe(vector(known.vector).canonical);
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(vector(known.vector).sha256);
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

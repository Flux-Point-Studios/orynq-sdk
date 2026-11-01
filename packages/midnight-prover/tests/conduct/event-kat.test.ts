import { createHash } from "node:crypto";
import { canonicalize } from "@fluxpointstudios/orynq-sdk-core/utils";
import { toProcessTraceEvent } from "@fluxpointstudios/orynq-sdk-conduct";
import { computeEventHash, getGenesisHash, updateRollingHash } from "@fluxpointstudios/orynq-sdk-process-trace";
import { describe, expect, it } from "vitest";
import { realEvent, type Kind } from "./guard-events.js";

// Characterization of existing code: each expected digest was computed by Python hashlib over the hex of the bytes, not
// by the code under test.
const CONTEXT = { id: "550e8400-e29b-41d4-a716-000000000000", seq: 0, timestamp: "2026-10-27T00:00:00.000Z", visibility: "private" } as const;
const MANDATE = "348a64c90302dad81b3cad80888beef6d22ad70590441d288024ad40d0272a67";
const TAIL = `"eventType":"orynq.conduct.guard.v1","id":"550e8400-e29b-41d4-a716-000000000000","kind":"custom","seq":0,"timestamp":"2026-10-27T00:00:00.000Z","visibility":"private"}`;
const PAYMENT = `{"data":{"action":{"amount":"5","asset":"USD","counterparty":"acme","kind":"payment","timestamp":"3"},"actionDigest":"221dd75f9b0346a60440af384e269940e071b68daf84b9d43c29b48089af7db7","actionKind":"payment","enforcedAt":"3","mandateCommitment":"${MANDATE}"`;

const KNOWN_EVENTS: readonly { kind: Kind; canonical: string; bodySha256: string; eventHash: string; preimageBytes: number }[] = [
  {
    kind: "payment-action",
    canonical: `${PAYMENT},"seq":"0","timestamp":"3","type":"orynq.conduct.guard.action.v1"},${TAIL}`,
    bodySha256: "4891494faa2692c06853412cf0d5801c4ef67e65d4953579dc712aeeef80b4f5",
    eventHash: "80a61d3af6702016d3597d66cad2fb2b59588534ffb03d7dc44d5fd1e086e156",
    preimageBytes: 563,
  },
  {
    kind: "payment-denial-4",
    canonical: `${PAYMENT},"reason":"SPEND_CAP_EXCEEDED","rule":"payment exceeds the remaining window spend cap","seq":"1","timestamp":"3","type":"orynq.conduct.guard.denial.v1"},${TAIL}`,
    bodySha256: "592d3a9312b168470d129f390bbef69e1b07c45a3407dd83d3f4d67fab50a17b",
    eventHash: "5e1123d9e980c32b5b15275cd8100576626fe41135dbd6952da9e90af22af4d9",
    preimageBytes: 649,
  },
  {
    kind: "egress-action",
    canonical: `{"data":{"action":{"destination":"api1","kind":"egress","timestamp":"3"},"actionDigest":"64f3623dca928c0de188a61ef45c1c08768925354974ca3981ef0ee135752274","actionKind":"egress","enforcedAt":"3","mandateCommitment":"${MANDATE}","seq":"0","timestamp":"3","type":"orynq.conduct.guard.action.v1"},${TAIL}`,
    bodySha256: "e36ffc7fb22a7943b987df2abf9fd40ec8a908984865aeab86b15b2644284e95",
    eventHash: "7c5a53bf53a1eab002825dca1107894d53d9549f9be756170d05bce4e84ca952",
    preimageBytes: 533,
  },
];

const GENESIS = "0a39030ff99fb578718bf7a15460aa1f2c1300c612e4813246a33970854712a4";
const ROLL_AFTER_PAYMENT = "cea4db92ca6783c8274f318e83be8e02cf379ed481dfb35a9b1f1ff73124fb01";

describe("T-B03 known answers for guard events in process-trace", () => {
  it.each(KNOWN_EVENTS)("$kind: canonical body, body SHA-256 and domain-prefixed event hash", async known => {
    const event = toProcessTraceEvent((await realEvent(known.kind, "ascii-min")).guardEvent, CONTEXT);
    const canonical = canonicalize(event);
    expect(canonical).toBe(known.canonical);
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(known.bodySha256);
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

import type { TraceEvent } from "@fluxpointstudios/orynq-sdk-process-trace";
import type { GuardAction } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import { classify, eventClass } from "../../scripts/conduct/template.mjs";
import { KINDS, maxClassEvent, PROFILES, realEvent, realEvents, SHAPES, traceScene } from "./guard-events.js";

const ascii = PROFILES["ascii-min"];
const ASCII_LENGTHS = { amount: 1, asset: 3, counterparty: 4, ts: 1, enforcedAt: 1, dataSeq: 1, traceSeq: 1, vis: 7 };
// The scalars JSON.stringify escapes: U+0000..U+001F, quotation mark and reverse solidus.
const ESCAPED = [...Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)), '"', "\\"];

const traced = async (action: GuardAction, egressMode: 0n | 1n = 1n): Promise<TraceEvent> =>
  (await traceScene("ascii-min", { egressMode, before: [], action })).event;
const payment = (fields: Partial<Extract<GuardAction, { kind: "payment" }>>): GuardAction =>
  ({ kind: "payment", asset: ascii.asset, amount: ascii.amount, counterparty: ascii.counterparty, timestamp: ascii.at, ...fields });

const refusal = (event: unknown) => {
  try {
    eventClass(classify(event));
  } catch (error) {
    return (error as Error).message.split(":")[0];
  }
  return "accepted";
};

describe("T-B04 classify places real guard events in their exact class", () => {
  it.each([
    ["ev_pa_ascii_min", () => realEvent("payment-action", "ascii-min"), "payment-action", ASCII_LENGTHS],
    ["ev_pd4_ascii_min", () => realEvent("payment-denial-4", "ascii-min"), "payment-denial-4", ASCII_LENGTHS],
    ["ev_ea_ascii_min", () => realEvent("egress-action", "ascii-min"), "egress-action", { destination: 4, ts: 1, enforcedAt: 1, dataSeq: 1, traceSeq: 1, vis: 7 }],
    ["ev_pa_unicode_max", () => realEvent("payment-action", "unicode-max"), "payment-action",
      { amount: 20, asset: 6, counterparty: 11, ts: 10, enforcedAt: 10, dataSeq: 2, traceSeq: 1, vis: 6 }],
    ["ev_pa_max", maxClassEvent, "payment-action", { amount: 20, asset: 128, counterparty: 256, ts: 20, enforcedAt: 20, dataSeq: 20, traceSeq: 16, vis: 7 }],
  ])("%s", async (id, make, kind, lengths) => {
    const classified = classify((await make()).event);
    expect(classified.kind).toBe(kind);
    expect(classified.lengths).toEqual(lengths);
    expect(eventClass(classified)).toBe(id);
  });

  it("refuses every other real event as NO_COMPILED_CLASS while still classifying its kind", async () => {
    const compiled = new Set(["ascii-min/payment-action", "ascii-min/payment-denial-4", "ascii-min/egress-action", "unicode-max/payment-action"]);
    const events = (await realEvents()).filter(e => !compiled.has(`${e.shape}/${e.kind}`));
    expect(events).toHaveLength(SHAPES.length * KINDS.length - compiled.size);
    for (const e of events) {
      expect(classify(e.event).kind).toBe(e.kind);
      expect(refusal(e.event), `${e.shape}/${e.kind}`).toBe("NO_COMPILED_CLASS");
    }
  });
});

describe("T-B04 classify refuses out-of-class events by name", () => {
  it.each(ESCAPED.map(c => [c.codePointAt(0)!.toString(16).padStart(4, "0"), c] as const))("ESCAPED_STRING: U+%s in an asset, a counterparty and a destination", async (_hex, c) => {
    const events = [
      await traced(payment({ asset: `U${c}D` })),
      await traced(payment({ counterparty: `ac${c}e` })),
      await traced({ kind: "egress", destination: `ap${c}1`, timestamp: ascii.at }),
    ];
    for (const event of events) expect(refusal(event)).toBe("ESCAPED_STRING");
  });

  it("TRACE_SEQ_UNSAFE: a trace sequence of 2^53, while 2^53 - 1 classifies", async () => {
    const scene = { egressMode: 1n, before: [], action: payment({}) } as const;
    expect(refusal((await traceScene("ascii-min", { ...scene, traceSeq: 2 ** 53 })).event)).toBe("TRACE_SEQ_UNSAFE");
    expect(classify((await traceScene("ascii-min", { ...scene, traceSeq: 2 ** 53 - 1 })).event).lengths.traceSeq).toBe(16);
  });

  it.each([["year 10000", Date.UTC(10000, 0, 1)], ["year -1", Date.UTC(-1, 0, 1)]])("ISO_OUT_OF_RANGE: a trace timestamp in %s", async (_label, time) => {
    const event = await traced(payment({}));
    expect(refusal({ ...event, timestamp: new Date(time).toISOString() })).toBe("ISO_OUT_OF_RANGE");
  });

  it("UNKNOWN_SHAPE: an extra event key, a missing key, or a custom event that is not a guard event", async () => {
    const event = await traced(payment({}));
    const { visibility: _visibility, ...missing } = event;
    const { seq: _seq, ...data } = (event as Extract<TraceEvent, { kind: "custom" }>).data;
    for (const shape of [{ ...event, extra: "x" }, missing, { ...event, data }, { ...event, eventType: "orynq.other.v1" }, { ...event, kind: "command" }]) {
      expect(refusal(shape)).toBe("UNKNOWN_SHAPE");
    }
  });

  it("TS_MISMATCH: guard data whose timestamp differs from its action's, built without the producer's snapshot", async () => {
    const event = await traced(payment({})) as Extract<TraceEvent, { kind: "custom" }>;
    expect(refusal({ ...event, data: { ...event.data, timestamp: "4" } })).toBe("TS_MISMATCH");
  });
});

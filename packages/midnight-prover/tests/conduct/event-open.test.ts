import { allowlistLeaf } from "@fluxpointstudios/orynq-sdk-conduct";
import { computeEventHash, getGenesisHash, updateRollingHash } from "@fluxpointstudios/orynq-sdk-process-trace";
import { describe, expect, it } from "vitest";
import { CLASSES, classify, render, TEMPLATE } from "../../scripts/conduct/template.mjs";
import { maxClassEvent, PROFILES, traceScene, traceSteps, type RealEvent } from "./guard-events.js";
import {
  fieldVariants, hexLinkForgeries, honestEvents, latin1, lexicalForgeries, malformedStrings, misjudged, openingOf, openingOutcome as outcome, rederived, rollAfterOf,
  runOpening, sha256, spliced, STRING_SEGMENTS, withByte, withWitness, witnessWidth,
} from "./openings.js";
import { chain, type RollStatement } from "./statement-checker.js";

const BINDING = /^failed assert: (hex opening|rolling root mismatch)$/;

const events = await honestEvents();
const halves = (hex: string) => [BigInt(`0x${hex.slice(0, 32)}`), BigInt(`0x${hex.slice(32)}`)] as const;

/** The statement an opening of `e` must disclose, computed from the guard event by the product's own functions. */
async function productStatement(e: RealEvent): Promise<Record<string, Uint8Array | bigint>> {
  const { guardEvent: g, event } = e;
  const roll = await updateRollingHash({ currentHash: e.rollBefore, itemCount: 0 }, await computeEventHash(event));
  const [actionDigestHi, actionDigestLo] = halves(g.actionDigest);
  const [mandateCommitmentHi, mandateCommitmentLo] = halves(g.mandateCommitment);
  const common = {
    prevRollHex: latin1(e.rollBefore), rollAfter: new Uint8Array(Buffer.from(roll.currentHash, "hex")),
    timestamp: g.timestamp, enforcedAt: g.enforcedAt, dataSeq: g.seq, traceSeq: BigInt(event.seq),
    actionDigestHi, actionDigestLo, mandateCommitmentHi, mandateCommitmentLo,
  };
  const a = g.action;
  return a.kind === "payment"
    ? { ...common, amount: a.amount, assetDigest: sha256(a.asset), counterpartyLeaf: allowlistLeaf(a.counterparty) }
    : { ...common, destinationLeaf: allowlistLeaf(a.destination) };
}

const ascii = PROFILES["ascii-min"];
const unicode = PROFILES["unicode-max"];
const pay = (amount: bigint, timestamp: bigint) => ({ kind: "payment", asset: ascii.asset, amount, counterparty: ascii.counterparty, timestamp }) as const;
/** A second honest event of each class, with other action values than the first's. */
const SECOND: readonly (readonly [string, () => Promise<RealEvent>])[] = [
  ["ev_pa_ascii_min", async () => ({ kind: "payment-action", shape: "ascii-min", ...(await traceScene("ascii-min", { egressMode: 1n, before: [], action: pay(3n, 4n) })) })],
  ["ev_pa_unicode_max", async () => ({
    kind: "payment-action", shape: "unicode-max",
    ...(await traceScene("unicode-max", { egressMode: 1n, before: [], action: { kind: "payment", asset: unicode.asset, amount: unicode.amount - 1n, counterparty: unicode.counterparty, timestamp: unicode.at + 1n } })),
  })],
  ["ev_pa_max", () => maxClassEvent(1n)],
  ["ev_pd4_ascii_min", async () => ({ kind: "payment-denial-4", shape: "ascii-min", ...(await traceScene("ascii-min", { egressMode: 1n, before: [pay(5n, 4n)], action: pay(7n, 4n) })) })],
  ["ev_ea_ascii_min", async () => ({ kind: "egress-action", shape: "ascii-min", ...(await traceScene("ascii-min", { egressMode: 1n, before: [], action: { kind: "egress", destination: ascii.destination, timestamp: 5n } })) })],
];
const seconds = new Map(await Promise.all(SECOND.map(async ([id, make]) => [id, await make()] as const)));

const honest = [...events].flatMap(([id, e]) => [[id, id, e], [`${id} (second)`, id, seconds.get(id)!]] as const);

describe("T-B06 every event class opens two honest guard events", () => {
  it.each(honest)("%s discloses the guard event's own values", async (_label, id, e) => {
    const opening = openingOf(e);
    expect(opening.circuit).toBe(id);
    const expected = await productStatement(e);
    expect(Buffer.from(expected.rollAfter as Uint8Array).toString("hex")).toBe(e.rollAfter);
    expect(await runOpening(opening)).toEqual(expected);
  });
});

describe("T-B07 every witness byte moved by one is refused, and each segment is bound to the event hash", () => {
  it.each([...events])("%s", async (id, e) => {
    const opening = openingOf(e);
    expect(await outcome(opening), "honest control").toBe("accepted");
    const expectedTried = 2 * witnessWidth(id);
    let tried = 0;
    const accepted: string[] = [];
    const reasons = new Map<string, Set<string>>();
    const resizings: [string, string][] = [];
    for (const [name, bytes] of Object.entries(opening.witnesses)) {
      reasons.set(name, new Set());
      for (let at = 0; at < bytes.length; at++) {
        for (const delta of [1, -1]) {
          const value = bytes[at]! + delta;
          if (value < 0 || value > 255) continue;
          tried += 1;
          const result = await outcome(withWitness(opening, name, withByte(bytes, at, value)));
          if (result === "accepted") accepted.push(`${name}[${at}]${delta > 0 ? "+1" : "-1"}`);
          else reasons.get(name)!.add(result);
        }
      }
      for (const resized of [bytes.subarray(1), Uint8Array.from([...bytes, 0x30])]) {
        resizings.push([`${name} of ${resized.length} bytes`, await outcome(withWitness(opening, name, resized))]);
      }
    }
    expect(accepted, "mutation accepted").toEqual([]);
    expect(tried).toBe(expectedTried);
    expect(resizings.filter(([, result]) => !/expected value of type Vector/.test(result)), "segments of the wrong length the binding takes").toEqual([]);
    const unbound = [...reasons].filter(([, messages]) => ![...messages].some(m => BINDING.test(m))).map(([name]) => name);
    expect(unbound, "segments with no rejection by the hash link").toEqual([]);
  });
});

describe("T-B07 every eventHex byte forged with rollAfter re-derived is refused by the hex link", () => {
  it.each([...events])("%s", async (_id, e) => {
    const opening = openingOf(e);
    expect(await outcome(opening), "honest control").toBe("accepted");
    const forgeries = hexLinkForgeries(opening);
    expect(forgeries.filter(f => f.refusal === "failed assert: hex opening")).toHaveLength(64);
    expect(await misjudged(forgeries, outcome), "mutation accepted").toEqual([]);
  });
});

describe("T-B08 no two statement fields of an honest opening hold one value, so a field read from another's bytes is refused", () => {
  it("has a second honest event of every class", () => {
    expect([...seconds.keys()].sort()).toEqual(Object.keys(CLASSES.openings.events).sort());
  });

  it.each(honest)("%s", (_label, _id, e) => {
    const fields = Object.entries(openingOf(e).statement).map(([field, value]) => [field, typeof value === "bigint" ? `${value}` : Buffer.from(value).toString("hex")] as const);
    expect(fields.flatMap(([a, value], i) => fields.slice(i + 1).filter(([, other]) => other === value).map(([b]) => `${a} = ${b} = ${value}`))).toEqual([]);
  });
});

describe("T-B08 every statement field moved by one is refused, and so is a chimera of two events of one class", () => {
  it.each([...events])("%s", async (_id, e) => {
    const opening = openingOf(e);
    expect(await outcome(opening), "honest control").toBe("accepted");
    const accepted: string[] = [];
    let tried = 0;
    for (const [field, value] of Object.entries(opening.statement)) {
      for (const variant of fieldVariants(field, value)) {
        tried += 1;
        if (await outcome({ ...opening, statement: { ...opening.statement, [field]: variant } }) === "accepted") accepted.push(`${field} = ${String(variant)}`);
      }
    }
    expect(accepted, "mutation accepted").toEqual([]);
    expect(tried).toBeGreaterThanOrEqual(3 * Object.keys(opening.statement).length);
  });

  it.each([...seconds])("%s: the bytes of one event under the statement of another", async (id, second) => {
    const [a, b] = [openingOf(events.get(id)!), openingOf(second)];
    expect([a.circuit, b.circuit]).toEqual([id, id]);
    expect(await outcome(b), "honest control").toBe("accepted");
    for (const statement of [b.statement, { ...b.statement, prevRollHex: a.statement.prevRollHex!, rollAfter: a.statement.rollAfter! }]) {
      expect(await outcome({ ...a, statement }), "mutation accepted").not.toBe("accepted");
    }
  });
});

describe("T-B09 the lexical gadgets refuse out-of-class bytes whose hash chain and statement hold", () => {
  it("tests every string segment of every compiled event class", () => {
    expect(STRING_SEGMENTS).toHaveLength(9);
  });

  it.each(STRING_SEGMENTS)("%s %s: malformed UTF-8 and every JSON-escaped byte", async (id, name) => {
    const forgeries = malformedStrings(openingOf(events.get(id)!), name);
    expect(forgeries.length).toBeGreaterThanOrEqual(34 + 9);
    expect(await misjudged(forgeries, outcome), "mutation accepted").toEqual([]);
  });

  it.each([["DEL", [0x7f]], ["U+2028", [0xe2, 0x80, 0xa8]], ["a leading BOM", [0xef, 0xbb, 0xbf]]])("positive control: %s in a counterparty opens", async (_label, head) => {
    const opening = openingOf(events.get("ev_pa_ascii_min")!);
    expect(await outcome(rederived(opening, "counterparty", spliced(opening.segments.counterparty!, head)))).toBe("accepted");
  });

  // Adding a class or a segment changes these counts, so its forgeries are reviewed with it.
  it("derives the lexical forgeries of every non-string segment of every compiled class, and those its widths cannot hold", () => {
    const counts = Object.fromEntries([...events].map(([id, e]) => [id, Object.values(lexicalForgeries(openingOf(e))).map(list => list.length)]));
    expect(counts).toEqual({ ev_pa_ascii_min: [34, 10], ev_pa_unicode_max: [38, 6], ev_pa_max: [43, 1], ev_pd4_ascii_min: [34, 10], ev_ea_ascii_min: [31, 8] });
  });

  it.each([...events])("%s: every non-string segment refuses bytes outside its lexical class", async (_id, e) => {
    expect(await misjudged(lexicalForgeries(openingOf(e)).forgeries, outcome), "mutation accepted").toEqual([]);
  });

  it("public and secret share a class: swapped without the hash chain it is refused, re-derived it is another valid event", async () => {
    const opening = openingOf(events.get("ev_pa_unicode_max")!);
    expect(Buffer.from(opening.segments.vis!).toString()).toBe("public");
    expect(await outcome(withWitness(opening, "ev_pa_unicode_max_vis", latin1("secret")))).toBe("failed assert: hex opening");
    expect(await outcome(rederived(opening, "vis", latin1("secret")))).toBe("accepted");
  });
});

describe("T-B10 an opening is bound to the event domain, and the checker to the rolling chain", () => {
  it.each(["poac:trace:event:v0|", "poi-trace:roll:v1|"])("the same JSON hashed under %s never opens", async domain => {
    for (const [id, e] of events) {
      const opening = openingOf(e);
      const json = render(classify(e.event)).slice(TEMPLATE.domain.length);
      const eventHex = latin1(Buffer.from(sha256(`${domain}${json}`)).toString("hex"));
      const rollAfter = rollAfterOf(latin1(e.rollBefore), eventHex);
      const forged = { ...withWitness(opening, `${id}_eventHex`, eventHex), statement: { ...opening.statement, rollAfter } };
      expect(await outcome(forged), id).toBe("failed assert: hex opening");
    }
  });

  it("chain() takes the disclosed statements of a trace in order and refuses any other order or encoding", async () => {
    const steps = await traceSteps("ascii-min", 1n, [pay(1n, 3n), pay(2n, 3n)]);
    expect(steps[0]!.rollBefore).toBe(await getGenesisHash());
    const [first, second] = await Promise.all(steps.map(async step => {
      const opening = openingOf({ kind: "payment-action", shape: "ascii-min", ...step });
      expect(opening.circuit).toBe("ev_pa_ascii_min");
      return await runOpening(opening) as RollStatement;
    }));
    await expect(chain([first!, second!])).resolves.toBeUndefined();
    const upper = (s: RollStatement) => ({ ...s, prevRollHex: latin1(Buffer.from(s.prevRollHex).toString("latin1").toUpperCase()) });
    await expect(chain([upper(first!), second!])).rejects.toThrow("prevRollHex 0 is not 64 lowercase hex digits");
    await expect(chain([second!])).rejects.toThrow("prevRollHex 0 is not the genesis rolling hash");
    await expect(chain([first!, first!])).rejects.toThrow("prevRollHex 1 is not the hex of rollAfter 0");
    await expect(chain([first!, upper(second!)])).rejects.toThrow("prevRollHex 1 is not 64 lowercase hex digits");
  });
});

import { allowlistLeaf } from "@fluxpointstudios/orynq-sdk-conduct";
import { computeEventHash, getGenesisHash, updateRollingHash } from "@fluxpointstudios/orynq-sdk-process-trace";
import { describe, expect, it } from "vitest";
import { CLASSES, classify, render, TEMPLATE } from "../../scripts/conduct/template.mjs";
import { PROFILES, traceScene, traceSteps, type RealEvent } from "./guard-events.js";
import {
  fieldVariants, hexLinkForgeries, honestEvents, LEXICAL_FORGERIES, latin1, malformedStrings, misjudged, openingOf, openingOutcome as outcome, rederived, rollAfterOf,
  runOpening, sha256, spliced, STRING_SEGMENTS, withByte, withWitness,
} from "./openings.js";
import { chain, type RollStatement } from "./statement-checker.js";

const BINDING = /^failed assert: (hex opening|rolling root mismatch)$/;
// Hex digests, the uuid, the ISO time and the event hash hex have fixed widths outside the class tuple.
const FIXED_WITNESS_BYTES = 64 + 64 + 36 + 24 + 64;

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

describe("T-B06 every event class opens an honest guard event", () => {
  it.each([...events])("%s discloses the guard event's own values", async (id, e) => {
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
    const lengths: Record<string, number> = CLASSES.openings.events[id].lengths;
    const expectedTried = 2 * (Object.values(lengths).reduce((sum, n) => sum + n, 0) + FIXED_WITNESS_BYTES);
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

const ascii = PROFILES["ascii-min"];
const pay = (amount: bigint, timestamp: bigint) => ({ kind: "payment", asset: ascii.asset, amount, counterparty: ascii.counterparty, timestamp }) as const;
const SECOND: readonly (readonly [string, () => Promise<RealEvent>])[] = [
  ["ev_pa_ascii_min", async () => ({ kind: "payment-action", shape: "ascii-min", ...(await traceScene("ascii-min", { egressMode: 1n, before: [], action: pay(3n, 4n) })) })],
  ["ev_pd4_ascii_min", async () => ({ kind: "payment-denial-4", shape: "ascii-min", ...(await traceScene("ascii-min", { egressMode: 1n, before: [pay(5n, 4n)], action: pay(2n, 4n) })) })],
  ["ev_ea_ascii_min", async () => ({ kind: "egress-action", shape: "ascii-min", ...(await traceScene("ascii-min", { egressMode: 1n, before: [], action: { kind: "egress", destination: ascii.destination, timestamp: 5n } })) })],
];

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

  it.each(SECOND)("%s: the bytes of one event under the statement of another", async (id, make) => {
    const [a, b] = [openingOf(events.get(id)!), openingOf(await make())];
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

  it.each(LEXICAL_FORGERIES.map(f => [f.forge(openingOf(events.get(f.circuit)!)), f.circuit] as const).map(([f, id]) => [`${id}: ${f.label}`, f] as const))(
    "refuses %s", async (_label, forgery) => {
      expect(await misjudged([forgery], outcome)).toEqual([]);
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

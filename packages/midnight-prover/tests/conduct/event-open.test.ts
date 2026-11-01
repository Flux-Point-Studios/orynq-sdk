import { createHash } from "node:crypto";
import { getGenesisHash } from "@fluxpointstudios/orynq-sdk-process-trace";
import { describe, expect, it } from "vitest";
import { CLASSES, classify, render, TEMPLATE } from "../../scripts/conduct/template.mjs";
import { PROFILES, traceScene, traceSteps, type RealEvent } from "./guard-events.js";
import { fieldVariants, honestEvents, latin1, openingOf, productStatement, rederived, runOpening, spliced, withByte, withWitness, type Opening } from "./openings.js";
import { chain, type RollStatement } from "./statement-checker.js";

const BINDING = /^failed assert: (hex opening|rolling root mismatch)$/;
// Hex digests, the uuid, the ISO time and the event hash hex have fixed widths outside the class tuple.
const FIXED_WITNESS_BYTES = 64 + 64 + 36 + 24 + 64;

const outcome = (opening: Opening) => runOpening(opening).then(() => "accepted", (error: Error) => error.message);

const events = await honestEvents();

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

const STRING_CLASS = "failed assert: string outside escape-free well-formed UTF-8 class";
const MALFORMED_UTF8: readonly (readonly [string, readonly number[]])[] = [
  ["CESU ED A0 80", [0xed, 0xa0, 0x80]], ["overlong C0 AF", [0xc0, 0xaf]], ["overlong E0 80 AF", [0xe0, 0x80, 0xaf]],
  ["overlong F0 80 80 AF", [0xf0, 0x80, 0x80, 0xaf]], ["above U+10FFFF F4 90 80 80", [0xf4, 0x90, 0x80, 0x80]],
  ...Array.from({ length: 32 }, (_, c) => [`raw 0x${c.toString(16).padStart(2, "0")}`, [c]] as const), ["raw quote", [0x22]], ["raw backslash", [0x5c]],
];
const STRING_SEGMENTS = [["ev_pa_ascii_min", "asset"], ["ev_pa_ascii_min", "counterparty"], ["ev_ea_ascii_min", "destination"], ["ev_pa_max", "asset"]] as const;

describe("T-B09 the lexical gadgets refuse out-of-class bytes whose hash chain and statement hold", () => {
  it.each(STRING_SEGMENTS)("%s %s: malformed UTF-8 and every JSON-escaped byte", async (id, name) => {
    const opening = openingOf(events.get(id)!);
    const refused: string[] = [];
    for (const [label, head] of MALFORMED_UTF8.filter(([, head]) => head.length <= opening.segments[name]!.length)) {
      if (await outcome(rederived(opening, name, spliced(opening.segments[name]!, head))) === STRING_CLASS) refused.push(label);
    }
    expect(refused).toEqual(MALFORMED_UTF8.filter(([, head]) => head.length <= opening.segments[name]!.length).map(([label]) => label));
  });

  it.each([["DEL", [0x7f]], ["U+2028", [0xe2, 0x80, 0xa8]], ["a leading BOM", [0xef, 0xbb, 0xbf]]])("positive control: %s in a counterparty opens", async (_label, head) => {
    const opening = openingOf(events.get("ev_pa_ascii_min")!);
    expect(await outcome(rederived(opening, "counterparty", spliced(opening.segments.counterparty!, head)))).toBe("accepted");
  });

  it.each([
    ["a leading zero", "ev_pa_unicode_max", "dataSeq", "01", {}, "failed assert: decimal leading zero"],
    ["a non-digit", "ev_pa_ascii_min", "enforcedAt", ":", {}, "failed assert: decimal digit"],
    ["a zero amount", "ev_pa_ascii_min", "amount", "0", {}, "failed assert: decimal nonzero"],
    ["the 20 digits of 2^64", "ev_pa_unicode_max", "amount", "18446744073709551616", { amount: 0n }, /cast from Field or Uint value to smaller Uint value failed/],
    ["the 16 digits of 2^53 as trace seq", "ev_pa_max", "traceSeq", "9007199254740992", {}, "failed assert: trace seq unsafe"],
    ["1e3 as trace seq", "ev_pa_max", "traceSeq", "1e30000000000000", {}, "failed assert: decimal digit"],
  ] as const)("refuses %s", async (_label, id, name, text, claim, refusal) => {
    const result = await outcome(rederived(openingOf(events.get(id)!), name, latin1(text), claim));
    if (typeof refusal === "string") expect(result).toBe(refusal);
    else expect(result).toMatch(refusal);
  });

  it.each([["actionDigest", "failed assert: noncanonical hex"], ["mandateCommitment", "failed assert: noncanonical hex"], ["id", "failed assert: uuid"]] as const)(
    "refuses uppercase hex in %s", async (name, refusal) => {
      const opening = openingOf(events.get("ev_pa_ascii_min")!);
      const bytes = opening.segments[name]!;
      const at = bytes.findIndex(b => b >= 0x61 && b <= 0x66);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(await outcome(rederived(opening, name, withByte(bytes, at, bytes[at]! - 0x20)))).toBe(refusal);
    });

  it.each([
    ["a uuid without its hyphen", "id", 8, 0x30, "failed assert: uuid"],
    ["an ISO time without its T", "iso", 10, 0x20, "failed assert: iso8601"],
    ["an ISO time with a letter for a digit", "iso", 0, 0x41, "failed assert: iso8601"],
    ["a visibility outside its class", "vis", 0, 0x50, "failed assert: visibility"],
  ] as const)("refuses %s", async (_label, name, at, value, refusal) => {
    const opening = openingOf(events.get("ev_pa_ascii_min")!);
    expect(await outcome(rederived(opening, name, withByte(opening.segments[name]!, at, value)))).toBe(refusal);
  });

  it("public and secret share a class: swapped without the hash chain it is refused, re-derived it is another valid event", async () => {
    const opening = openingOf(events.get("ev_pa_unicode_max")!);
    expect(Buffer.from(opening.segments.vis!).toString()).toBe("public");
    expect(await outcome(withWitness(opening, "ev_pa_unicode_max_vis", latin1("secret")))).toBe("failed assert: hex opening");
    expect(await outcome(rederived(opening, "vis", latin1("secret")))).toBe("accepted");
    expect(await outcome(rederived(opening, "vis", latin1("Public")))).toBe("failed assert: visibility");
  });
});

const sha256 = (text: string) => createHash("sha256").update(text).digest();

describe("T-B10 an opening is bound to the event domain, and the checker to the rolling chain", () => {
  it.each(["poac:trace:event:v0|", "poi-trace:roll:v1|"])("the same JSON hashed under %s never opens", async domain => {
    for (const [id, e] of events) {
      const opening = openingOf(e);
      const json = render(classify(e.event)).slice(TEMPLATE.domain.length);
      const eventHex = sha256(`${domain}${json}`).toString("hex");
      const rollAfter = new Uint8Array(sha256(`poi-trace:roll:v1|${e.rollBefore}|${eventHex}`));
      const forged = { ...withWitness(opening, `${id}_eventHex`, latin1(eventHex)), statement: { ...opening.statement, rollAfter } };
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

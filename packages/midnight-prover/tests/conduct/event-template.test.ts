import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize } from "@fluxpointstudios/orynq-sdk-core/utils";
import { computeEventHash } from "@fluxpointstudios/orynq-sdk-process-trace";
import { describe, expect, it } from "vitest";
import { KINDS, realEvents } from "./guard-events.js";
import { sha256, VALUE_CLASSES, type Segment } from "./openings.js";

const templateText = readFileSync(resolve(import.meta.dirname, "../../circuits/conduct/templates/guard-event-v1.json"), "utf8");
const template = JSON.parse(templateText);
const { classify, expandKinds, render } = await import("../../scripts/conduct/template.mjs");
const kinds: Record<string, Segment[]> = expandKinds();
const events = await realEvents();

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const constantBytes = (kind: string) => kinds[kind]!.reduce((sum, s) => sum + (s.c === undefined ? 0 : bytes(s.c)), 0);

const PLACEHOLDER: Readonly<Record<string, string>> = {
  dec64: "1", dec53: "1", str: "x", hex64: "0".repeat(64), uuid: "00000000-0000-0000-0000-000000000000", iso24: "2026-01-01T00:00:00.000Z", vis: "private",
};

// Key paths in order of appearance, the order canonicalize writes them in.
function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [`${prefix}${key}`, ...keyPaths(child, `${prefix}${key}.`)]);
}

const withoutDomain = (preimage: string) => {
  expect(preimage.startsWith(template.domain)).toBe(true);
  return preimage.slice(template.domain.length);
};

describe("T-B01 the guard-event template expands to every kind the guard writes", () => {
  it("yields the 11 kinds", () => {
    expect(Object.keys(kinds)).toEqual([...KINDS]);
  });

  it("puts 355 constant bytes in a payment action and 329 in an egress action", () => {
    expect(constantBytes("payment-action")).toBe(355);
    expect(constantBytes("egress-action")).toBe(329);
  });

  it.each([
    ["payment", 1, 78], ["payment", 2, 80], ["payment", 3, 67], ["payment", 4, 86], ["payment", 5, 90],
    ["egress", 1, 78], ["egress", 2, 80], ["egress", 6, 68], ["egress", 7, 82],
  ])("inserts the %s denial fields of reason %i in %i bytes", (action, code, insert) => {
    expect(constantBytes(`${action}-denial-${code}`) - constantBytes(`${action}-action`)).toBe(insert);
  });

  it.each(KINDS)("orders the keys of %s as canonicalize does on a real event", kind => {
    const rendered = kinds[kind]!.map(s => s.c ?? PLACEHOLDER[s.lex!]).join("");
    const real = events.filter(e => e.kind === kind);
    expect(real.length).toBeGreaterThan(0);
    for (const { event } of real) {
      const { hash: _hash, ...body } = event;
      expect(keyPaths(JSON.parse(withoutDomain(rendered)))).toEqual(keyPaths(JSON.parse(canonicalize(body))));
    }
  });
});

const shown = ({ lex, nonzero }: Segment) => `${lex}${nonzero === true ? " nonzero" : ""}`;

// Where the template's lexical class or floor of a value differs from the table the openings are audited and forged by.
function classDrift(actions: Readonly<Record<string, readonly Segment[]>>): string[] {
  const values = Object.entries(actions).flatMap(([action, parts]) => parts.filter(part => part.v !== undefined).map(part => [action, part] as const));
  return [
    ...values.flatMap(([action, part]) => {
      const audited = VALUE_CLASSES[part.v!];
      const expected = audited === undefined ? "absent" : shown(audited);
      return shown(part) === expected ? [] : [`${action} ${part.v} is ${shown(part)} in the template and ${expected} in the audited table`];
    }),
    ...Object.keys(VALUE_CLASSES).filter(v => !values.some(([, part]) => part.v === v)).map(v => `${v} is in the audited table and in no template action`),
  ];
}

describe("T-B01 the template declares each value in the lexical class and floor the openings are audited and forged by", () => {
  it("agrees with the audited table", () => {
    expect(classDrift(template.actions)).toEqual([]);
  });

  it("refuses a template without the amount floor or with the trace sequence read as any uint64, with exact messages", () => {
    const loosened = JSON.parse(templateText.replace(', "nonzero": true', "").replaceAll('"lex": "dec53"', '"lex": "dec64"'));
    expect(classDrift(loosened.actions)).toEqual([
      "payment amount is dec64 in the template and dec64 nonzero in the audited table",
      "payment traceSeq is dec64 in the template and dec53 in the audited table",
      "egress traceSeq is dec64 in the template and dec53 in the audited table",
    ]);
  });
});

describe("T-B02 render(classify(e)) is the preimage process-trace hashes, for real guard events", () => {
  it("covers every kind in every shape", () => {
    expect(events.map(e => `${e.shape}/${e.kind}`).sort()).toEqual(["ascii-min", "unicode-max", "max-in-class"].flatMap(shape => KINDS.map(kind => `${shape}/${kind}`)).sort());
  });

  it.each(events.map(e => [`${e.shape}/${e.kind}`, e] as const))("%s", async (_name, { kind, event }) => {
    const { hash, ...body } = event;
    const classified = classify(event);
    expect(classified.kind).toBe(kind);
    const preimage = Buffer.from(render(classified), "utf8");
    expect(preimage.equals(Buffer.from(`${template.domain}${canonicalize(body)}`, "utf8"))).toBe(true);
    const digest = Buffer.from(sha256(preimage)).toString("hex");
    expect(digest).toBe(await computeEventHash(event));
    expect(digest).toBe(hash);
  });
});

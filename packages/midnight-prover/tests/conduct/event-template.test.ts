import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize } from "@fluxpointstudios/orynq-sdk-core/utils";
import { computeEventHash } from "@fluxpointstudios/orynq-sdk-process-trace";
import { describe, expect, it } from "vitest";
import { KINDS, realEvents } from "./guard-events.js";
import { sha256, type Segment } from "./openings.js";

const template = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../circuits/conduct/templates/guard-event-v1.json"), "utf8"));
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

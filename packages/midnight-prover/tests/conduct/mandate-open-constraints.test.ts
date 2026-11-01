import { encodeMandate, hexToBytes } from "@fluxpointstudios/orynq-sdk-conduct";
import { describe, expect, it } from "vitest";
import { mandateOpening } from "../../scripts/conduct/template.mjs";
import { zkCheck } from "./harness.js";
import { MANDATE_VECTORS, mandateOpeningOf, runMandateOpening, stepMandate, type MandateOpening } from "./mandates.js";
import { OPENINGS_UNIT, witnessFunctions } from "./openings.js";

const base = mandateOpeningOf(hexToBytes(MANDATE_VECTORS.valid.find(v => v.name === "base allowlist-egress mandate")!.cborHex));
const step = mandateOpeningOf(encodeMandate(stepMandate()));

// Segments changed past the codec, with C and K re-derived from them, so the commitment and atoms bindings hold and only
// the circuit's schema rule can refuse.
function crafted(opening: MandateOpening, changes: Readonly<Record<string, readonly number[]>>): MandateOpening {
  const segments = { ...opening.segments, ...Object.fromEntries(Object.entries(changes).map(([name, bytes]) => [name, Uint8Array.from(bytes)])) };
  return { ...opening, segments, ...mandateOpening(opening.circuit, segments) };
}
const withHead = (bytes: Uint8Array, head: readonly number[]) => Array.from(bytes, (b, i) => head[i] ?? b);

const CASES: readonly (readonly [string, MandateOpening, string])[] = [
  ["notBefore equal to notAfter", crafted(base, { notBefore: [...base.segments.notAfter!] }), "mandate validity window"],
  ["notBefore after notAfter", crafted(base, { notBefore: [...base.segments.notAfter!], notAfter: [...base.segments.notBefore!] }), "mandate validity window"],
  ["a window of 0", crafted(step, { windowSeconds: [0] }), "mandate window"],
  ["egress mode 2", crafted(step, { egressMode: [2] }), "egress mode"],
  ["deny-all with a non-zero root", crafted(base, { egressMode: [0] }), "deny-all egress root"],
  ["a threshold above the committee size", crafted(step, { threshold: [2] }), "mandate disclosure threshold"],
  ["a threshold of 0", crafted(step, { threshold: [0] }), "mandate disclosure threshold"],
  ...[..."0OIl"].map(c => [`base58 character ${c} in the principal DID`, crafted(base, { principalDid: withHead(base.segments.principalDid!, [c.charCodeAt(0)]) }), "base58"] as const),
  ...[..."0OIl"].map(c => [`base58 character ${c} in the agent DID`, crafted(base, { agentDid: withHead(base.segments.agentDid!, [c.charCodeAt(0)]) }), "base58"] as const),
  ["a space in the asset", crafted(base, { asset: withHead(base.segments.asset!, [0x20]) }), "printable ASCII"],
  ["DEL in the asset", crafted(base, { asset: withHead(base.segments.asset!, [0x7f]) }), "printable ASCII"],
  ["an overlong in the committee id", crafted(base, { committeeId: withHead(base.segments.committeeId!, [0xc0, 0xaf]) }), "well-formed UTF-8"],
  ["a lone continuation byte in the committee id", crafted(base, { committeeId: withHead(base.segments.committeeId!, [0x80]) }), "well-formed UTF-8"],
  ["a surrogate in the committee id", crafted(base, { committeeId: withHead(base.segments.committeeId!, [0xed, 0xa0, 0x80]) }), "well-formed UTF-8"],
  ["a truncated sequence ending the committee id", crafted(step, { committeeId: [0xe2] }), "well-formed UTF-8"],
  ["a non-minimal four-byte cap", crafted(base, { capAmount: [0, 0, 0, 5] }), "cbor uint not minimal"],
  ["a non-minimal four-byte notAfter", crafted(base, { notAfter: [0, 0, 0xff, 0xff] }), "cbor uint not minimal"],
  ["a head byte above 23 where the class has no argument bytes", crafted(step, { capAmount: [24] }), "cbor head"],
];

describe("T-B15 the mandate circuits refuse CBOR crafted past the codec", () => {
  it.each([["base", base], ["step", step]] as const)("control: the honest %s mandate opens at JS and checks at ZKIR", async (_name, opening) => {
    await expect(runMandateOpening(opening)).resolves.toEqual(opening.statement);
    await expect(zkCheck(OPENINGS_UNIT, opening.circuit, witnessFunctions(opening.witnesses), [opening.statement])).resolves.toMatchObject({ mandateOpening: opening.statement });
  });

  it.each(CASES)("%s", async (_label, opening, message) => {
    expect(await runMandateOpening(opening).then(() => "invalid mandate opened", (error: Error) => error.message)).toBe(`failed assert: ${message}`);
    const checked = await zkCheck(OPENINGS_UNIT, opening.circuit, witnessFunctions(opening.witnesses), [opening.statement])
      .then(() => "invalid mandate opened", (error: Error) => error.message);
    expect(checked).toMatch(/Failed direct assertion/);
  });
});

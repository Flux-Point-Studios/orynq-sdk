import fc from "fast-check";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildAllowlistRoot, bytesToHex, cborDecode, cborEncode, decodeMandate, encodeMandate,
  equalBytes, hexToBytes, MandateError, MandateGuard, mandateCommitmentHex, type MandateV1,
} from "../../src/index.js";

const base: MandateV1 = {
  schemaVersion: 1n, mandateId: new Uint8Array(16).fill(7), principalDid: "did:key:z123456789",
  agentDid: "did:key:z987654321", didFormatVersion: 0n,
  spendCap: { asset: "lovelace", amount: 300n, windowSeconds: 3600n },
  counterpartyAllowlistRoot: buildAllowlistRoot(["alice"]),
  egressPolicy: { mode: 1n, allowlistRoot: buildAllowlistRoot(["api.example.com"]) },
  approvedMeasurementSetRoot: new Uint8Array(32).fill(4),
  validityWindow: { notBefore: 1n, notAfter: (1n << 64n) - 1n },
  disclosurePolicy: { committeeId: "cé", threshold: 1n, committeeSize: 2n },
};
const wire = encodeMandate(base);

function code(fn: () => unknown): string {
  try { fn(); } catch (e) { return e instanceof MandateError ? e.code : `NON_MANDATE:${(e as Error).name}`; }
  return "ACCEPTED";
}

describe("targeted non-canonical / forbidden encodings", () => {
  const cases: [string, string, string][] = [
    ["overlong NUL C0 80", "62c080", "CBOR_UTF8"],
    ["CESU surrogate ED A0 80", "63eda080", "CBOR_UTF8"],
    ["above U+10FFFF", "64f4908080", "CBOR_UTF8"],
    ["two-byte simple false f8 14", "f814", "CBOR_FORBIDDEN"],
    ["undefined", "f7", "CBOR_FORBIDDEN"],
    ["top-level break", "ff", "CBOR_FORBIDDEN"],
    ["self-describe tag 55799", "d9d9f700", "CBOR_FORBIDDEN"],
    ["bignum tag 2", "c2420100", "CBOR_FORBIDDEN"],
    ["uint indefinite ai 31", "1f", "CBOR_INDEFINITE"],
    ["reserved ai 28 bytes", "5c", "CBOR_MALFORMED"],
    ["reserved ai 30 map", "be", "CBOR_MALFORMED"],
    ["empty input", "", "CBOR_TRUNCATED"],
    ["array len exceeds input", "9b0000000100000000", "CBOR_TRUNCATED"],
    ["2^32-1 as 8 bytes", "1b00000000ffffffff", "CBOR_NONMINIMAL"],
  ];
  for (const [name, hex, want] of cases) {
    it(`${name} -> ${want}`, () => expect(code(() => cborDecode(hexToBytes(hex)))).toBe(want));
  }
  it("uint64 max and a BOM text round-trip exactly", () => {
    for (const hex of ["1bffffffffffffffff", "63efbbbf"]) {
      expect(bytesToHex(cborEncode(cborDecode(hexToBytes(hex))))).toBe(hex);
    }
  });
});

describe("mandate-level substitutions", () => {
  const hex = bytesToHex(wire);
  it("asset as bytes instead of text is a type error", () => {
    const swapped = hex.replace("686c6f76656c616365", "486c6f76656c616365");
    expect(swapped).not.toBe(hex);
    expect(code(() => decodeMandate(hexToBytes(swapped)))).toBe("SCHEMA_BAD_TYPE");
  });
  it("NFC and NFD committee ids are distinct mandates (no normalization, no collision)", () => {
    const nfd = { ...base, disclosurePolicy: { ...base.disclosurePolicy, committeeId: "cé" } };
    expect(mandateCommitmentHex(nfd)).not.toBe(mandateCommitmentHex(base));
  });
  it("commitment over a pooled Buffer view equals the commitment over a copy", () => {
    const pool = Buffer.alloc(wire.length + 64, 0xee);
    pool.set(wire, 17);
    const view = pool.subarray(17, 17 + wire.length);
    expect(mandateCommitmentHex(view)).toBe(mandateCommitmentHex(base));
  });
});

const mutate = fc.oneof(
  fc.record({ op: fc.constant("flip" as const), i: fc.nat(), v: fc.integer({ min: 0, max: 255 }) }),
  fc.record({ op: fc.constant("ins" as const), i: fc.nat(), v: fc.integer({ min: 0, max: 255 }) }),
  fc.record({ op: fc.constant("del" as const), i: fc.nat(), v: fc.constant(0) }),
);
function apply(bytes: Uint8Array, ms: { op: "flip" | "ins" | "del"; i: number; v: number }[]): Uint8Array {
  let a = Array.from(bytes);
  for (const m of ms) {
    if (a.length === 0) break;
    const i = m.i % a.length;
    if (m.op === "flip") a[i] = m.v;
    else if (m.op === "ins") a.splice(i, 0, m.v);
    else a.splice(i, 1);
  }
  return Uint8Array.from(a);
}

describe("fuzz: every accepted input is the canonical encoding of what it decodes to", () => {
  it("decodeMandate on mutated valid encodings", () => {
    let accepted = 0;
    fc.assert(fc.property(fc.array(mutate, { minLength: 1, maxLength: 4 }), (ms) => {
      const b = apply(wire, ms);
      let m: MandateV1;
      try { m = decodeMandate(b); } catch (e) { expect(e).toBeInstanceOf(MandateError); return; }
      accepted++;
      expect(equalBytes(encodeMandate(m), b)).toBe(true);
      expect(mandateCommitmentHex(b)).toBe(mandateCommitmentHex(m));
    }), { numRuns: 200_000, seed: 20261027 });
    expect(accepted).toBeGreaterThan(0);
  }, 600_000);

  it("cborDecode on arbitrary short byte strings", () => {
    let accepted = 0;
    fc.assert(fc.property(fc.uint8Array({ minLength: 0, maxLength: 12 }), (b) => {
      let v;
      try { v = cborDecode(b); } catch (e) { expect(e).toBeInstanceOf(MandateError); return; }
      accepted++;
      expect(bytesToHex(cborEncode(v))).toBe(bytesToHex(b));
    }), { numRuns: 300_000, seed: 7 });
    expect(accepted).toBeGreaterThan(1000);
  }, 600_000);
});

describe("Info: hostile input snapshots", () => {
  it("an allowlist with an own iterator cannot bypass committed membership", () => {
    const list = ["alice"];
    Object.defineProperty(list, Symbol.iterator, { value: function* () { yield "alice"; yield "mallory"; } });
    const m = { ...base, egressPolicy: { mode: 0n, allowlistRoot: new Uint8Array(32) } };
    expect(() => new MandateGuard({ mandate: m, counterpartyAllowlist: list })).toThrow(/allowlist/);
  });
  it("a proxied byte source validates and hashes the same copied bytes", () => {
    const evil = Uint8Array.from(wire);
    evil[2] = 0x02;
    expect(code(() => decodeMandate(evil))).toBe("SCHEMA_BAD_VERSION");
    let zeroReads = 0;
    const p = new Proxy(wire, {
      get(t, k) {
        if (k === "0") zeroReads++;
        const src = zeroReads > 1 ? evil : t;
        const v = Reflect.get(src, k);
        return typeof v === "function" ? v.bind(src) : v;
      },
    });
    const committed = mandateCommitmentHex(p as Uint8Array);
    const expected = createHash("sha256").update(Buffer.concat([Buffer.from("orynq:conduct:mandate:v1|"), evil])).digest("hex");
    expect(committed).not.toBe(expected);
    expect(committed).toBe(mandateCommitmentHex(wire));
  });
});

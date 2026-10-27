import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { equalBytes } from "../src/bytes.js";
import { cborDecode, cborEncode } from "../src/cbor.js";
import { decodeMandate, encodeMandate } from "../src/codec.js";
import { mandateCommitmentHex } from "../src/commitment.js";
import type { MandateV1 } from "../src/types.js";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const uint64 = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n });
const bytes32 = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((a) => new Uint8Array(a));
const didKey = fc
  .string({
    unit: fc.constantFrom(...BASE58.split("")),
    minLength: 8,
    maxLength: 48,
  })
  .map((s) => `did:key:z${s}`);
const asset = fc.string({
  unit: fc.constantFrom(..."abcdef0123456789.-_ABCDEF!~".split("")),
  minLength: 1,
  maxLength: 128,
});
const committeeId = fc
  .string({ minLength: 1, maxLength: 128 })
  .filter((s) => s.isWellFormed() && s.length >= 1 && Buffer.byteLength(s, "utf8") <= 128);

const arbMandate: fc.Arbitrary<MandateV1> = fc
  .record({
    mandateId: fc
      .uint8Array({ minLength: 16, maxLength: 16 })
      .map((a) => new Uint8Array(a)),
    principalDid: didKey,
    agentDid: didKey,
    asset,
    amount: uint64,
    windowSeconds: fc.bigInt({ min: 1n, max: (1n << 64n) - 1n }),
    counterpartyAllowlistRoot: bytes32,
    egress: fc.oneof(
      fc.constant<{ mode: bigint; root: Uint8Array | undefined }>({
        mode: 0n,
        root: undefined,
      }),
      bytes32.map((root) => ({ mode: 1n, root: root as Uint8Array | undefined })),
    ),
    approvedMeasurementSetRoot: bytes32,
    notBefore: fc.bigInt({ min: 0n, max: (1n << 63n) - 1n }),
    windowSpan: fc.bigInt({ min: 1n, max: 1n << 32n }),
    committeeId,
    threshold: fc.bigInt({ min: 1n, max: 96n }),
    extraMembers: fc.bigInt({ min: 0n, max: 32n }),
  })
  .map((r) => ({
    schemaVersion: 1n,
    mandateId: r.mandateId,
    principalDid: r.principalDid,
    agentDid: r.agentDid,
    didFormatVersion: 0n,
    spendCap: {
      asset: r.asset,
      amount: r.amount,
      windowSeconds: r.windowSeconds,
    },
    counterpartyAllowlistRoot: r.counterpartyAllowlistRoot,
    egressPolicy: {
      mode: r.egress.mode,
      allowlistRoot: r.egress.root ?? new Uint8Array(32),
    },
    approvedMeasurementSetRoot: r.approvedMeasurementSetRoot,
    validityWindow: {
      notBefore: r.notBefore,
      notAfter: r.notBefore + r.windowSpan,
    },
    disclosurePolicy: {
      committeeId: r.committeeId,
      threshold: r.threshold,
      committeeSize: r.threshold + r.extraMembers,
    },
  }));

describe("mandate properties", () => {
  it("decode(encode(m)) is the identity", () => {
    fc.assert(
      fc.property(arbMandate, (m) => {
        expect(decodeMandate(encodeMandate(m))).toEqual(m);
      }),
      { numRuns: 300 },
    );
  });

  it("encoding is deterministic and the commitment is stable across paths", () => {
    fc.assert(
      fc.property(arbMandate, (m) => {
        const a = encodeMandate(m);
        const b = encodeMandate({ ...m });
        expect(equalBytes(a, b)).toBe(true);
        expect(mandateCommitmentHex(m)).toBe(mandateCommitmentHex(a));
      }),
      { numRuns: 200 },
    );
  });

  it("re-encoding a decoded wire item reproduces the exact bytes (canonical fixpoint)", () => {
    fc.assert(
      fc.property(arbMandate, (m) => {
        const wire = encodeMandate(m);
        expect(equalBytes(cborEncode(cborDecode(wire)), wire)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("appending any byte to a valid encoding is rejected", () => {
    fc.assert(
      fc.property(arbMandate, fc.integer({ min: 0, max: 255 }), (m, extra) => {
        const wire = encodeMandate(m);
        const padded = new Uint8Array(wire.length + 1);
        padded.set(wire, 0);
        padded[wire.length] = extra;
        expect(() => decodeMandate(padded)).toThrowError();
      }),
      { numRuns: 100 },
    );
  });

  it("truncating a valid encoding is rejected", () => {
    fc.assert(
      fc.property(
        arbMandate,
        fc.integer({ min: 1, max: 16 }),
        (m, cut) => {
          const wire = encodeMandate(m);
          expect(() => decodeMandate(wire.slice(0, wire.length - cut))).toThrowError();
        },
      ),
      { numRuns: 100 },
    );
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hexToBytes } from "../src/bytes.js";
import { decodeMandate, encodeMandate } from "../src/codec.js";
import { bytesToHex } from "../src/bytes.js";
import {
  MANDATE_COMMITMENT_DOMAIN,
  mandateCommitmentHex,
} from "../src/commitment.js";
import { MandateError } from "../src/errors.js";
import type { MandateV1 } from "../src/types.js";

interface JsonMandate {
  schemaVersion: string;
  mandateId: string;
  principalDid: string;
  agentDid: string;
  didFormatVersion: string;
  spendCap: { asset: string; amount: string; windowSeconds: string };
  counterpartyAllowlistRoot: string;
  egressPolicy: { mode: string; allowlistRoot: string };
  approvedMeasurementSetRoot: string;
  validityWindow: { notBefore: string; notAfter: string };
  disclosurePolicy: {
    committeeId: string;
    threshold: string;
    committeeSize: string;
  };
}

interface Vectors {
  schemaVersion: number;
  commitmentDomain: string;
  valid: {
    name: string;
    mandate: JsonMandate;
    cborHex: string;
    commitmentHex: string;
  }[];
  invalid: { name: string; cborHex: string; code: string }[];
}

const vectors: Vectors = JSON.parse(
  readFileSync(new URL("./fixtures/mandate-vectors.json", import.meta.url), "utf8"),
);

function fromJson(j: JsonMandate): MandateV1 {
  return {
    schemaVersion: BigInt(j.schemaVersion),
    mandateId: hexToBytes(j.mandateId),
    principalDid: j.principalDid,
    agentDid: j.agentDid,
    didFormatVersion: BigInt(j.didFormatVersion),
    spendCap: {
      asset: j.spendCap.asset,
      amount: BigInt(j.spendCap.amount),
      windowSeconds: BigInt(j.spendCap.windowSeconds),
    },
    counterpartyAllowlistRoot: hexToBytes(j.counterpartyAllowlistRoot),
    egressPolicy: {
      mode: BigInt(j.egressPolicy.mode),
      allowlistRoot: hexToBytes(j.egressPolicy.allowlistRoot),
    },
    approvedMeasurementSetRoot: hexToBytes(j.approvedMeasurementSetRoot),
    validityWindow: {
      notBefore: BigInt(j.validityWindow.notBefore),
      notAfter: BigInt(j.validityWindow.notAfter),
    },
    disclosurePolicy: {
      committeeId: j.disclosurePolicy.committeeId,
      threshold: BigInt(j.disclosurePolicy.threshold),
      committeeSize: BigInt(j.disclosurePolicy.committeeSize),
    },
  };
}

describe("golden vectors: shape", () => {
  it("pins at least 10 vectors including adversarial encodings", () => {
    expect(vectors.valid.length + vectors.invalid.length).toBeGreaterThanOrEqual(10);
    expect(vectors.invalid.length).toBeGreaterThanOrEqual(5);
    expect(vectors.commitmentDomain).toBe(MANDATE_COMMITMENT_DOMAIN);
  });
});

describe("golden vectors: valid", () => {
  for (const v of vectors.valid) {
    it(`${v.name}: encode → bytes, commit → hash, decode → identity`, () => {
      const mandate = fromJson(v.mandate);
      expect(bytesToHex(encodeMandate(mandate))).toBe(v.cborHex);
      expect(mandateCommitmentHex(mandate)).toBe(v.commitmentHex);
      expect(mandateCommitmentHex(hexToBytes(v.cborHex))).toBe(v.commitmentHex);
      expect(decodeMandate(hexToBytes(v.cborHex))).toEqual(mandate);
    });
  }
});

describe("golden vectors: adversarial", () => {
  for (const v of vectors.invalid) {
    it(`${v.name} → ${v.code}`, () => {
      let thrown: unknown;
      try {
        decodeMandate(hexToBytes(v.cborHex));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(MandateError);
      expect((thrown as MandateError).code).toBe(v.code);
    });
  }
});

describe("commitment hash stability", () => {
  it("pins the base vector commitment as a known answer", () => {
    // Literal duplicated from the fixture on purpose: a regeneration that
    // silently changes hashes must fail HERE, in reviewed source, not only
    // in a regenerated JSON file.
    const base = vectors.valid[0] as Vectors["valid"][number];
    expect(base.commitmentHex).toBe(
      "22a6735085042fe7f4e973bec93066bac8036cc0a55543866968e3e11cffee0b",
    );
    expect(mandateCommitmentHex(fromJson(base.mandate))).toBe(
      "22a6735085042fe7f4e973bec93066bac8036cc0a55543866968e3e11cffee0b",
    );
  });
});

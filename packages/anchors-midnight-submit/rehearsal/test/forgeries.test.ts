// The forged KNOWN_AUTHORS documents verify-all.mjs builds, opened by the verify package's own
// source, with Ed25519 verification on and, through a mock, off: a forgery the gate counts as
// refused by the signature check must open once that check is skipped, so nothing else refused it.
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Ed25519 from "../../../anchors-midnight/src/ed25519.js";
import { openKnownAuthors, signKnownAuthors, type SignedKnownAuthors } from "../../../anchors-midnight/src/known-authors.js";
import { forgeKnownAuthors, judge, parseCrashStatus } from "../gate.mjs";
import { honestRehearsal } from "./fixture.js";

const skip = vi.hoisted(() => ({ signatureCheck: false }));
vi.mock("../../../anchors-midnight/src/ed25519.js", async (original) => {
  const real = await original<typeof Ed25519>();
  return { ...real, ed25519Verify: (...args: Parameters<typeof real.ed25519Verify>) => skip.signatureCheck || real.ed25519Verify(...args) };
});
beforeEach(() => {
  skip.signatureCheck = false;
});

const SIGNATURE_FAILS = "refused: the known-authors document's signature by a trust root does not verify";
const NO_TRUST_ROOT = "refused: the known-authors document carries no signature by a trust root";
const answer = (signed: SignedKnownAuthors, trustRoots: string[]) => {
  try {
    openKnownAuthors(signed, trustRoots);
    return "opened";
  } catch (error) {
    return `refused: ${(error as Error).message}`;
  }
};
const forgeries = () => {
  const r = honestRehearsal();
  const forged: Record<string, { signed: SignedKnownAuthors; trustRoots: string[] }> = forgeKnownAuthors(r.documents[2], r.root, signKnownAuthors, new Uint8Array(randomBytes(32)));
  return { r, forged, answers: () => Object.fromEntries(Object.entries(forged).map(([name, f]) => [name, answer(f.signed, f.trustRoots)])) };
};

describe("the forged KNOWN_AUTHORS documents", () => {
  it("get exactly the answers the gate requires from the verify package", () => {
    expect(forgeries().answers()).toEqual({
      "serial 3 with every author window reopened, under the trust root's signature on serial 3": SIGNATURE_FAILS,
      "that document signed by a stranger, under the trust root's key": SIGNATURE_FAILS,
      "that document signed by a stranger, under the stranger's key": NO_TRUST_ROOT,
      "positive control: that document signed by a stranger, with the stranger as the trust root": "opened",
    });
  });

  it("are well-formed in every respect but the signature: with Ed25519 verification skipped, both trust-root forgeries open", () => {
    const { answers } = forgeries();
    skip.signatureCheck = true;
    expect(answers()).toEqual({
      "serial 3 with every author window reopened, under the trust root's signature on serial 3": "opened",
      "that document signed by a stranger, under the trust root's key": "opened",
      "that document signed by a stranger, under the stranger's key": NO_TRUST_ROOT,
      "positive control: that document signed by a stranger, with the stranger as the trust root": "opened",
    });
  });

  it("differ from serial 3 only in reopening its closed windows, and the trust-root forgeries name the trust root", () => {
    const { r, forged } = forgeries();
    const serial3 = JSON.parse(r.documents[2]!.document);
    for (const { signed } of Object.values(forged)) {
      const d = JSON.parse(signed.document);
      expect(d.networks.preprod.authors.map((a: { validTo: unknown }) => a.validTo)).toEqual([null, null]);
      for (const a of serial3.networks.preprod.authors) a.validTo = null;
      expect(d).toEqual(serial3);
    }
    expect(forged["serial 3 with every author window reopened, under the trust root's signature on serial 3"]!.signed.signatures).toEqual(r.documents[2]!.signatures);
    expect(forged["that document signed by a stranger, under the trust root's key"]!.signed.signatures.map((s) => s.key)).toEqual([r.root]);
  });

  // A stranger's key carrying the root's real signature is refused with the signature check on
  // or off, so its refusal says nothing about that check.
  it("a stranger's key beside the root's signature is refused by the allow-list whether or not Ed25519 verification runs, and the gate refuses that answer for a trust-root forgery", () => {
    const r = honestRehearsal();
    const serial3 = r.documents[2]!;
    const strangersKey = { ...serial3, signatures: [{ key: "ab".repeat(32), signature: serial3.signatures[0]!.signature }] };
    expect(answer(strangersKey, [r.root])).toBe(NO_TRUST_ROOT);
    skip.signatureCheck = true;
    expect(answer(strangersKey, [r.root])).toBe(NO_TRUST_ROOT);
    const name = "serial 3 with every author window reopened, under the trust root's signature on serial 3";
    r.verified.forgedDocuments[name] = { outcome: NO_TRUST_ROOT };
    expect(judge({ raw: r.raw, verified: r.verified, crash: r.crash, crashStatus: parseCrashStatus(r.crashStatus.join("\n")) }).failures).toEqual([
      `forged KNOWN_AUTHORS document "${name}": ${NO_TRUST_ROOT}, not ${SIGNATURE_FAILS}`,
    ]);
  });
});

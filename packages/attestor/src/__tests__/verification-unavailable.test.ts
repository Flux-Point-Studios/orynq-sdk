import { describe, expect, it } from "vitest";
import {
  AttestationBundleBuilder,
  createNitroVerifier,
  createSevSnpVerifier,
  verifyBundle,
} from "../index.js";
import type { AttestationBundle, TeeType } from "../index.js";

function fabricatedBundle(teeType: TeeType): AttestationBundle {
  const bundle = new AttestationBundleBuilder()
    .setTee(teeType, "1.0")
    .setInlineEvidence(Buffer.from("garbage report / COSE bytes").toString("base64"))
    .setBinding("ab".repeat(32), "rootHash")
    .setAttestor("fabricated-attestor")
    .build();
  return teeType === "sev-snp"
    ? Object.assign(bundle, {
        sevSnp: {
          launchMeasurement: "00".repeat(48),
          reportData: bundle.binding.hash,
          vcek: "bogus-vcek",
        },
      })
    : bundle;
}

describe("hardware verification fails closed", () => {
  it.each(["nitro", "sev-snp"] as const)(
    "rejects fabricated %s evidence through the public API",
    async (teeType) => {
      const result = await verifyBundle(fabricatedBundle(teeType));
      expect(result.valid).toBe(false);
      expect(result).toMatchObject({
        errorCode: "VERIFICATION_UNAVAILABLE",
        checks: {
          signatureValid: false,
          certChainValid: false,
          hashBindingValid: false,
          measurementsMatch: false,
          notRevoked: false,
        },
      });
      expect(result.errors).toContain(`Verification unavailable for backend: ${teeType}`);
    },
  );

  it.each([createNitroVerifier, createSevSnpVerifier])(
    "does not authenticate a caller-supplied hash binding (%#)",
    async (createVerifier) => {
      const verifier = createVerifier();
      const bundle = fabricatedBundle(verifier.teeType);
      expect(await verifier.verifyBinding(bundle, bundle.binding.hash)).toBe(false);
    },
  );
});

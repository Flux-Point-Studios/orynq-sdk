#!/usr/bin/env node
/**
 * Full-pipeline E2E proof: phone-equivalent ed25519 attestor signs a
 * payload containing a REAL Android Key Attestation cert chain (Samsung
 * Galaxy S22 production test-vector chain, vendored in
 * /home/deci/work/materios-task180/partnerchain/pallets/tee-attestation/src/test_vectors.rs)
 * → gateway accepts → cert-daemon's evidence_submitter calls
 * TeeAttestation.submit_evidence on chain → ArmTrustZoneVerifier walks the
 * chain → composite_trust_score becomes ≥ 1.
 *
 * Key cleverness: instead of hand-rolling the gateway's canonical CBOR
 * encoder, we import the actual TypeScript source the gateway runs so
 * the bytes are byte-for-byte identical (including the `_b64` decode rule).
 *
 * Run via tsx (not plain node) because we're importing TS source directly:
 *   cd /home/deci/work/orynq-sdk
 *   pnpm exec tsx services/blob-gateway/scripts/e2e_polyalg_ed25519_full_chain.mjs
 */
import {
  ed25519PairFromSeed,
  ed25519Sign,
  cryptoWaitReady,
} from "@polkadot/util-crypto";
import { createHash, randomBytes } from "crypto";

import {
  evidenceEntryToCborValue,
  encodeCbor,
  deriveEvidenceNonce,
} from "../src/schemas/compute_metering_v2.ts";

// --- live preprod targets --------------------------------------------------
const GATEWAY = "https://materios.fluxpointstudios.com/preprod-blobs";
const ADMIN_TOKEN =
  "6d3bec074c80050dabcc76b32b9b6030e049be860a0f7e30e2a08c53e27d2d61";
const BEARER = "matra_vcX0GyOGFTeQpxilZ0GulkBKR9oSrwVxsEEPb9TN8QM";
const TENANT_ID = "ten-computeportal-internal-001";

// --- Samsung TEE-rooted real-device cert chain (root → leaf) --------------
// Source: pallets/tee-attestation/src/test_vectors.rs, byte-identical to
// Acurast's published MIT/Unlicense test vector. The pallet's own unit
// test `samsung_tee_chain_verifies` confirms this chain returns
// VerifyOutcome::Verified through ArmTrustZoneVerifier.
const SAMSUNG_ROOT =
  "MIIFHDCCAwSgAwIBAgIJANUP8luj8tazMA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNVBAUTEGY5MjAwOWU4NTNiNmIwNDUwHhcNMTkxMTIyMjAzNzU4WhcNMzQxMTE4MjAzNzU4WjAbMRkwFwYDVQQFExBmOTIwMDllODUzYjZiMDQ1MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAr7bHgiuxpwHsK7Qui8xUFmOr75gvMsd/dTEDDJdSSxtf6An7xyqpRR90PL2abxM1dEqlXnf2tqw1Ne4Xwl5jlRfdnJLmN0pTy/4lj4/7tv0Sk3iiKkypnEUtR6WfMgH0QZfKHM1+di+y9TFRtv6y//0rb+T+W8a9nsNL/ggjnar86461qO0rOs2cXjp3kOG1FEJ5MVmFmBGtnrKpa73XpXyTqRxB/M0n1n/W9nGqC4FSYa04T6N5RIZGBN2z2MT5IKGbFlbC8UrW0DxW7AYImQQcHtGl/m00QLVWutHQoVJYnFPlXTcHYvASLu+RhhsbDmxMgJJ0mcDpvsC4PjvB+TxywElgS70vE0XmLD+OJtvsBslHZvPBKCOdT0MS+tgSOIfga+z1Z1g7+DVagf7quvmag8jfPioyKvxnK/EgsTUVi2ghzq8wm27ud/mIM7AY2qEORR8Go3TVB4HzWQgpZrt3i5MIlCaY504LzSRiigHCzAPlHws+W0rB5N+er5/2pJKnfBSDiCiFAVtCLOZ7gLiMm0jhO2B6tUXHI/+MRPjy02i59lINMRRev56GKtcd9qO/0kUJWdZTdA2XoS82ixPvZtXQpUpuL12ab+9EaDK8Z4RHJYYfCT3Q5vNAXaiWQ+8PTWm2QgBR/bkwSWc+NpUFgNPN9PvQi8WEg5UmAGMCAwEAAaNjMGEwHQYDVR0OBBYEFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMB8GA1UdIwQYMBaAFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgIEMA0GCSqGSIb3DQEBCwUAA4ICAQBOMaBc8oumXb2voc7XCWnuXKhBBK3e2KMGz39t7lA3XXRe2ZLLAkLM5y3J7tURkf5a1SutfdOyXAmeE6SRo83Uh6WszodmMkxK5GM4JGrnt4pBisu5igXEydaW7qq2CdC6DOGjG+mEkN8/TA6p3cnoL/sPyz6evdjLlSeJ8rFBH6xWyIZCbrcpYEJzXaUOEaxxXxgYz5/cTiVKN2M1G2okQBUIYSY6bjEL4aUN5cfo7ogP3UvliEo3Eo0YgwuzR2v0KR6C1cZqZJSTnghIC/vAD32KdNQ+c3N+vl2OTsUVMC1GiWkngNx1OO1+kXW+YTnnTUOtOIswUP/Vqd5SYgAImMAfY8U9/iIgkQj6T2W6FsScy94IN9fFhE1UtzmLoBIuUFsVXJMTz+Jucth+IqoWFua9v1R93/k98p41pjtFX+H8DslVgfP097vju4KDlqN64xV1grw3ZLl4CiOe/A91oeLm2UHOq6wn3esB4r2EIQKb6jTVGu5sYCcdWpXr0AUVqcABPdgL+H7qJguBw09ojm6xNIrw2OocrDKsudk/okr/AwqEyPKw9WnMlQgLIKw1rODG2NvU9oR3GVGdMkUBZutL8VuFkERQGt6vQ2OCw0sV47VMkuYbacK/xyZFiRcrPJPb41zgbQj9XAEyLKCHex0SdDrx+tWUDqG8At2JHA==";
const SAMSUNG_INTERMEDIATE_2 =
  "MIIDlDCCAXygAwIBAgIRAJ3uw09QZQdXUqFIiXyf5uUwDQYJKoZIhvcNAQELBQAwGzEZMBcGA1UEBRMQZjkyMDA5ZTg1M2I2YjA0NTAeFw0yMTExMTcyMjQ1MTBaFw0zMTExMTUyMjQ1MTBaMDkxDDAKBgNVBAwMA1RFRTEpMCcGA1UEBRMgODFiNTdmZmZiMzc5NTEyOWNmM2ZjNTBlY2EwY2QzOWMwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAARSfOriwm02QddIzGI1JpbUWTw93rtxu/BBMGpQopLCEsI1IMcO+YO75XEx5PJb0qpN0qZy4ZyohEOkXyqdD/KNkNCKWnhVk7wyyJCdnw35L8+adMpuHkp7Wc8nK14aXKKjYzBhMB0GA1UdDgQWBBQNE845gvrI02p2mda2mk3SWwhGYjAfBgNVHSMEGDAWgBQ2YeEAfIgFCVGLRGxH/xpMyepPEjAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwICBDANBgkqhkiG9w0BAQsFAAOCAgEAVRzcron3lJ+sG5Jaqd9L2G33Dm/0/u0Ed+1jNJ7LrCLMKSHmEmoEiuNRKue2Tyv8UVb/Z9dENmC+gBqWkgOB6hxJ6lVcvIa38/CKNHBHr/Ras55+zZ68tQlpO6tdOVKUlfvlvI1BdpCv4qSEMpR9Zz4f4dzjEAbb24isT0PLcYvN0IrDELdCK+R+b+HaM5GrcFj1STv3uju/xHJnU6GeMdMPFf/rbMLNi1P6xVqdNUBGbKFx8J+px78z/Bcjq8Swt+uEoINvk/whROT8TQuzdccofx0hRFaoC1lgjRo8xgLlqFIyj0ICETuyYfEXbJwGgJczdS7ndte2SES4Rl3+NlYA2/mXjBUPnmGvJraOUZaw7ahIay7L7uUpvdJCHrlCDpRSLLCjuNss/sGn6bb3EDVGBaqzNRUBLNbsqrwKf8MbaJMhxOzHFlVXO1heFvmVdB+69Gkf0Kt2fK8N6VJIDGI9YoluItIbgJ/IqCicwLduxqMSXpPHEXf+f0lQH/AAP6Gz0aD4on3qTjPSl8p4LOqZSQoDqJKUukaXhMvgr/4u4E3ZX3EbxrF77hrML4NK4DfOj3LjLklPZZ3cLlMXzcSnMYvXkVU96qHqppyqjfioOZU2oSFQwPbXmKIYHVYJ2xIFBVy9ESQcqX04mevxMh1YHp+pTdMLXYE0EU+lB5Q=";
const SAMSUNG_INTERMEDIATE_1 =
  "MIIB8zCCAXmgAwIBAgIQcH2ewbAt6vTdz/WwWLWu6zAKBggqhkjOPQQDAjA5MQwwCgYDVQQMDANURUUxKTAnBgNVBAUTIDgxYjU3ZmZmYjM3OTUxMjljZjNmYzUwZWNhMGNkMzljMB4XDTIxMTExNzIyNDcxMloXDTMxMTExNTIyNDcxMlowOTEMMAoGA1UEDAwDVEVFMSkwJwYDVQQFEyBiMmMzN2UzODMyOGQ2YWNkZjNiNjAwNmU4YTc3ZjA2NDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABE3rCk6dqUilYhf1gsiVMFkOrEze/Ar318VMXFXDlOXDajQORIGWYVVtbcHYPNrews45k2CgHZg6ofN4lpONImyjYzBhMB0GA1UdDgQWBBRt1zXt/O233wIFRiNawaRD3KQPpTAfBgNVHSMEGDAWgBQNE845gvrI02p2mda2mk3SWwhGYjAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwICBDAKBggqhkjOPQQDAgNoADBlAjEA0dNMiUn0+ftvhsFJP1byGMZkaWWOQbIOTItcQTrw29YV5FSjwZW7Ofrj8kR8WC4nAjB0yDVyt86uFrvWWzaa1EJmqR4L7PMUWf8yVey6KLrhQYMSGGhgief4pj3Hx6Eck6o=";
const SAMSUNG_KEY =
  "MIIClzCCAj2gAwIBAgIBATAKBggqhkjOPQQDAjA5MQwwCgYDVQQMDANURUUxKTAnBgNVBAUTIGIyYzM3ZTM4MzI4ZDZhY2RmM2I2MDA2ZThhNzdmMDY0MB4XDTIxMTExNzIyNDcxMloXDTMxMTExNTIyNDcxMlowHzEdMBsGA1UEAxMUQW5kcm9pZCBLZXlzdG9yZSBLZXkwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASDWA5xIavYEzjbcZneQy8gxkAo7nzJrSIqHbmPDy1kOFNWidIZLaKf86qLp73/n2VzK8qo5XsHexoC8wPaIcj8o4IBTjCCAUowggE2BgorBgEEAdZ5AgERBIIBJjCCASICAWQKAQECAWQKAQEEAAQAMGy/hT0IAgYBgddgKwm/hUVcBFowWDEyMDAEK2NvbS51YmluZXRpYy5hdHRlc3RlZC5leGVjdXRvci50ZXN0LnRlc3RuZXQCAQ4xIgQgvctFYPazxB2tkgZoFpwovh756knyPZjNjrLzeuRIj/kwgaGhBTEDAgECogMCAQOjBAICAQClBTEDAgEAqgMCAQG/g3cCBQC/hT4DAgEAv4VATDBKBCDnyVk+0qoHM1jC6eS+ScTwsvI1J6mtlFgzf0F3HTIMawEB/woBAAQgowcEEJQaU4V58HU/EPyCMBydcLlh8pR+qgnfWnuur+W/hUEFAgMB1MC/hUIFAgMDFdy/hU4GAgQBNInxv4VPBgIEATSJ8TAOBgNVHQ8BAf8EBAMCB4AwCgYIKoZIzj0EAwIDSAAwRAIgOQNrjHRHg9gcN6gFJFZHSjpIG1Gx1061FAEq3E9yUsgCIQD1FvhmjYsTWeQMQsj22ms/8dw9O3WsvE0y2AtrN0KWuw==";

const SAMSUNG_CHAIN_B64 = [
  SAMSUNG_ROOT,
  SAMSUNG_INTERMEDIATE_2,
  SAMSUNG_INTERMEDIATE_1,
  SAMSUNG_KEY,
];

function bytesToHex(b) {
  return Buffer.from(b).toString("hex");
}

async function main() {
  await cryptoWaitReady();
  console.log("[e2e2] crypto ready");

  // 1. Fresh ed25519 keypair (simulates phone's _STD_.signers.ed25519)
  const seed = randomBytes(32);
  const pair = ed25519PairFromSeed(seed);
  const pubHex = bytesToHex(pair.publicKey);
  console.log("[e2e2] ed25519 pubkey: 0x" + pubHex);

  // 2. Reuse an existing on-chain certified v2 receipt (Hetzner real-metrics).
  //    The cert-daemon's evidence_submitter only processes evidence for
  //    receipts that already exist on-chain — see daemon.evidence_submitter
  //    "not yet on chain — skip this tick" log when the receipt is missing.
  const contentHash =
    "d569be14d76d2fbcd2758e4c1bbfb7753a69cb3ed65a99297c9384933689bdc0";
  const receiptId =
    "0c4c6f8145105914483e8f68bdb0bcd87e357765883d2514f08788e5b11bd5dc";
  console.log("[e2e2] reusing on-chain certified receipt:");
  console.log("[e2e2] content_hash : 0x" + contentHash);
  console.log("[e2e2] receipt_id   : 0x" + receiptId);

  // 3. Register pubkey as ed25519 attestor
  const regRes = await fetch(`${GATEWAY}/admin/attestation-evidence-attestors`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({
      pubkey: "0x" + pubHex,
      label: "polyalg-e2e-fc-" + Date.now(),
      sig_algo: "ed25519",
      notes: "PR #48 + ArmTZ chain proof",
    }),
  });
  console.log("[e2e2] register attestor: " + regRes.status);
  if (!regRes.ok && regRes.status !== 409) throw new Error("register failed: " + (await regRes.text()));

  // 4. Build ArmTrustZone payload + canonical-CBOR via the gateway's own
  //    encoder (`evidenceEntryToCborValue` — identical to what the route
  //    rebuilds server-side for the signature verify).
  const evidenceType = "arm_trustzone";
  const nonceHex = deriveEvidenceNonce(contentHash, evidenceType);
  console.log("[e2e2] nonce: 0x" + nonceHex);

  const payload = {
    cert_chain_b64: SAMSUNG_CHAIN_B64,
    device_model: "Samsung-Galaxy-S22-test-vector",
    security_level: "TrustedEnvironment",
  };

  const taggedEntry = evidenceEntryToCborValue({
    evidence_type: evidenceType,
    nonce: nonceHex,
    payload,
  });
  if (taggedEntry.type !== "map") throw new Error("unexpected encoder output");
  const payloadEntry = taggedEntry.v.find(([k]) => k === "payload");
  if (!payloadEntry) throw new Error("payload sub-map missing");
  const payloadCbor = encodeCbor(payloadEntry[1]);
  console.log("[e2e2] canonical-CBOR(payload) len: " + payloadCbor.length + " bytes");

  // 5. Sign with ed25519
  const sigBytes = ed25519Sign(payloadCbor, {
    publicKey: pair.publicKey,
    secretKey: pair.secretKey,
  });
  const sigHex = bytesToHex(sigBytes);
  console.log("[e2e2] ed25519 sig: 0x" + sigHex.slice(0, 32) + "...");

  // 6. POST evidence
  const body = {
    receipt_id: receiptId,
    evidence_type: evidenceType,
    nonce: nonceHex,
    payload,
    attestor_pubkey: pubHex,
    signature: sigHex,
  };
  const er = await fetch(`${GATEWAY}/v2/attestation_evidence`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${BEARER}` },
    body: JSON.stringify(body),
  });
  const erText = await er.text();
  console.log("[e2e2] evidence POST: " + er.status);
  console.log("[e2e2] response: " + erText);

  if (!er.ok) {
    console.log("\n❌ FAILED at gateway");
    process.exit(1);
  }
  console.log(
    "\n✅ STAGE 1 — Gateway accepted ed25519-signed ArmTrustZone evidence " +
      "with real Samsung Key Attestation chain.",
  );
  console.log(
    "   Next: cert-daemon evidence_submitter will pick this row up + call " +
      "TeeAttestation.submit_evidence on chain. Watch for EvidenceVerified " +
      "event on receipt 0x" + receiptId,
  );
  console.log("\nReceipt ID for monitoring: 0x" + receiptId);
}

main().catch((e) => {
  console.error("[e2e2] FATAL", e);
  process.exit(1);
});

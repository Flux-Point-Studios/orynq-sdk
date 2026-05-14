#!/usr/bin/env node
/**
 * 🛡️ THE REAL ONE.
 *
 * Submits the Materios `TeeAttestation::submit_evidence` cycle with the
 * Android Key Attestation chain captured from the actual Moto G 5G 2024
 * sitting on Node-2's USB port — minted via the `materios-key-attest` APK
 * (KeyMint setAttestationChallenge → KeyStore.getCertificateChain).
 *
 * Expected outcome: TeeAttestation::EvidenceVerified on chain with
 *   attest_key_hash = 0xfdb20930d930f7e11edc8727712a2b14aa02eb7d8b25fe5cf4bc7b3f1762e6db
 * = sha256(SPKI of THIS phone's KeyMint-attested key).
 *
 * That hash didn't exist on chain before — it's per-device, per-key.
 * Different from the published Pixel/Samsung test vectors.
 */
import { ed25519PairFromSeed, ed25519Sign, cryptoWaitReady } from "@polkadot/util-crypto";
import { createHash, randomBytes } from "crypto";
import {
  evidenceEntryToCborValue,
  encodeCbor,
  deriveEvidenceNonce,
} from "../src/schemas/compute_metering_v2.ts";
import { readFileSync } from "fs";

const GATEWAY = "https://materios.fluxpointstudios.com/preprod-blobs";
const ADMIN_TOKEN = "6d3bec074c80050dabcc76b32b9b6030e049be860a0f7e30e2a08c53e27d2d61";
const BEARER = "matra_vcX0GyOGFTeQpxilZ0GulkBKR9oSrwVxsEEPb9TN8QM";

// Load the chain captured from the phone (leaf-first from
// KeyStore.getCertificateChain) and REVERSE it to root-first because
// the pallet's ArmTrustZoneVerifier expects validate_certificate_chain
// to walk the chain starting from a trusted Google root.
const phoneChain = JSON.parse(readFileSync("/tmp/materios-real-device-chain.json", "utf-8"));
if (!phoneChain.ok) throw new Error("phone chain capture failed: " + JSON.stringify(phoneChain));
const REAL_DEVICE_CHAIN_ROOT_FIRST = [...phoneChain.chain_b64].reverse();
const EXPECTED_LEAF_SPKI_SHA256 = phoneChain.leaf_spki_sha256_hex;
console.log("[e2e-real] chain length:", REAL_DEVICE_CHAIN_ROOT_FIRST.length);
console.log("[e2e-real] expected attest_key_hash (= leaf SPKI sha256):", "0x" + EXPECTED_LEAF_SPKI_SHA256);

function bytesToHex(b) { return Buffer.from(b).toString("hex"); }

async function main() {
  await cryptoWaitReady();

  // Fresh ed25519 attestor identity (gateway-level signer; orthogonal to
  // the device's KeyMint key whose chain we're submitting).
  const seed = randomBytes(32);
  const pair = ed25519PairFromSeed(seed);
  const pubHex = bytesToHex(pair.publicKey);
  console.log("[e2e-real] ed25519 attestor pubkey: 0x" + pubHex);

  // Reuse the same on-chain certified receipt we used in prior runs.
  const contentHash = "d569be14d76d2fbcd2758e4c1bbfb7753a69cb3ed65a99297c9384933689bdc0";
  const receiptId = "0c4c6f8145105914483e8f68bdb0bcd87e357765883d2514f08788e5b11bd5dc";

  // Register attestor with sig_algo=ed25519
  const r = await fetch(`${GATEWAY}/admin/attestation-evidence-attestors`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({
      pubkey: "0x" + pubHex,
      label: "materios-real-phone-" + Date.now(),
      sig_algo: "ed25519",
      notes: "Real Moto G 5G 2024 KeyMint chain — task #138 Phase D",
    }),
  });
  console.log("[e2e-real] register attestor:", r.status, (await r.text()).slice(0, 150));

  // Build canonical-CBOR payload + ed25519 sign
  const evidenceType = "arm_trustzone";
  const nonceHex = deriveEvidenceNonce(contentHash, evidenceType);
  const payload = {
    cert_chain_b64: REAL_DEVICE_CHAIN_ROOT_FIRST,
    device_model: "Moto-G-5G-2024-real-device",
    security_level: "TrustedEnvironment",
  };
  const tagged = evidenceEntryToCborValue({
    evidence_type: evidenceType,
    nonce: nonceHex,
    payload,
  });
  if (tagged.type !== "map") throw new Error("encoder shape");
  const payloadCbor = encodeCbor(tagged.v.find(([k]) => k === "payload")[1]);
  const sig = ed25519Sign(payloadCbor, { publicKey: pair.publicKey, secretKey: pair.secretKey });
  const sigHex = bytesToHex(sig);
  console.log("[e2e-real] canonical-CBOR(payload) len:", payloadCbor.length, "bytes");
  console.log("[e2e-real] ed25519 sig: 0x" + sigHex.slice(0, 32) + "...");

  // POST evidence
  const er = await fetch(`${GATEWAY}/v2/attestation_evidence`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${BEARER}` },
    body: JSON.stringify({
      receipt_id: receiptId,
      evidence_type: evidenceType,
      nonce: nonceHex,
      payload,
      attestor_pubkey: pubHex,
      signature: sigHex,
    }),
  });
  console.log("[e2e-real] evidence POST:", er.status);
  const erText = await er.text();
  console.log("[e2e-real] response:", erText);

  if (!er.ok) {
    console.log("\n❌ Gateway rejected");
    process.exit(1);
  }
  console.log("\n✅ Gateway accepted real-device chain payload.");
  console.log("   Watching for TeeAttestation::EvidenceVerified with attest_key_hash:");
  console.log("   0x" + EXPECTED_LEAF_SPKI_SHA256);
}
main().catch(e => { console.error(e); process.exit(1); });

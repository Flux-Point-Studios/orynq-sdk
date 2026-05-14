#!/usr/bin/env node
/**
 * Materios Witness Network MVP — loop runner
 *
 * Wraps the per-probe flow:
 *   1. SSH to Node-2 + trigger the upgraded materios-key-attest APK with
 *      a probe_url intent extra.
 *   2. Wait for the APK to mint a fresh KeyMint-attested key whose
 *      attestation_challenge commits to the probe result.
 *   3. Pull chain.json (cert chain + probe result).
 *   4. Register the per-probe attestor pubkey at the gateway.
 *   5. POST attestation evidence with the probe_result embedded in the
 *      canonical-CBOR payload, signed by an ed25519 key (gateway-side
 *      polyalg path — orthogonal to the on-chain attest_key_hash).
 *   6. Watch the cert-daemon land it on chain.
 *
 * Each iteration produces a DISTINCT on-chain attestation event with a
 * fresh attest_key_hash whose Android Key Attestation challenge field
 * cryptographically commits to {probe_url, status, body_sha256, ts}.
 *
 * Usage:
 *   pnpm exec tsx witness_loop.mjs <probe_url> [<probe_url> ...]
 */
import { ed25519PairFromSeed, ed25519Sign, cryptoWaitReady } from "@polkadot/util-crypto";
import { createHash, randomBytes } from "crypto";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import {
  evidenceEntryToCborValue,
  encodeCbor,
  deriveEvidenceNonce,
} from "../src/schemas/compute_metering_v2.ts";

const GATEWAY = "https://materios.fluxpointstudios.com/preprod-blobs";
const ADMIN_TOKEN = "6d3bec074c80050dabcc76b32b9b6030e049be860a0f7e30e2a08c53e27d2d61";
const BEARER = "matra_vcX0GyOGFTeQpxilZ0GulkBKR9oSrwVxsEEPb9TN8QM";
const NODE2 = "192.168.0.132";
const RECEIPT_ID = "0c4c6f8145105914483e8f68bdb0bcd87e357765883d2514f08788e5b11bd5dc";
const CONTENT_HASH = "d569be14d76d2fbcd2758e4c1bbfb7753a69cb3ed65a99297c9384933689bdc0";

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8" });
}
function bytesToHex(b) { return Buffer.from(b).toString("hex"); }

async function runProbe(probeUrl, taskId) {
  console.log(`\n=== ${taskId} → ${probeUrl} ===`);

  // 1. Fire the APK with the probe_url extra
  sh(`ssh ${NODE2} "sudo adb shell am start -n com.fluxpointstudios.materioskeyattest/.MainActivity --es probe_url '${probeUrl}' --es task_id '${taskId}'"`);
  // 2. Give the APK time to mint + probe + write
  await new Promise(r => setTimeout(r, 4500));
  // 3. Pull the result
  sh(`ssh ${NODE2} "sudo adb pull /sdcard/Android/data/com.fluxpointstudios.materioskeyattest/files/chain.json /tmp/witness_chain.json"`);
  sh(`scp ${NODE2}:/tmp/witness_chain.json /tmp/witness_chain.json`);
  const phoneChain = JSON.parse(readFileSync("/tmp/witness_chain.json", "utf-8"));
  if (!phoneChain.ok) throw new Error("phone chain failed: " + JSON.stringify(phoneChain));
  const probe = phoneChain.probe_result;
  if (!probe) throw new Error("probe_result missing in chain.json");
  console.log(`  phone probed: status=${probe.status_code} body=${probe.body_bytes}B sha256=${probe.body_sha256_hex.slice(0,16)}... duration=${probe.duration_ms}ms`);
  console.log(`  attest_key_hash will be: 0x${phoneChain.leaf_spki_sha256_hex}`);

  // 4. Chain is leaf-first; reverse for pallet root-first expectation
  const rootFirst = [...phoneChain.chain_b64].reverse();

  // 5. Mint a fresh ed25519 gateway attestor identity
  const seed = randomBytes(32);
  const pair = ed25519PairFromSeed(seed);
  const pubHex = bytesToHex(pair.publicKey);

  const regRes = await fetch(`${GATEWAY}/admin/attestation-evidence-attestors`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({
      pubkey: "0x" + pubHex,
      label: `witness-${taskId}`,
      sig_algo: "ed25519",
      notes: `Witness probe ${probeUrl} task=${taskId}`,
    }),
  });
  if (!regRes.ok && regRes.status !== 409) throw new Error("register failed: " + (await regRes.text()));

  // 6. Build canonical-CBOR payload — includes the cert chain AND the probe
  //    result. Both are committed by the ed25519 signature.
  const evidenceType = "arm_trustzone";
  const nonceHex = deriveEvidenceNonce(CONTENT_HASH, evidenceType);
  const payload = {
    cert_chain_b64: rootFirst,
    device_model: "Moto-G-5G-2024-witness",
    security_level: "TrustedEnvironment",
    witness_probe: {
      url: probe.url,
      task_id: probe.task_id,
      status_code: probe.status_code,
      body_bytes: probe.body_bytes,
      body_sha256_hex: probe.body_sha256_hex,
      duration_ms: probe.duration_ms,
      observed_at_ms: probe.completed_ms,
    },
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

  // 7. POST evidence
  const er = await fetch(`${GATEWAY}/v2/attestation_evidence`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${BEARER}` },
    body: JSON.stringify({
      receipt_id: RECEIPT_ID,
      evidence_type: evidenceType,
      nonce: nonceHex,
      payload,
      attestor_pubkey: pubHex,
      signature: sigHex,
    }),
  });
  const erText = await er.text();
  console.log(`  evidence POST: ${er.status} ${erText.slice(0, 200)}`);
  if (!er.ok) throw new Error("evidence POST failed");

  return { taskId, probe, attest_key_hash: "0x" + phoneChain.leaf_spki_sha256_hex };
}

async function main() {
  await cryptoWaitReady();
  const urls = process.argv.slice(2);
  if (urls.length === 0) {
    console.error("usage: tsx witness_loop.mjs <probe_url> [<probe_url> ...]");
    process.exit(1);
  }
  console.log(`Witness loop — ${urls.length} probes`);
  const results = [];
  for (let i = 0; i < urls.length; i++) {
    const taskId = `wn-${Date.now()}-${i}`;
    const r = await runProbe(urls[i], taskId);
    results.push(r);
    if (i < urls.length - 1) await new Promise(r => setTimeout(r, 3000)); // gentle pacing
  }
  console.log("\n=== WITNESS BATCH COMPLETE ===");
  results.forEach((r, i) => {
    console.log(`${i + 1}. ${r.taskId}`);
    console.log(`   probe: ${r.probe.url} → status=${r.probe.status_code}`);
    console.log(`   attest_key_hash: ${r.attest_key_hash}`);
  });
}
main().catch(e => { console.error(e); process.exit(1); });

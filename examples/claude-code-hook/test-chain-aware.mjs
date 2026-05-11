#!/usr/bin/env node
/**
 * Test harness for the chain-aware backstop check.
 *
 * Read-only against cert-daemon (docker exec cat + curl /metrics) and
 * Materios RPC. Posts NOTHING. Runs cleanly without ORYNQ_DRAIN_DRY_RUN
 * since chainAwareDecision itself never POSTs — we just don't invoke
 * postAnchorBackstop here.
 *
 * Two cases:
 *   1. Synthetic sentinel with task #105's certHash (known-anchored)
 *      → expect decision === "skip-anchored", anchored.batchRoot present.
 *   2. Synthetic sentinel with a fake certHash + recent blockNum
 *      → expect decision === "post" if cert-daemon's head is far enough
 *        ahead of the fake block, else "skip-too-early" (still a pass —
 *        we just want to confirm post-would-fire-when-conditions-met).
 *
 * Exit 0 on both pass. Non-zero with a labeled assertion failure otherwise.
 */

import { chainAwareDecision } from "./drain.mjs";

const TASK_105_CERT_HASH = "0x802b71c8e3206adb58a7636b820d7b5c5a10bf8347ad013b4bc93d360ff1852e";
const FAKE_CERT_HASH = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function assertEqual(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`FAIL  ${label}: expected ${e}, got ${a}`);
    return false;
  }
  console.log(`PASS  ${label}`);
  return true;
}

function assert(label, cond, detail = "") {
  if (!cond) {
    console.error(`FAIL  ${label}${detail ? ` (${detail})` : ""}`);
    return false;
  }
  console.log(`PASS  ${label}`);
  return true;
}

async function main() {
  let allPass = true;

  // -------- Case 1: known-anchored cert_hash (task #105) --------
  console.log("\n=== Case 1: task #105 cert_hash should be found in cert-daemon history ===");
  const anchoredSentinel = {
    schemaVersion: "pending-anchor/2.0",
    contentHash: "b5bb383e7badbc343a4a7802ea1205f5c7e712d734e24a7c9875c8ef477ce3dd",
    rootHash: "b5bb383e7badbc343a4a7802ea1205f5c7e712d734e24a7c9875c8ef477ce3dd",
    manifestHash: "b5bb383e7badbc343a4a7802ea1205f5c7e712d734e24a7c9875c8ef477ce3dd",
    certHash: TASK_105_CERT_HASH,
    blockHash: "0x635906b65bea350acaf15d1209124b2f8e2bc802f93cd883c800ba704368d1fd",
    blockNum: 66259, // from checkpoint-history.json batch 559
    receiptId: "0x9c71e89973a6cfa4b66341314c41a199cb58d379a9db74f1f17c4fdda1b71b57",
    queueEntry: "test-task-105.json",
    queuedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    dueAt: new Date(Date.now() - 2 * 60_000).toISOString(), // past due
  };

  const r1 = await chainAwareDecision(anchoredSentinel);
  console.log("  decision:", JSON.stringify(r1, null, 2));

  allPass = assertEqual("Case 1: decision == skip-anchored", r1.decision, "skip-anchored") && allPass;
  allPass = assert(
    "Case 1: anchored.batchRoot present",
    typeof r1.anchored?.batchRoot === "string" && r1.anchored.batchRoot.length === 64,
    `got ${r1.anchored?.batchRoot}`,
  ) && allPass;
  allPass = assert(
    "Case 1: anchored.leafBlockNum == 66259",
    r1.anchored?.leafBlockNum === 66259,
    `got ${r1.anchored?.leafBlockNum}`,
  ) && allPass;
  // txHash is intentionally null — cert-daemon doesn't persist it.
  allPass = assertEqual("Case 1: anchored.txHash == null", r1.anchored?.txHash, null) && allPass;

  // Behavioral assertions: sentinel-would-be-deleted = true, post-would-fire = false.
  // These flow from decision === "skip-anchored" — the sweep code unlinks and skips POST.
  allPass = assert(
    "Case 1: sentinel-would-be-deleted (skip-anchored ⇒ unlink in sweep)",
    r1.decision === "skip-anchored",
  ) && allPass;
  allPass = assert(
    "Case 1: post-would-fire = false (no 'post' decision)",
    r1.decision !== "post",
  ) && allPass;

  // -------- Case 2: fake cert_hash, low blockNum so cert-daemon head is far ahead --------
  console.log("\n=== Case 2: fake cert_hash (NOT in history) should yield 'post' or 'skip-too-early' ===");
  // blockNum=1 forces head >> blockNum + 30, so we expect 'post' (assuming
  // cert-daemon's metrics are up). If metrics endpoint were down we'd get
  // 'skip-diagnostic-broken' — also documented as the failsafe path.
  const fakeSentinel = {
    schemaVersion: "pending-anchor/2.0",
    contentHash: "0".repeat(64),
    rootHash: "0".repeat(64),
    manifestHash: "0".repeat(64),
    certHash: FAKE_CERT_HASH,
    blockHash: null,
    blockNum: 1, // ancient — cert-daemon head should be way past this
    receiptId: null,
    queueEntry: "test-fake.json",
    queuedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    dueAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  };

  const r2 = await chainAwareDecision(fakeSentinel);
  console.log("  decision:", JSON.stringify(r2, null, 2));

  allPass = assert(
    "Case 2: not 'skip-anchored' (fake cert_hash absent from history)",
    r2.decision !== "skip-anchored",
    `got ${r2.decision}`,
  ) && allPass;
  allPass = assertEqual("Case 2: decision == 'post'", r2.decision, "post") && allPass;
  allPass = assert(
    "Case 2: certDaemonHead numeric and > 30",
    Number.isInteger(r2.certDaemonHead) && r2.certDaemonHead > 30,
    `got ${r2.certDaemonHead}`,
  ) && allPass;
  allPass = assert(
    "Case 2: post-would-fire = true",
    r2.decision === "post",
  ) && allPass;

  console.log("\n" + (allPass ? "ALL CASES PASS" : "SOME CASES FAILED"));
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error("test harness fatal:", e?.stack || e);
  process.exit(2);
});

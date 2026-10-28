import { buildAllowlistRoot, type GuardConfig, type MandateV1 } from "../../../src/index.js";
import { FileGuardLog } from "./file-log.mjs";

export const NOW = 1_793_100_000n;

export const mandate = (): MandateV1 => ({
  schemaVersion: 1n, mandateId: new Uint8Array(16).fill(9), principalDid: "did:key:z123456789", agentDid: "did:key:z987654321", didFormatVersion: 0n,
  spendCap: { asset: "lovelace", amount: 10_000_000n, windowSeconds: 3600n },
  counterpartyAllowlistRoot: buildAllowlistRoot(["supplier"]), egressPolicy: { mode: 0n, allowlistRoot: new Uint8Array(32) },
  approvedMeasurementSetRoot: new Uint8Array(32), validityWindow: { notBefore: 0n, notAfter: 1n << 40n },
  disclosurePolicy: { committeeId: "c", threshold: 1n, committeeSize: 1n },
});

// HISTORY selects how a (re)started host declares accounting state: restore (default), fresh, or omit (no declaration).
export function declaredHistory(log: FileGuardLog): Partial<Pick<GuardConfig, "history">> {
  const history = process.env.HISTORY ?? "restore";
  if (history === "omit") return {};
  return { history: history === "fresh" ? "fresh" : log.history() };
}

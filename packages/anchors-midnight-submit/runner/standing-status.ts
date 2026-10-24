import { randomUUID } from "node:crypto";
import { existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readPrivateFile, writePrivateFile, type MidnightNetwork } from "@fluxpointstudios/orynq-sdk-anchors-midnight";
import { flushDirectory } from "./state.js";

type Loop = "follower" | "controller";
export type StandingHold = "dust-cap" | "warmup" | "policy" | "history" | "source";
interface Scope { mode: "observe" | "anchor"; network: MidnightNetwork; genesis: string; registry: string; author: string; policyDigest: string; runtimeSpecVersion: number }
interface LoopStatus {
  busy: boolean; operationStartedAt: number | null; lastCompletedAt: number | null; lastProgressAt: number | null;
  lastValue: string | null; hold: { reason: StandingHold; since: number; at: number } | null;
}
const encode = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item);
const empty = (): LoopStatus => ({ busy: false, operationStartedAt: null, lastCompletedAt: null, lastProgressAt: null, lastValue: null, hold: null });

export function openStandingStatus(root: string, input: Scope, clock: () => number = Date.now) {
  const { mode, ...scope } = input, path = join(root, "status.json");
  let cap = { sequence: 0, active: false, lastAt: null as number | null };
  if (existsSync(path)) {
    if (statSync(path).size > 2 * 1024 * 1024) throw new Error("Standing retained status exceeds its bounds");
    let previous: { format?: unknown; scope?: Record<string, unknown>; cap?: typeof cap };
    try { previous = JSON.parse(readPrivateFile(path)); } catch { throw new Error("Standing retained monitoring state is unreadable"); }
    if (previous.format !== "orynq-midnight-standing-status/v1" || !previous.scope || Object.keys(previous.scope).sort().join(",") !== Object.keys(scope).sort().join(",") || Object.entries(scope).some(([key,value]) => previous.scope![key] !== value)) throw new Error("Standing retained monitoring scope differs");
    const saved = previous.cap;
    if (!saved || Object.keys(saved).sort().join(",") !== "active,lastAt,sequence" || !Number.isSafeInteger(saved.sequence) || saved.sequence < 0 || typeof saved.active !== "boolean" || (saved.lastAt !== null && (!Number.isSafeInteger(saved.lastAt) || saved.lastAt < 0)) || (saved.sequence === 0 ? saved.active || saved.lastAt !== null : saved.lastAt === null)) throw new Error("Standing retained cap history is invalid");
    cap = { ...saved };
  }
  const state = { format: "orynq-midnight-standing-status/v1", scope, mode, incarnation: randomUUID(), startedAt: clock(), updatedAt: clock(), phase: "starting", phaseStartedAt: clock(),
    loops: { follower: empty(), controller: empty() }, cap, coverage: null as unknown };
  function save() {
    const now = clock(); if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid standing monitoring time"); state.updatedAt = now;
    const body = encode(state); if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error("Standing monitoring snapshot exceeds its bounds");
    const next = join(root, `status.${process.pid}.${randomUUID()}.next`);
    try { writePrivateFile(next, body); renameSync(next, path); flushDirectory(root); }
    finally { if (existsSync(next)) unlinkSync(next); }
  }
  save();
  return {
    read: () => structuredClone(state),
    phase(value: "wallet-sync" | "catchup" | "running" | "stopping" | "stopped") { if (state.phase !== value) state.phaseStartedAt = clock(); state.phase = value; save(); },
    record(loop: Loop, phase: "start" | "success", value: unknown = null) {
      const row = state.loops[loop], now = clock();
      if (phase === "start") { row.busy = true; row.operationStartedAt = now; }
      else {
        const summary = encode(value); if (Buffer.byteLength(summary) > 4096) throw new Error("Standing loop result exceeds its bounds");
        row.busy = false; row.lastCompletedAt = now; row.hold = null;
        if (row.lastValue !== summary) { row.lastValue = summary; row.lastProgressAt = now; }
        if (loop === "controller") cap.active = false;
      }
      save();
    },
    hold(loop: Loop, reason: StandingHold) {
      const row = state.loops[loop], now = clock(); row.busy = false; row.lastCompletedAt = now;
      row.hold = { reason, at: now, since: row.hold?.reason === reason ? row.hold.since : now };
      if (reason === "dust-cap" && !cap.active) {
        if (cap.sequence === Number.MAX_SAFE_INTEGER) throw new Error("Standing cap event sequence exhausted");
        cap.sequence++; cap.active = true; cap.lastAt = now;
      }
      save();
    },
    sample(coverage: unknown) { state.coverage = structuredClone(coverage); save(); },
  };
}

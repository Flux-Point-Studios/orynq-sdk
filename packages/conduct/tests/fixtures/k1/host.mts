import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addSpan, closeSpan, createTrace } from "@fluxpointstudios/orynq-sdk-process-trace";
import { MandateGuard, processTraceSink, type GuardAction, type GuardConfig } from "../../../src/index.js";
import { FileGuardLog } from "./file-log.mjs";
import { declaredHistory, mandate, NOW } from "./mandate.mjs";

// Concurrent hosts meet here after restoring, so both hold the same log position before either appends.
async function barrier(dir: string, parties: number): Promise<void> {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, String(process.pid)), "");
  const deadline = Date.now() + 15_000;
  while (readdirSync(dir).length < parties) {
    if (Date.now() > deadline) throw new Error("barrier timeout");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export async function runHost(repeat: number): Promise<void> {
  const [ledger, toolCallJson, mode = "detached"] = process.argv.slice(2) as [string, string, string?];
  const log = new FileGuardLog(`${ledger}.log`);
  const run = await createTrace({ agentId: "agent-1" });
  const span = addSpan(run, { name: "payments" });
  if (mode === "closed") await closeSpan(run, span.id);
  const recordTrace = processTraceSink(run, span.id);
  const recordings: Promise<unknown>[] = [];
  let guard: MandateGuard;
  try {
    guard = new MandateGuard({
      mandate: mandate(), counterpartyAllowlist: ["supplier"], now: () => NOW,
      ...declaredHistory(log),
      onEvent: event => {
        log.append(event);
        const recording = recordTrace(event);
        recordings.push(recording);
        if (mode === "detached") return;
        return recording;
      },
    } as GuardConfig);
  } catch (error) {
    console.log(JSON.stringify({ refused: `construct: ${(error as Error).message}` }));
    return;
  }
  if (process.env.BARRIER) await barrier(process.env.BARRIER, 2);
  for (let i = 0; i < repeat; i++) {
    const args = JSON.parse(toolCallJson);
    const action = { ...args, kind: "payment", amount: BigInt(args.amount), timestamp: NOW } as GuardAction;
    try {
      const decision = mode === "detached" || mode === "sync" ? guard.enforce(action) : await guard.enforceAsync(action);
      if (decision.allowed) appendFileSync(ledger, `${args.amount}\n`);
      console.log(JSON.stringify(decision));
    } catch (error) {
      console.log(JSON.stringify({ refused: (error as Error).message }));
    }
  }
  await Promise.allSettled(recordings);
  console.log(JSON.stringify({ recordedEvents: run.events.length }));
}

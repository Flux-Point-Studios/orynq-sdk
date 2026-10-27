import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { serialize, deserialize } from "node:v8";
import { addEvent, addSpan, closeSpan, createTrace } from "@fluxpointstudios/orynq-sdk-process-trace";
import { buildAllowlistRoot, MandateGuard, toProcessTraceEvent, type GuardAction, type GuardEvent } from "../../../src/index.js";

export async function runHost(repeat: number): Promise<void> {
  const [ledger, toolCallJson, mode = "legacy"] = process.argv.slice(2) as [string, string, string?];
  const run = await createTrace({ agentId: "agent-1" });
  const span = addSpan(run, { name: "payments" });
  if (mode === "closed") await closeSpan(run, span.id);
  const eventFile = `${ledger}.events`;
  const events: GuardEvent[] = existsSync(eventFile) ? deserialize(readFileSync(eventFile)) : [];
  const guard = new MandateGuard({
    mandate: {
      schemaVersion: 1n, mandateId: new Uint8Array(16).fill(9), principalDid: "did:key:z123456789", agentDid: "did:key:z987654321", didFormatVersion: 0n,
      spendCap: { asset: "lovelace", amount: 10_000_000n, windowSeconds: 3600n },
      counterpartyAllowlistRoot: buildAllowlistRoot(["supplier"]), egressPolicy: { mode: 0n, allowlistRoot: new Uint8Array(32) },
      approvedMeasurementSetRoot: new Uint8Array(32), validityWindow: { notBefore: 0n, notAfter: 1n << 40n },
      disclosurePolicy: { committeeId: "c", threshold: 1n, committeeSize: 1n },
    },
    counterpartyAllowlist: ["supplier"], now: () => 1_793_100_000n,
    recordedEvents: events,
    onEvent: event => {
      const recording = addEvent(run, span.id, toProcessTraceEvent(event, {
        id: crypto.randomUUID(), seq: run.events.length, timestamp: new Date().toISOString(), visibility: "private",
      }));
      if (mode === "legacy") { void recording; return; }
      return recording.then(() => {
        events.push(event);
        writeFileSync(eventFile, serialize(events), { flush: true });
      });
    },
  });
  for (let i = 0; i < repeat; i++) {
    const args = JSON.parse(toolCallJson);
    const action = { ...args, kind: "payment", amount: BigInt(args.amount), timestamp: 1_793_100_000n } as GuardAction;
    try {
      const decision = mode === "legacy" || mode === "sync" ? guard.enforce(action) : await guard.enforceAsync(action);
      if (decision.allowed) appendFileSync(ledger, `${args.amount}\n`);
      console.log(JSON.stringify(decision));
    } catch (error) {
      console.log(JSON.stringify({ refused: (error as Error).message }));
    }
  }
  await new Promise(resolve => setTimeout(resolve, 30));
  console.log(JSON.stringify({ recordedEvents: run.events.length }));
}

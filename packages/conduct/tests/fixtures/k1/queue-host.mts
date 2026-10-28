import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { MandateGuard, type GuardAction, type GuardConfig } from "../../../src/index.js";
import { FileGuardLog } from "./file-log.mjs";
import { declaredHistory, mandate, NOW } from "./mandate.mjs";

// Long-running host with no exception handling around enforce: a poisoned tool call crashes it and its supervisor
// restarts it at the next queued call.
const [ledger, queueFile] = process.argv.slice(2) as [string, string];
const queue: string[] = JSON.parse(readFileSync(queueFile, "utf8"));
const cursorFile = `${ledger}.cursor`;
let cursor = existsSync(cursorFile) ? Number(readFileSync(cursorFile, "utf8")) : 0;
const log = new FileGuardLog(`${ledger}.log`);
const guard = new MandateGuard({
  mandate: mandate(), counterpartyAllowlist: ["supplier"], now: () => NOW,
  ...declaredHistory(log),
  onEvent: (event, previous) => log.append(event, previous),
} as GuardConfig);
while (cursor < queue.length) {
  const args = JSON.parse(queue[cursor]!);
  writeFileSync(cursorFile, String(++cursor));
  const decision = guard.enforce({ ...args, kind: "payment", amount: BigInt(args.amount), timestamp: NOW } as GuardAction);
  if (decision.allowed) appendFileSync(ledger, `${args.amount}\n`);
}

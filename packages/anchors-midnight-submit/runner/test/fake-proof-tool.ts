// Replays scripted proofs-mainnet summaries and prompts; records what the runner typed.
import { appendFileSync } from "node:fs";
import { confirmOnTerminal } from "../../src/preflight.js";
const sc = JSON.parse(process.env.PROOF_TEST_SCENARIO!) as { record: string; prompts: { label: string; summary: string; txHash: string; verb?: string }[]; exit?: number };
for (const p of sc.prompts) {
  process.stdout.write(`${p.summary}\n`);
  const ok = await confirmOnTerminal({ input: process.stdin, output: process.stdout, token: `${p.verb ?? "ANCHOR"} ${p.txHash.slice(0, 16)}`, what: `proof release ${p.label}` });
  appendFileSync(sc.record, `${JSON.stringify({ label: p.label, ok })}\n`);
  if (!ok) process.exit(1);
}
process.exit(sc.exit ?? 0);

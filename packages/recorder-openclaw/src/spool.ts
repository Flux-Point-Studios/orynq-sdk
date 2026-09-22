import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { isMissingFile } from "./util.js";

export type SpoolEvent = {
  ts: string;
  kind: "user" | "assistant" | "tool_call" | "tool_result" | "unknown";
  agentId?: string | undefined;
  sessionId?: string | undefined;
  contentHash: string;
  content?: string | null;
  meta?: Record<string, unknown>;
};

export async function appendSpool(outDir: string, bundleId: string, events: SpoolEvent[]) {
  const dir = path.join(outDir, "spool");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${bundleId}.jsonl`);
  const payload = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  // A crash or ENOSPC mid-append leaves a torn last line. Start on a fresh
  // line so the fragment stays one skippable line instead of corrupting the
  // next record forever.
  await fs.appendFile(file, (await endsTorn(file)) ? `\n${payload}` : payload, "utf-8");
}

async function endsTorn(file: string): Promise<boolean> {
  let fh: FileHandle;
  try {
    fh = await fs.open(file, "r");
  } catch (err) {
    if (isMissingFile(err)) return false;
    throw err;
  }
  try {
    const { size } = await fh.stat();
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    await fh.read(last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    await fh.close();
  }
}

export async function readSpool(outDir: string, bundleId: string): Promise<SpoolEvent[]> {
  const file = path.join(outDir, "spool", `${bundleId}.jsonl`);
  let raw = "";
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (err) {
    if (isMissingFile(err)) return [];
    throw err;
  }
  const events: SpoolEvent[] = [];
  let torn = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line) as SpoolEvent);
    } catch {
      torn++;
    }
  }
  if (torn > 0) console.error(`[spool] ${bundleId}: skipped ${torn} unparseable line(s) in ${file}`);
  return events;
}

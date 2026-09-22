import fs from "node:fs/promises";
import path from "node:path";

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
  await fs.appendFile(file, payload, "utf-8");
}

export async function readSpool(outDir: string, bundleId: string): Promise<SpoolEvent[]> {
  const file = path.join(outDir, "spool", `${bundleId}.jsonl`);
  let raw = "";
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as SpoolEvent);
}

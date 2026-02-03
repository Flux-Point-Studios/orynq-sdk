import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";

export type TailState = Record<string, number>; // filePath -> lastByteOffset

export async function loadTailState(statePath: string): Promise<TailState> {
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return JSON.parse(raw) as TailState;
  } catch {
    return {};
  }
}

export async function saveTailState(statePath: string, state: TailState): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf-8");
}

export async function readNewJsonlLines(filePath: string, lastOffset: number) {
  const stat = await fs.stat(filePath);
  if (stat.size <= lastOffset) return { lines: [] as string[], newOffset: stat.size };

  const stream = createReadStream(filePath, { start: lastOffset, end: stat.size });
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf-8");

  const parts = text.split("\n");
  const complete = parts.slice(0, -1).filter(Boolean);

  // If the last line is partial, don't advance past it.
  const partial = parts[parts.length - 1] ?? "";
  const newOffset = stat.size - Buffer.from(partial, "utf-8").length;

  return { lines: complete, newOffset };
}

import fs from "node:fs/promises";
import path from "node:path";

export async function findJsonlFiles(root: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  }

  await walk(root);
  return out;
}

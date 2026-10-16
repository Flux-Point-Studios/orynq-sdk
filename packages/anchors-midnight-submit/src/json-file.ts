import { readFileSync } from "node:fs";

export function readJsonFile(path: string): unknown {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    // Parser diagnostics can quote private file contents.
    if (error instanceof SyntaxError) throw new Error(`${path} is not JSON`);
    throw error;
  }
}

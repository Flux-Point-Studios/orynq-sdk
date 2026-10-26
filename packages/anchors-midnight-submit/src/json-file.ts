import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export function readJsonFile(path: string, expectedSha256?: string): unknown {
  const text = readFileSync(path, "utf8");
  if (expectedSha256 !== undefined && createHash("sha256").update(text).digest("hex") !== expectedSha256) {
    throw new Error(`${path}: sha256 does not match the approved file`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    // Parser diagnostics can quote private file contents.
    if (error instanceof SyntaxError) throw new Error(`${path} is not JSON`);
    throw error;
  }
}

import type { VerifyResult } from "./verify.js";

// A verify result as a terminal prints it and a model reads it: without the finality
// checkpoint, whose weights are bigints JSON cannot carry, and with every string a source could
// have shaped made printable and bounded.
export type VerifyReport = Omit<VerifyResult, "finality">;

const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}]/gu;
const HEX64 = /^[0-9a-f]{64}$/;

// Control, format, private-use and unassigned characters and line separators become "?", so no
// escape sequence or direction override reaches a terminal; text past `max` characters is cut.
export function printable(text: string, max = 300): string {
  const chars = [...text.replace(UNPRINTABLE, "?")];
  return chars.length > max ? `${chars.slice(0, max).join("")}...` : chars.join("");
}

export function verifyReport(result: VerifyResult): VerifyReport {
  const { finality: _finality, ...report } = result;
  const block = result.block;
  return {
    ...report,
    txHash: printable(result.txHash, 64),
    operators: result.operators.map((o) => printable(o, 64)),
    block: block && Number.isSafeInteger(block.height) && HEX64.test(block.hash) ? { height: block.height, hash: block.hash } : null,
    notes: result.notes.map((n) => printable(n)),
    checks: result.checks.map((c) => ({ name: printable(c.name, 64), ok: c.ok, detail: printable(c.detail) })),
  };
}

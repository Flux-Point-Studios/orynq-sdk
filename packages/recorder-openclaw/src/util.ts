import crypto from "node:crypto";

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function jitterMs(baseMs: number, jitterSeconds: number) {
  const j = Math.floor(Math.random() * jitterSeconds * 1000);
  return baseMs + j;
}

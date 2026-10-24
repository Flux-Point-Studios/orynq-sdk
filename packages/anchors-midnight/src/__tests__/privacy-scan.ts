// Counts encoded eight-byte source windows, including values split across fields.
const ENCODINGS: ReadonlyArray<(v: Uint8Array) => Buffer> = [
  (v) => Buffer.from(v),
  (v) => Buffer.from(v).reverse(),
  (v) => Buffer.from(Buffer.from(v).toString("hex")),
  (v) => Buffer.from(Buffer.from(v).toString("hex").toUpperCase()),
  (v) => Buffer.from(Buffer.from(v).toString("base64").replace(/=+$/, "")),
];

// The raw windows of a disclosed value that a ledger encoding holds: the ledger drops a value's
// trailing zero bytes, so a 32-byte value ending in k zero bytes shows 25 - k of them.
export function encodedWindows(value: Uint8Array): number {
  let end = value.length;
  while (end > 0 && value[end - 1] === 0) end--;
  return Math.max(0, end - 7);
}

export function windowHits(haystack: Uint8Array, value: Uint8Array): number {
  const hay = Buffer.from(haystack);
  let hits = 0;
  for (const encode of ENCODINGS) {
    for (let i = 0; i + 8 <= value.length; i++) if (hay.includes(encode(value.subarray(i, i + 8)))) hits++;
  }
  // Whole-value base64 groups bytes across source-window boundaries.
  const base64 = Buffer.from(Buffer.from(value).toString("base64").replace(/=+$/, ""));
  for (let i = 0; i + 11 <= base64.length; i++) {
    const firstByte = Math.ceil(i * 6 / 8);
    const completeBytes = Math.floor(Math.min((i + 11) * 6, value.length * 8) / 8) - firstByte;
    const width = completeBytes >= 8 ? 11 : 12;
    if (i + width <= base64.length && Math.floor(Math.min((i + width) * 6, value.length * 8) / 8) - firstByte >= 8 && hay.includes(base64.subarray(i, i + width))) hits++;
  }
  return hits;
}

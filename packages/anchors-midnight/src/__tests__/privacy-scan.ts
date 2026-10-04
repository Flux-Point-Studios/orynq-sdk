// Counts the 8-byte windows of `value`, in five encodings, that occur in `haystack`. Searching
// windows rather than whole values still finds a value the serializer split across field
// elements or re-chunked; a 32-byte value has 25 windows per encoding.
const ENCODINGS: ReadonlyArray<(v: Uint8Array) => Buffer> = [
  (v) => Buffer.from(v),
  (v) => Buffer.from(v).reverse(),
  (v) => Buffer.from(Buffer.from(v).toString("hex")),
  (v) => Buffer.from(Buffer.from(v).toString("hex").toUpperCase()),
  (v) => Buffer.from(Buffer.from(v).toString("base64")),
];

export function windowHits(haystack: Uint8Array, value: Uint8Array): number {
  const hay = Buffer.from(haystack);
  let hits = 0;
  for (const encode of ENCODINGS) {
    const e = encode(value);
    for (let i = 0; i + 8 <= e.length; i++) if (hay.includes(e.subarray(i, i + 8))) hits++;
  }
  return hits;
}

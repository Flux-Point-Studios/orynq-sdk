import { expect, it } from "vitest";
import { windowHits } from "./privacy-scan.js";

const secret = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
it("does not count a four-byte hex coincidence as an eight-byte disclosure", () => {
  const fragment = Buffer.from(secret.subarray(7, 11)).toString("hex");
  expect(windowHits(Buffer.from(`public field: ${fragment}`), secret)).toBe(0);
});
it("does not count an eight-character base64 coincidence as eight source bytes", () => {
  const fragment = Buffer.from(secret).toString("base64").slice(4, 12);
  expect(windowHits(Buffer.from(fragment), secret)).toBe(0);
});
it("detects every eight-byte source window independently in all five encodings", () => {
  const encodings = [(value: Uint8Array) => Buffer.from(value), (value: Uint8Array) => Buffer.from(value).reverse(), (value: Uint8Array) => Buffer.from(Buffer.from(value).toString("hex")), (value: Uint8Array) => Buffer.from(Buffer.from(value).toString("hex").toUpperCase()), (value: Uint8Array) => Buffer.from(Buffer.from(value).toString("base64"))];
  for (let i = 0; i + 8 <= secret.length; i++) for (const encode of encodings) expect(windowHits(encode(secret.subarray(i, i + 8)), secret)).toBeGreaterThan(0);
});
it("detects source material inside whole-value base64 and refuses shorter disclosures", () => {
  const encoded = Buffer.from(secret).toString("base64");
  for (let i = 0; i + 12 <= encoded.length; i++) expect(windowHits(Buffer.from(encoded.slice(i, i + 12)), secret)).toBeGreaterThan(0);
  for (const encode of [(value: Uint8Array) => Buffer.from(value), (value: Uint8Array) => Buffer.from(Buffer.from(value).toString("hex")), (value: Uint8Array) => Buffer.from(Buffer.from(value).toString("base64"))]) expect(windowHits(encode(secret.subarray(0, 7)), secret)).toBe(0);
});
it("does not promote base64 padding into source-byte disclosure", () => {
  const short = secret.subarray(0, 7), ten = secret.subarray(0, 10);
  expect(windowHits(Buffer.from(Buffer.from(short).toString("base64")), short)).toBe(0);
  expect(windowHits(Buffer.from(Buffer.from(ten).toString("base64").slice(4)), ten)).toBe(0);
});
it("detects unpadded base64 of every independent eight-byte window", () => {
  for (let i = 0; i + 8 <= secret.length; i++) expect(windowHits(Buffer.from(Buffer.from(secret.subarray(i, i + 8)).toString("base64").replace(/=+$/, "")), secret)).toBeGreaterThan(0);
});
it("detects eleven-character whole-base64 spans when they contain eight complete bytes", () => {
  const encoded = Buffer.from(secret).toString("base64");
  for (const offset of [0, 1, 4, 5]) expect(windowHits(Buffer.from(encoded.slice(offset, offset + 11)), secret)).toBeGreaterThan(0);
  for (const offset of [2, 3, 6, 7]) expect(windowHits(Buffer.from(encoded.slice(offset, offset + 11)), secret)).toBe(0);
});

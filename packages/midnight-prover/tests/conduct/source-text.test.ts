import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const pkg = resolve(import.meta.dirname, "../..");
const SOURCES = ["tests/conduct", "scripts/conduct"].flatMap(dir => readdirSync(join(pkg, dir)).map(name => `${dir}/${name}`))
  .concat("scripts/compile-conduct.mjs");
// Code points a reader cannot see and an editor may drop or normalize: NEL, the soft hyphen, zero-width and
// directional format characters, the line and paragraph separators, invisible operators and the BOM.
const INVISIBLE: readonly (readonly [number, number])[] = [[0x85, 0x85], [0xad, 0xad], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0xfeff, 0xfeff]];
const invisible = (line: string) => [...line].some(c => INVISIBLE.some(([low, high]) => c.codePointAt(0)! >= low && c.codePointAt(0)! <= high));

describe("the conduct sources write every invisible character as an escape", () => {
  it.each(SOURCES)("%s", path => {
    const lines = readFileSync(join(pkg, path), "utf8").split("\n");
    expect(lines.flatMap((line, i) => (invisible(line) ? [`${path}:${i + 1}`] : []))).toEqual([]);
  });
});

// JSON.parse alone silently accepts duplicate members. Policy signatures cover the source
// text, so every decoded key must have exactly one meaning, including escaped spellings.
export const MAX_POLICY_JSON_BYTES = 2 * 1024 * 1024;
export function parseStrictJson(text: string, maxBytes = MAX_POLICY_JSON_BYTES): unknown {
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error("Policy JSON exceeds its byte limit");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("Policy document is not valid JSON"); }
  let at = 0;
  const whitespace = () => { while (/\s/.test(text[at] ?? "") && at < text.length) at++; };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const character = text[at++];
      if (character === "\\") at++;
      else if (character === '"') return JSON.parse(text.slice(start, at)) as string;
    }
    throw new Error("Policy document is not valid JSON");
  };
  const value = (depth: number): void => {
    if (depth > 64) throw new Error("Policy JSON exceeds the nesting limit");
    whitespace();
    if (text[at] === "{") {
      at++; whitespace();
      const keys = new Set<string>();
      if (text[at] === "}") { at++; return; }
      for (;;) {
        const key = string();
        if (keys.has(key)) throw new Error("Policy JSON contains a duplicate object key");
        keys.add(key); whitespace(); at++; value(depth + 1); whitespace();
        if (text[at++] === "}") return;
        whitespace();
      }
    }
    if (text[at] === "[") {
      at++; whitespace();
      if (text[at] === "]") { at++; return; }
      for (;;) { value(depth + 1); whitespace(); if (text[at++] === "]") return; }
    }
    if (text[at] === '"') { string(); return; }
    while (at < text.length && !/[\s,\]}]/.test(text[at]!)) at++;
  };
  value(0);
  return parsed;
}

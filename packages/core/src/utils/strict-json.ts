// JSON.parse alone accepts duplicate members, lone surrogates and numbers it cannot represent, so
// two texts can decode to one value and one text to a value it does not spell. Signatures and
// hashes cover what callers decode: every key must have one meaning, including escaped
// spellings, every string must be well-formed Unicode, and every integer must have exactly one
// spelling within ±2^53. Other numbers pass through for the caller's schema to judge.

export const STRICT_JSON_MAX_DEPTH = 32;

export type StrictJsonErrorCode =
  | "JSON_TOO_LARGE"
  | "JSON_SYNTAX"
  | "JSON_DEPTH"
  | "JSON_DUPLICATE_KEY"
  | "JSON_LONE_SURROGATE"
  | "JSON_NUMBER";

// Messages never quote the input, which may hold secrets.
const MESSAGES: Readonly<Record<StrictJsonErrorCode, string>> = {
  JSON_TOO_LARGE: "JSON exceeds its byte limit",
  JSON_SYNTAX: "Document is not valid JSON",
  JSON_DEPTH: "JSON exceeds the nesting limit",
  JSON_DUPLICATE_KEY: "JSON contains a duplicate object key",
  JSON_LONE_SURROGATE: "JSON contains a lone surrogate",
  JSON_NUMBER: "JSON contains an unrepresentable or non-canonical number",
};

export class StrictJsonError extends Error {
  readonly code: StrictJsonErrorCode;

  constructor(code: StrictJsonErrorCode) {
    super(MESSAGES[code]);
    this.name = "StrictJsonError";
    this.code = code;
  }
}

const MAX_EXACT_INTEGER = 2n ** 53n;
const INTEGER = /^-?(0|[1-9][0-9]*)$/;
const LONE_SURROGATE = /\p{Cs}/u;

function checkNumber(lexeme: string): void {
  if (INTEGER.test(lexeme)) {
    const digits = lexeme.replace("-", "");
    if (lexeme === "-0" || digits.length > 16 || BigInt(digits) > MAX_EXACT_INTEGER) {
      throw new StrictJsonError("JSON_NUMBER");
    }
    return;
  }
  // A fraction or exponent must not spell an integer: 1.0 and 1e0 would both decode to 1, and
  // 9007199254740993.0 would decode to 2^53. Non-integral doubles are all below 2^53.
  const value = Number(lexeme);
  if (!Number.isFinite(value) || Number.isInteger(value)) throw new StrictJsonError("JSON_NUMBER");
}

export function parseStrictJson(text: string, maxBytes: number): unknown {
  if (text.length > maxBytes || new TextEncoder().encode(text).length > maxBytes) {
    throw new StrictJsonError("JSON_TOO_LARGE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StrictJsonError("JSON_SYNTAX");
  }
  // JSON.parse accepted the text, so the scan below only meets well-formed tokens.
  let at = 0;
  const whitespace = () => { while (at < text.length && /\s/.test(text[at]!)) at++; };
  const string = (): string => {
    const start = at++;
    while (text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
    const decoded = JSON.parse(text.slice(start, ++at)) as string;
    if (LONE_SURROGATE.test(decoded)) throw new StrictJsonError("JSON_LONE_SURROGATE");
    return decoded;
  };
  const value = (depth: number): void => {
    if (depth > STRICT_JSON_MAX_DEPTH) throw new StrictJsonError("JSON_DEPTH");
    whitespace();
    if (text[at] === "{") {
      at++; whitespace();
      if (text[at] === "}") { at++; return; }
      const keys = new Set<string>();
      for (;;) {
        const key = string();
        if (keys.has(key)) throw new StrictJsonError("JSON_DUPLICATE_KEY");
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
    const start = at;
    while (at < text.length && !/[\s,\]}]/.test(text[at]!)) at++;
    const lexeme = text.slice(start, at);
    if (lexeme !== "true" && lexeme !== "false" && lexeme !== "null") checkNumber(lexeme);
  };
  value(0);
  return parsed;
}

// JSON.parse alone accepts duplicate members, lone surrogates and numbers it cannot represent, so
// two texts can decode to one value and one text to a value it does not spell. Signatures and
// hashes cover what callers decode: every key must have one meaning, including escaped
// spellings, every string must be well-formed Unicode, and every integer must have exactly one
// spelling within ±2^53. Other numbers pass through for the caller's schema to judge.

// A value enclosed by more containers than this is refused; the top-level value is enclosed by
// none, so `[[]]` holds a value at level 1. conduct's CBOR decoder counts levels the same way.
export const STRICT_JSON_MAX_DEPTH = 32;

export type StrictJsonErrorCode =
  | "JSON_TOO_LARGE"
  | "JSON_VALUES"
  | "JSON_SYNTAX"
  | "JSON_DEPTH"
  | "JSON_DUPLICATE_KEY"
  | "JSON_LONE_SURROGATE"
  | "JSON_NUMBER";

// Messages never quote the input, which may hold secrets.
const MESSAGES: Readonly<Record<StrictJsonErrorCode, string>> = {
  JSON_TOO_LARGE: "JSON exceeds its byte limit",
  JSON_VALUES: "JSON exceeds its value limit",
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
const NON_ASCII = /[\u0080-\uffff]/;
const SURROGATE = /[\ud800-\udfff]/;
const LONE_SURROGATE = /\p{Cs}/u;

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const QUOTE = 0x22;
const PLUS = 0x2b;
const COMMA = 0x2c;
const MINUS = 0x2d;
const DOT = 0x2e;
const ZERO = 0x30;
const NINE = 0x39;
const COLON = 0x3a;
const UPPER_E = 0x45;
const OPEN_ARRAY = 0x5b;
const BACKSLASH = 0x5c;
const CLOSE_ARRAY = 0x5d;
const LOWER_E = 0x65;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;

const isWhitespace = (unit: number) => unit === SPACE || unit === LF || unit === CR || unit === TAB;
const isDigit = (unit: number) => unit >= ZERO && unit <= NINE;
const isDelimiter = (unit: number) =>
  isWhitespace(unit) || unit === COMMA || unit === COLON || unit === QUOTE ||
  unit === OPEN_ARRAY || unit === CLOSE_ARRAY || unit === OPEN_OBJECT || unit === CLOSE_OBJECT;

// What TextEncoder would write (a lone surrogate becomes U+FFFD), without allocating it.
function utf8Length(text: string): number {
  let bytes = 0;
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && (text.charCodeAt(at + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      at++;
    } else bytes += 3;
  }
  return bytes;
}

// Runs before JSON.parse, on text not yet known to be JSON, so a deep or wide text is refused
// before any of it is built. Every container, string and scalar counts as a value and every
// colon takes one back, its string having been a key. Over the prefix JSON.parse accepts that is
// exactly the values it builds, and it builds nothing past that prefix.
function checkShape(text: string, maxValues: number): void {
  let open = 0;
  let values = 0;
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at);
    if (unit === CLOSE_ARRAY || unit === CLOSE_OBJECT) {
      if (open > 0) open--;
      continue;
    }
    if (unit === COLON) {
      values--;
      continue;
    }
    if (isWhitespace(unit) || unit === COMMA) continue;
    if (open > STRICT_JSON_MAX_DEPTH) throw new StrictJsonError("JSON_DEPTH");
    if (++values > maxValues) throw new StrictJsonError("JSON_VALUES");
    if (unit === OPEN_ARRAY || unit === OPEN_OBJECT) {
      open++;
    } else if (unit === QUOTE) {
      at++;
      while (at < text.length && text.charCodeAt(at) !== QUOTE) at += text.charCodeAt(at) === BACKSLASH ? 2 : 1;
    } else {
      while (at + 1 < text.length && !isDelimiter(text.charCodeAt(at + 1))) at++;
    }
  }
}

// Checks the number at `at` and returns the index past it.
function checkNumber(text: string, at: number): number {
  const start = at;
  if (text.charCodeAt(at) === MINUS) at++;
  const digitsStart = at;
  let unit = text.charCodeAt(at);
  while (isDigit(unit)) unit = text.charCodeAt(++at);
  if (unit !== DOT && unit !== LOWER_E && unit !== UPPER_E) {
    const digits = at - digitsStart;
    // JSON.parse refused leading zeros, so 15 digits are below 2^53.
    if (digits < 16) {
      if (digits === 1 && digitsStart > start && text.charCodeAt(digitsStart) === ZERO) throw new StrictJsonError("JSON_NUMBER");
      return at;
    }
    if (digits > 16 || BigInt(text.slice(digitsStart, at)) > MAX_EXACT_INTEGER) throw new StrictJsonError("JSON_NUMBER");
    return at;
  }
  while (isDigit(unit) || unit === DOT || unit === LOWER_E || unit === UPPER_E || unit === PLUS || unit === MINUS) {
    unit = text.charCodeAt(++at);
  }
  // A fraction or exponent must not spell an integer: 1.0 and 1e0 would both decode to 1, and
  // 9007199254740993.0 would decode to 2^53. Non-integral doubles are all below 2^53.
  const value = Number(text.slice(start, at));
  if (!Number.isFinite(value) || Number.isInteger(value)) throw new StrictJsonError("JSON_NUMBER");
  return at;
}

// Runs after JSON.parse accepted the text, so it only meets well-formed tokens: a string after
// `{` or after a comma inside an object is a key. Each open object's keys are `true` while it has
// none, the key itself while it has one, then a Set.
function checkTokens(text: string): void {
  const surrogates = SURROGATE.test(text);
  const open: (boolean | string | Set<string>)[] = [];
  let expectKey = false;
  let at = 0;
  while (at < text.length) {
    const unit = text.charCodeAt(at);
    if (unit === QUOTE) {
      const start = at++;
      let escaped = false;
      for (;;) {
        const inner = text.charCodeAt(at);
        if (inner === QUOTE) break;
        if (inner === BACKSLASH) {
          escaped = true;
          at += 2;
        } else at++;
      }
      at++;
      if (!expectKey && !escaped && !surrogates) continue;
      const decoded = escaped ? (JSON.parse(text.slice(start, at)) as string) : text.slice(start + 1, at - 1);
      if ((escaped || surrogates) && LONE_SURROGATE.test(decoded)) throw new StrictJsonError("JSON_LONE_SURROGATE");
      if (!expectKey) continue;
      expectKey = false;
      const top = open.length - 1;
      const keys = open[top] as true | string | Set<string>;
      if (keys === true) {
        open[top] = decoded;
      } else if (typeof keys === "string") {
        if (keys === decoded) throw new StrictJsonError("JSON_DUPLICATE_KEY");
        open[top] = new Set([keys, decoded]);
      } else {
        if (keys.has(decoded)) throw new StrictJsonError("JSON_DUPLICATE_KEY");
        keys.add(decoded);
      }
      continue;
    }
    if (unit === MINUS || isDigit(unit)) {
      at = checkNumber(text, at);
      continue;
    }
    if (unit === OPEN_OBJECT) {
      open.push(true);
      expectKey = true;
    } else if (unit === OPEN_ARRAY) {
      open.push(false);
    } else if (unit === CLOSE_OBJECT || unit === CLOSE_ARRAY) {
      open.pop();
    } else if (unit === COMMA) {
      expectKey = open[open.length - 1] !== false;
    }
    at++;
  }
}

function fitsBytes(text: string, maxBytes: number): boolean {
  if (text.length > maxBytes) return false;
  if (text.length * 3 <= maxBytes || !NON_ASCII.test(text)) return true;
  return utf8Length(text) <= maxBytes;
}

// A NaN limit fails every comparison, so it would bound nothing.
function checkLimit(name: string, limit: unknown): void {
  if (limit === Number.POSITIVE_INFINITY || (Number.isInteger(limit) && (limit as number) >= 0)) return;
  throw new TypeError(`${name} must be a non-negative integer or Infinity`);
}

// A value is a container, a string, a number or a literal: `{"a":[1]}` holds three. Nesting and
// values are judged first, so a deep or wide text is refused as JSON_DEPTH or JSON_VALUES even
// when it is also invalid.
export function parseStrictJson(text: string, maxBytes: number, maxValues = Number.POSITIVE_INFINITY): unknown {
  checkLimit("maxBytes", maxBytes);
  checkLimit("maxValues", maxValues);
  if (!fitsBytes(text, maxBytes)) throw new StrictJsonError("JSON_TOO_LARGE");
  checkShape(text, maxValues);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StrictJsonError("JSON_SYNTAX");
  }
  checkTokens(text);
  return parsed;
}

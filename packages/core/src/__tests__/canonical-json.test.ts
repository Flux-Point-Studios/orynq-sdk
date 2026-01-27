/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/core/src/__tests__/canonical-json.test.ts
 * @summary Tests for RFC 8785 (JCS) JSON Canonicalization implementation.
 */

import { describe, it, expect } from 'vitest';
import { canonicalize } from '../utils/canonical-json.js';

describe('canonicalize', () => {
  describe('key ordering', () => {
    it('sorts keys alphabetically', () => {
      const input = { z: 1, a: 2, m: 3 };
      expect(canonicalize(input)).toBe('{"a":2,"m":3,"z":1}');
    });

    it('handles nested objects with sorted keys', () => {
      const input = { b: { z: 1, a: 2 }, a: 1 };
      expect(canonicalize(input)).toBe('{"a":1,"b":{"a":2,"z":1}}');
    });

    it('handles deeply nested objects', () => {
      const input = { c: { b: { a: 1 } }, a: { z: { y: 2 } } };
      expect(canonicalize(input)).toBe('{"a":{"z":{"y":2}},"c":{"b":{"a":1}}}');
    });
  });

  describe('array handling', () => {
    it('preserves array order', () => {
      const input = { arr: [3, 1, 2] };
      expect(canonicalize(input)).toBe('{"arr":[3,1,2]}');
    });

    it('handles arrays with objects', () => {
      const input = { arr: [{ b: 2, a: 1 }, { d: 4, c: 3 }] };
      expect(canonicalize(input)).toBe('{"arr":[{"a":1,"b":2},{"c":3,"d":4}]}');
    });

    it('handles nested arrays', () => {
      const input = { arr: [[3, 2, 1], [6, 5, 4]] };
      expect(canonicalize(input)).toBe('{"arr":[[3,2,1],[6,5,4]]}');
    });

    it('handles empty arrays', () => {
      const input = { arr: [] };
      expect(canonicalize(input)).toBe('{"arr":[]}');
    });
  });

  describe('null and undefined handling', () => {
    it('removes null values by default', () => {
      const input = { a: 1, b: null, c: 3 };
      expect(canonicalize(input)).toBe('{"a":1,"c":3}');
    });

    it('removes undefined values', () => {
      const input = { a: 1, b: undefined, c: 3 };
      expect(canonicalize(input)).toBe('{"a":1,"c":3}');
    });

    it('preserves null values when removeNulls is false', () => {
      const input = { a: 1, b: null, c: 3 };
      expect(canonicalize(input, { removeNulls: false })).toBe('{"a":1,"b":null,"c":3}');
    });

    it('converts undefined to null in arrays', () => {
      const input = { arr: [1, undefined, 3] };
      expect(canonicalize(input)).toBe('{"arr":[1,null,3]}');
    });
  });

  describe('empty structures', () => {
    it('handles empty objects', () => {
      expect(canonicalize({})).toBe('{}');
    });

    it('handles nested empty objects', () => {
      const input = { a: {} };
      expect(canonicalize(input)).toBe('{"a":{}}');
    });
  });

  describe('string handling', () => {
    it('handles strings with newlines', () => {
      const input = { text: 'hello\nworld' };
      expect(canonicalize(input)).toBe('{"text":"hello\\nworld"}');
    });

    it('handles strings with tabs', () => {
      const input = { text: 'hello\tworld' };
      expect(canonicalize(input)).toBe('{"text":"hello\\tworld"}');
    });

    it('handles strings with quotes', () => {
      const input = { text: 'say "hello"' };
      expect(canonicalize(input)).toBe('{"text":"say \\"hello\\""}');
    });

    it('handles strings with backslashes', () => {
      const input = { path: 'C:\\Users\\test' };
      expect(canonicalize(input)).toBe('{"path":"C:\\\\Users\\\\test"}');
    });

    it('handles unicode strings', () => {
      const input = { emoji: '\u{1F600}', japanese: '\u3053\u3093\u306B\u3061\u306F' };
      const result = canonicalize(input);
      expect(result).toContain('"emoji"');
      expect(result).toContain('"japanese"');
    });

    it('handles empty strings', () => {
      const input = { empty: '' };
      expect(canonicalize(input)).toBe('{"empty":""}');
    });
  });

  describe('number handling', () => {
    it('handles integers correctly', () => {
      const input = { int: 42, neg: -1, zero: 0 };
      const result = canonicalize(input);
      expect(result).toContain('"int":42');
      expect(result).toContain('"neg":-1');
      expect(result).toContain('"zero":0');
    });

    it('handles floating point numbers', () => {
      const input = { float: 3.14 };
      expect(canonicalize(input)).toBe('{"float":3.14}');
    });

    it('handles negative zero as zero', () => {
      const input = { negZero: -0 };
      expect(canonicalize(input)).toBe('{"negZero":0}');
    });

    it('handles large numbers', () => {
      const input = { large: 9007199254740991 }; // Number.MAX_SAFE_INTEGER
      expect(canonicalize(input)).toBe('{"large":9007199254740991}');
    });

    it('handles small decimals', () => {
      const input = { small: 0.0001 };
      expect(canonicalize(input)).toBe('{"small":0.0001}');
    });

    it('throws for NaN', () => {
      const input = { nan: NaN };
      expect(() => canonicalize(input)).toThrow();
    });

    it('throws for Infinity', () => {
      const input = { inf: Infinity };
      expect(() => canonicalize(input)).toThrow();
    });

    it('throws for -Infinity', () => {
      const input = { negInf: -Infinity };
      expect(() => canonicalize(input)).toThrow();
    });
  });

  describe('boolean handling', () => {
    it('handles boolean values', () => {
      const input = { t: true, f: false };
      expect(canonicalize(input)).toBe('{"f":false,"t":true}');
    });
  });

  describe('circular reference detection', () => {
    it('throws for circular references', () => {
      const obj: Record<string, unknown> = { a: 1 };
      obj['self'] = obj;
      expect(() => canonicalize(obj)).toThrow(/circular/i);
    });

    it('handles shared references (non-circular)', () => {
      const shared = { x: 1 };
      const input = { a: shared, b: shared };
      expect(canonicalize(input)).toBe('{"a":{"x":1},"b":{"x":1}}');
    });
  });

  describe('depth limiting', () => {
    it('throws when max depth is exceeded', () => {
      // Build a deeply nested object
      let obj: Record<string, unknown> = { value: 1 };
      for (let i = 0; i < 150; i++) {
        obj = { nested: obj };
      }
      expect(() => canonicalize(obj, { maxDepth: 100 })).toThrow(/maximum depth/i);
    });
  });

  describe('top-level primitives', () => {
    it('handles top-level strings', () => {
      expect(canonicalize('hello')).toBe('"hello"');
    });

    it('handles top-level numbers', () => {
      expect(canonicalize(42)).toBe('42');
    });

    it('handles top-level booleans', () => {
      expect(canonicalize(true)).toBe('true');
      expect(canonicalize(false)).toBe('false');
    });

    it('handles top-level null', () => {
      expect(canonicalize(null)).toBe('null');
    });

    it('handles top-level arrays', () => {
      expect(canonicalize([1, 2, 3])).toBe('[1,2,3]');
    });

    it('throws for top-level undefined', () => {
      expect(() => canonicalize(undefined)).toThrow();
    });
  });

  describe('unsupported types', () => {
    it('throws for functions', () => {
      const input = { fn: () => {} };
      expect(() => canonicalize(input)).toThrow();
    });

    it('throws for symbols', () => {
      const input = { sym: Symbol('test') };
      expect(() => canonicalize(input)).toThrow();
    });

    it('throws for BigInt', () => {
      const input = { big: BigInt(9007199254740991) };
      expect(() => canonicalize(input)).toThrow();
    });
  });

  describe('determinism', () => {
    it('produces identical output for semantically equivalent objects', () => {
      const obj1 = { z: 1, a: 2, m: 3 };
      const obj2 = { a: 2, m: 3, z: 1 };
      const obj3 = { m: 3, z: 1, a: 2 };

      const result1 = canonicalize(obj1);
      const result2 = canonicalize(obj2);
      const result3 = canonicalize(obj3);

      expect(result1).toBe(result2);
      expect(result2).toBe(result3);
    });

    it('produces deterministic output across multiple calls', () => {
      const input = { nested: { b: 2, a: 1 }, arr: [3, 2, 1], value: 'test' };
      const results = Array.from({ length: 10 }, () => canonicalize(input));
      const first = results[0];
      expect(results.every(r => r === first)).toBe(true);
    });
  });
});

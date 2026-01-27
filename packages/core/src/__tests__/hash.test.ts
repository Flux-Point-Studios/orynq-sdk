/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/core/src/__tests__/hash.test.ts
 * @summary Tests for SHA256 hashing and idempotency key generation.
 */

import { describe, it, expect } from 'vitest';
import {
  sha256,
  sha256String,
  sha256Hex,
  sha256StringHex,
  generateIdempotencyKey,
  bytesToHex,
  hexToBytes,
  isValidHex,
  bytesToBase64,
  base64ToBytes,
  bytesToBase64Url,
  base64UrlToBytes,
  generateContentHash,
  verifyContentHash,
} from '../utils/hash.js';

describe('sha256', () => {
  it('produces consistent 32-byte output', async () => {
    const data = new TextEncoder().encode('hello world');
    const result = await sha256(data);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(32);
  });

  it('produces deterministic output', async () => {
    const data = new TextEncoder().encode('test');
    const a = await sha256(data);
    const b = await sha256(data);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it('produces different output for different input', async () => {
    const a = await sha256(new TextEncoder().encode('hello'));
    const b = await sha256(new TextEncoder().encode('world'));
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });

  it('handles empty input', async () => {
    const result = await sha256(new Uint8Array(0));
    expect(result.length).toBe(32);
    // SHA256 of empty string is well-known
    expect(bytesToHex(result)).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('sha256String', () => {
  it('produces consistent 32-byte output', async () => {
    const result = await sha256String('hello world');
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(32);
  });

  it('produces same result as sha256 with encoded string', async () => {
    const text = 'test string';
    const fromString = await sha256String(text);
    const fromBytes = await sha256(new TextEncoder().encode(text));
    expect(bytesToHex(fromString)).toBe(bytesToHex(fromBytes));
  });
});

describe('sha256Hex', () => {
  it('produces 64-character lowercase hex output', async () => {
    const data = new TextEncoder().encode('hello world');
    const result = await sha256Hex(data);
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[a-f0-9]+$/);
  });
});

describe('sha256StringHex', () => {
  it('produces 64-character lowercase hex output', async () => {
    const result = await sha256StringHex('hello world');
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[a-f0-9]+$/);
  });

  it('produces deterministic output', async () => {
    const a = await sha256StringHex('test');
    const b = await sha256StringHex('test');
    expect(a).toBe(b);
  });

  it('produces different output for different input', async () => {
    const a = await sha256StringHex('hello');
    const b = await sha256StringHex('world');
    expect(a).not.toBe(b);
  });

  // Known test vector
  it('matches known SHA256 output for "hello"', async () => {
    const result = await sha256StringHex('hello');
    expect(result).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  // Additional known test vectors
  it('matches known SHA256 output for empty string', async () => {
    const result = await sha256StringHex('');
    expect(result).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches known SHA256 output for "hello world"', async () => {
    const result = await sha256StringHex('hello world');
    expect(result).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });
});

describe('generateIdempotencyKey', () => {
  it('produces consistent keys for same input', async () => {
    const a = await generateIdempotencyKey('POST', 'https://api.example.com/infer', { model: 'gpt-4' });
    const b = await generateIdempotencyKey('POST', 'https://api.example.com/infer', { model: 'gpt-4' });
    expect(a).toBe(b);
  });

  it('produces different keys for different methods', async () => {
    const a = await generateIdempotencyKey('POST', 'https://api.example.com/infer', {});
    const b = await generateIdempotencyKey('GET', 'https://api.example.com/infer', {});
    expect(a).not.toBe(b);
  });

  it('produces different keys for different URLs', async () => {
    const a = await generateIdempotencyKey('POST', 'https://api.example.com/infer', {});
    const b = await generateIdempotencyKey('POST', 'https://api.example.com/chat', {});
    expect(a).not.toBe(b);
  });

  it('produces different keys for different bodies', async () => {
    const a = await generateIdempotencyKey('POST', 'https://api.example.com/infer', { model: 'gpt-4' });
    const b = await generateIdempotencyKey('POST', 'https://api.example.com/infer', { model: 'gpt-3' });
    expect(a).not.toBe(b);
  });

  it('handles undefined body', async () => {
    const result = await generateIdempotencyKey('GET', 'https://api.example.com/status', undefined);
    expect(result).toMatch(/^idem_[a-f0-9]{32}$/);
  });

  it('handles null body', async () => {
    const result = await generateIdempotencyKey('GET', 'https://api.example.com/status', null);
    expect(result).toMatch(/^idem_[a-f0-9]{32}$/);
  });

  it('produces key with default prefix "idem"', async () => {
    const result = await generateIdempotencyKey('POST', 'https://api.example.com/pay', { amount: 100 });
    expect(result).toMatch(/^idem_/);
  });

  it('respects custom prefix', async () => {
    const result = await generateIdempotencyKey(
      'POST',
      'https://api.example.com/pay',
      { amount: 100 },
      { prefix: 'pay' }
    );
    expect(result).toMatch(/^pay_/);
  });

  it('respects custom length', async () => {
    const result = await generateIdempotencyKey(
      'POST',
      'https://api.example.com/pay',
      { amount: 100 },
      { prefix: '', length: 16 }
    );
    expect(result).toHaveLength(16);
  });

  it('normalizes HTTP method to uppercase', async () => {
    const a = await generateIdempotencyKey('post', 'https://api.example.com/infer', {});
    const b = await generateIdempotencyKey('POST', 'https://api.example.com/infer', {});
    expect(a).toBe(b);
  });

  it('normalizes URL by removing default ports', async () => {
    const a = await generateIdempotencyKey('POST', 'https://api.example.com:443/infer', {});
    const b = await generateIdempotencyKey('POST', 'https://api.example.com/infer', {});
    expect(a).toBe(b);
  });

  it('normalizes URL by removing trailing slashes', async () => {
    const a = await generateIdempotencyKey('POST', 'https://api.example.com/infer/', {});
    const b = await generateIdempotencyKey('POST', 'https://api.example.com/infer', {});
    expect(a).toBe(b);
  });

  it('produces unique keys with includeTimestamp option', async () => {
    const a = await generateIdempotencyKey(
      'POST',
      'https://api.example.com/pay',
      { amount: 100 },
      { includeTimestamp: true }
    );
    // Wait a tiny bit to ensure different timestamp
    await new Promise(resolve => setTimeout(resolve, 5));
    const b = await generateIdempotencyKey(
      'POST',
      'https://api.example.com/pay',
      { amount: 100 },
      { includeTimestamp: true }
    );
    expect(a).not.toBe(b);
  });
});

describe('bytesToHex', () => {
  it('converts bytes to lowercase hex', () => {
    const bytes = new Uint8Array([0, 255, 16, 128]);
    expect(bytesToHex(bytes)).toBe('00ff1080');
  });

  it('handles empty array', () => {
    expect(bytesToHex(new Uint8Array(0))).toBe('');
  });

  it('pads single-digit hex values', () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(bytesToHex(bytes)).toBe('000102030405060708090a0b0c0d0e0f');
  });
});

describe('hexToBytes', () => {
  it('converts hex to bytes', () => {
    const bytes = hexToBytes('00ff1080');
    expect(bytes).toEqual(new Uint8Array([0, 255, 16, 128]));
  });

  it('handles 0x prefix', () => {
    const bytes = hexToBytes('0x00ff1080');
    expect(bytes).toEqual(new Uint8Array([0, 255, 16, 128]));
  });

  it('handles uppercase hex', () => {
    const bytes = hexToBytes('00FF1080');
    expect(bytes).toEqual(new Uint8Array([0, 255, 16, 128]));
  });

  it('handles empty string', () => {
    expect(hexToBytes('')).toEqual(new Uint8Array(0));
  });

  it('throws for odd-length hex string', () => {
    expect(() => hexToBytes('abc')).toThrow(/even length/);
  });

  it('throws for invalid hex characters', () => {
    // Use even-length string to test character validation
    expect(() => hexToBytes('ghij')).toThrow(/invalid/i);
  });

  it('round-trips with bytesToHex', () => {
    const original = new Uint8Array([1, 2, 3, 100, 200, 255]);
    const hex = bytesToHex(original);
    const restored = hexToBytes(hex);
    expect(restored).toEqual(original);
  });
});

describe('isValidHex', () => {
  it('returns true for valid hex', () => {
    expect(isValidHex('00ff1080')).toBe(true);
    expect(isValidHex('AABBCCDD')).toBe(true);
    expect(isValidHex('0x00ff1080')).toBe(true);
  });

  it('returns false for odd-length strings', () => {
    expect(isValidHex('abc')).toBe(false);
  });

  it('returns false for invalid characters', () => {
    expect(isValidHex('ghij')).toBe(false);
  });

  it('validates expected length', () => {
    expect(isValidHex('00ff1080', 4)).toBe(true);
    expect(isValidHex('00ff1080', 3)).toBe(false);
  });

  it('returns true for empty string', () => {
    expect(isValidHex('')).toBe(true);
    expect(isValidHex('', 0)).toBe(true);
  });
});

describe('base64 encoding', () => {
  describe('bytesToBase64', () => {
    it('encodes bytes to base64', () => {
      const bytes = new TextEncoder().encode('hello');
      expect(bytesToBase64(bytes)).toBe('aGVsbG8=');
    });

    it('handles empty array', () => {
      expect(bytesToBase64(new Uint8Array(0))).toBe('');
    });
  });

  describe('base64ToBytes', () => {
    it('decodes base64 to bytes', () => {
      const bytes = base64ToBytes('aGVsbG8=');
      expect(new TextDecoder().decode(bytes)).toBe('hello');
    });

    it('handles empty string', () => {
      expect(base64ToBytes('')).toEqual(new Uint8Array(0));
    });

    it('round-trips with bytesToBase64', () => {
      const original = new TextEncoder().encode('test string with unicode');
      const base64 = bytesToBase64(original);
      const restored = base64ToBytes(base64);
      expect(restored).toEqual(original);
    });
  });

  describe('bytesToBase64Url', () => {
    it('produces URL-safe base64', () => {
      // Create bytes that would produce + and / in standard base64
      const bytes = new Uint8Array([251, 254, 253]);
      const urlSafe = bytesToBase64Url(bytes);
      expect(urlSafe).not.toContain('+');
      expect(urlSafe).not.toContain('/');
      expect(urlSafe).not.toContain('=');
    });
  });

  describe('base64UrlToBytes', () => {
    it('decodes URL-safe base64', () => {
      const bytes = new Uint8Array([251, 254, 253]);
      const urlSafe = bytesToBase64Url(bytes);
      const restored = base64UrlToBytes(urlSafe);
      expect(restored).toEqual(bytes);
    });

    it('handles standard base64 input', () => {
      const bytes = base64UrlToBytes('aGVsbG8=');
      expect(new TextDecoder().decode(bytes)).toBe('hello');
    });
  });
});

describe('content hash utilities', () => {
  describe('generateContentHash', () => {
    it('generates hash with algorithm identifier', async () => {
      const hash = await generateContentHash('test content');
      expect(hash.algorithm).toBe('sha256');
      expect(hash.value).toHaveLength(64);
      expect(hash.value).toMatch(/^[a-f0-9]+$/);
    });

    it('accepts string input', async () => {
      const hash = await generateContentHash('hello');
      expect(hash.value).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    });

    it('accepts Uint8Array input', async () => {
      const bytes = new TextEncoder().encode('hello');
      const hash = await generateContentHash(bytes);
      expect(hash.value).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    });
  });

  describe('verifyContentHash', () => {
    it('returns true for matching hash', async () => {
      const content = 'test content';
      const hash = await generateContentHash(content);
      const result = await verifyContentHash(content, hash.value);
      expect(result).toBe(true);
    });

    it('returns false for non-matching hash', async () => {
      const result = await verifyContentHash('test content', 'invalid_hash_0000000000000000000000000000000000000000000000000000');
      expect(result).toBe(false);
    });

    it('handles uppercase hash input', async () => {
      const hash = '2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824';
      const result = await verifyContentHash('hello', hash);
      expect(result).toBe(true);
    });

    it('accepts Uint8Array content', async () => {
      const bytes = new TextEncoder().encode('hello');
      const hash = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
      const result = await verifyContentHash(bytes, hash);
      expect(result).toBe(true);
    });
  });
});

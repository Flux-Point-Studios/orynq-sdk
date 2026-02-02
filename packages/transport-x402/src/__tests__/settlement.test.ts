import { describe, it, expect } from 'vitest';
import {
  parseSettlement,
  parsePaymentResponse,
  x402ResponseToSettlement,
  isPaymentSettled,
  getSettlementTxHash,
} from '../settlement';
import { X402_HEADERS } from '@fluxpointstudios/poi-sdk-core';

describe('parseSettlement', () => {
  it('returns null if PAYMENT-RESPONSE header missing', () => {
    const response = new Response('', { status: 200 });
    const result = parseSettlement(response);
    expect(result).toBeNull();
  });

  it('parses settlement from response header', () => {
    const payload = {
      txHash: '0xabc123def456789012345678901234567890123456789012345678901234abcd',
      settledAt: '2024-01-01T00:00:00Z',
      success: true,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');

    const response = new Response('', {
      status: 200,
      headers: { [X402_HEADERS.PAYMENT_RESPONSE]: encoded },
    });

    const settlement = parseSettlement(response);

    expect(settlement).not.toBeNull();
    expect(settlement?.txHash).toBe('0xabc123def456789012345678901234567890123456789012345678901234abcd');
    expect(settlement?.success).toBe(true);
    expect(settlement?.settledAt).toBe('2024-01-01T00:00:00Z');
  });

  it('parses failed settlement with error message', () => {
    const payload = {
      success: false,
      error: 'Insufficient funds',
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');

    const response = new Response('', {
      status: 200,
      headers: { [X402_HEADERS.PAYMENT_RESPONSE]: encoded },
    });

    const settlement = parseSettlement(response);

    expect(settlement).not.toBeNull();
    expect(settlement?.success).toBe(false);
    expect(settlement?.error).toBe('Insufficient funds');
    expect(settlement?.txHash).toBeUndefined();
  });

  it('handles minimal success response', () => {
    const payload = {
      success: true,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');

    const response = new Response('', {
      status: 200,
      headers: { [X402_HEADERS.PAYMENT_RESPONSE]: encoded },
    });

    const settlement = parseSettlement(response);

    expect(settlement).not.toBeNull();
    expect(settlement?.success).toBe(true);
    expect(settlement?.txHash).toBeUndefined();
    expect(settlement?.settledAt).toBeUndefined();
    expect(settlement?.error).toBeUndefined();
  });
});

describe('parsePaymentResponse', () => {
  it('decodes and parses valid response', () => {
    const payload = {
      success: true,
      txHash: '0x123abc',
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');

    const settlement = parsePaymentResponse(encoded);

    expect(settlement.success).toBe(true);
    expect(settlement.txHash).toBe('0x123abc');
  });

  it('throws on invalid base64', () => {
    expect(() => parsePaymentResponse('not-valid-base64!!!')).toThrow();
  });

  it('throws on invalid JSON', () => {
    const invalidJson = Buffer.from('not json').toString('base64');
    expect(() => parsePaymentResponse(invalidJson)).toThrow();
  });

  it('handles URL-safe base64', () => {
    const payload = { success: true };
    const standardBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
    const urlSafeBase64 = standardBase64.replace(/\+/g, '-').replace(/\//g, '_');

    const settlement = parsePaymentResponse(urlSafeBase64);

    expect(settlement.success).toBe(true);
  });
});

describe('x402ResponseToSettlement', () => {
  it('converts valid response to settlement', () => {
    const raw = {
      success: true,
      txHash: '0x123',
      settledAt: '2024-06-15T12:00:00Z',
    };

    const settlement = x402ResponseToSettlement(raw);

    expect(settlement.success).toBe(true);
    expect(settlement.txHash).toBe('0x123');
    expect(settlement.settledAt).toBe('2024-06-15T12:00:00Z');
  });

  it('throws for missing success field', () => {
    const raw = {
      txHash: '0x123',
    };

    expect(() => x402ResponseToSettlement(raw)).toThrow();
    expect(() => x402ResponseToSettlement(raw)).toThrow(/success/);
  });

  it('throws for non-boolean success', () => {
    const raw = {
      success: 'yes',
      txHash: '0x123',
    };

    expect(() => x402ResponseToSettlement(raw)).toThrow();
  });

  it('throws for null input', () => {
    expect(() => x402ResponseToSettlement(null)).toThrow();
  });

  it('throws for non-object input', () => {
    expect(() => x402ResponseToSettlement('string')).toThrow();
    expect(() => x402ResponseToSettlement(123)).toThrow();
    expect(() => x402ResponseToSettlement([])).toThrow();
  });

  it('ignores non-string optional fields', () => {
    const raw = {
      success: true,
      txHash: 12345, // Not a string - should be ignored
      settledAt: null, // Not a string - should be ignored
    };

    const settlement = x402ResponseToSettlement(raw);

    expect(settlement.success).toBe(true);
    expect(settlement.txHash).toBeUndefined();
    expect(settlement.settledAt).toBeUndefined();
  });

  it('collects extra fields', () => {
    const raw = {
      success: true,
      txHash: '0x123',
      network: 'eip155:8453',
      customField: 'customValue',
      anotherField: 42,
    };

    const settlement = x402ResponseToSettlement(raw);

    expect(settlement.success).toBe(true);
    expect(settlement.extra).toBeDefined();
    expect(settlement.extra?.customField).toBe('customValue');
    expect(settlement.extra?.anotherField).toBe(42);
    // 'network' is a known field, so it shouldn't be in extra
    expect(settlement.extra?.network).toBeUndefined();
  });

  it('does not include extra if no unknown fields', () => {
    const raw = {
      success: true,
      txHash: '0x123',
      settledAt: '2024-01-01T00:00:00Z',
    };

    const settlement = x402ResponseToSettlement(raw);

    expect(settlement.extra).toBeUndefined();
  });
});

describe('isPaymentSettled', () => {
  it('returns true for successful settlement', () => {
    const payload = { success: true };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');

    const response = new Response('', {
      status: 200,
      headers: { [X402_HEADERS.PAYMENT_RESPONSE]: encoded },
    });

    expect(isPaymentSettled(response)).toBe(true);
  });

  it('returns false for failed settlement', () => {
    const payload = { success: false, error: 'Payment failed' };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');

    const response = new Response('', {
      status: 200,
      headers: { [X402_HEADERS.PAYMENT_RESPONSE]: encoded },
    });

    expect(isPaymentSettled(response)).toBe(false);
  });

  it('returns false when no settlement header present', () => {
    const response = new Response('', { status: 200 });
    expect(isPaymentSettled(response)).toBe(false);
  });
});

describe('getSettlementTxHash', () => {
  it('returns txHash from settlement', () => {
    const payload = {
      success: true,
      txHash: '0xabcdef1234567890',
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');

    const response = new Response('', {
      status: 200,
      headers: { [X402_HEADERS.PAYMENT_RESPONSE]: encoded },
    });

    expect(getSettlementTxHash(response)).toBe('0xabcdef1234567890');
  });

  it('returns null when no txHash in settlement', () => {
    const payload = { success: true };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');

    const response = new Response('', {
      status: 200,
      headers: { [X402_HEADERS.PAYMENT_RESPONSE]: encoded },
    });

    expect(getSettlementTxHash(response)).toBeNull();
  });

  it('returns null when no settlement header', () => {
    const response = new Response('', { status: 200 });
    expect(getSettlementTxHash(response)).toBeNull();
  });
});

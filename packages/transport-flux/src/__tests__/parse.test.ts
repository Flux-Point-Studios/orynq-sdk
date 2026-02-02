import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseFluxInvoice, parse402Response, looksLikeFluxResponse, extractInvoiceIdFromHeaders } from '../parse';
import type { FluxInvoice } from '../types';

describe('parseFluxInvoice', () => {
  it('converts Flux invoice to PaymentRequest', () => {
    const invoice: FluxInvoice = {
      invoiceId: 'inv_123',
      amount: '2000000',
      currency: 'ADA',
      payTo: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
      chain: 'cardano-mainnet',
      expiresAt: '2024-12-31T23:59:59Z',
    };

    const request = parseFluxInvoice(invoice);

    expect(request.protocol).toBe('flux');
    expect(request.invoiceId).toBe('inv_123');
    expect(request.chain).toBe('cardano:mainnet'); // CAIP-2 format
    expect(request.asset).toBe('ADA');
    expect(request.amountUnits).toBe('2000000');
    expect(request.payTo).toBe('addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp');
  });

  it('handles invoice with splits', () => {
    const invoice: FluxInvoice = {
      invoiceId: 'inv_split',
      amount: '3000000',
      currency: 'ADA',
      payTo: 'addr_primary...',
      chain: 'cardano-mainnet',
      splitMode: 'inclusive',
      splits: [
        { to: 'addr_partner...', amount: '500000', role: 'partner' },
        { to: 'addr_treasury...', amount: '500000', role: 'treasury' },
      ],
    };

    const request = parseFluxInvoice(invoice);

    expect(request.splits).not.toBeUndefined();
    expect(request.splits?.mode).toBe('inclusive');
    expect(request.splits?.outputs).toHaveLength(2);
    expect(request.splits?.outputs[0]?.amountUnits).toBe('500000');
    expect(request.splits?.outputs[0]?.role).toBe('partner');
    expect(request.splits?.outputs[1]?.role).toBe('treasury');
  });

  it('converts all chain formats to CAIP-2', () => {
    const chains: Array<[string, string]> = [
      ['cardano-mainnet', 'cardano:mainnet'],
      ['cardano-preprod', 'cardano:preprod'],
      ['base-mainnet', 'eip155:8453'],
      ['base-sepolia', 'eip155:84532'],
      ['ethereum-mainnet', 'eip155:1'],
      ['polygon-mainnet', 'eip155:137'],
    ];

    for (const [wire, caip] of chains) {
      const invoice: FluxInvoice = {
        invoiceId: 'test',
        amount: '1000000',
        currency: 'ADA',
        payTo: 'addr...',
        chain: wire,
      };
      const request = parseFluxInvoice(invoice);
      expect(request.chain).toBe(caip);
    }
  });

  it('defaults splitMode to additional if not specified', () => {
    const invoice: FluxInvoice = {
      invoiceId: 'test',
      amount: '2000000',
      currency: 'ADA',
      payTo: 'addr...',
      chain: 'cardano-mainnet',
      splits: [{ to: 'addr_split...', amount: '500000' }],
      // No splitMode specified
    };

    const request = parseFluxInvoice(invoice);
    expect(request.splits?.mode).toBe('additional');
  });

  it('preserves partner attribution', () => {
    const invoice: FluxInvoice = {
      invoiceId: 'test',
      amount: '1000000',
      currency: 'ADA',
      payTo: 'addr...',
      chain: 'cardano-mainnet',
      partner: 'partner_123',
    };

    const request = parseFluxInvoice(invoice);
    expect(request.partner).toBe('partner_123');
  });

  it('preserves decimals when provided', () => {
    const invoice: FluxInvoice = {
      invoiceId: 'test',
      amount: '1000000',
      currency: 'USDC',
      decimals: 6,
      payTo: 'addr...',
      chain: 'cardano-mainnet',
    };

    const request = parseFluxInvoice(invoice);
    expect(request.decimals).toBe(6);
  });

  it('preserves raw invoice for debugging', () => {
    const invoice: FluxInvoice = {
      invoiceId: 'inv_123',
      amount: '2000000',
      currency: 'ADA',
      payTo: 'addr...',
      chain: 'cardano-mainnet',
      metadata: { custom: 'data' },
    };

    const request = parseFluxInvoice(invoice);
    expect(request.raw).toBeDefined();
    expect((request.raw as FluxInvoice).invoiceId).toBe('inv_123');
    expect((request.raw as FluxInvoice).metadata).toEqual({ custom: 'data' });
  });

  it('handles splits with currency override', () => {
    const invoice: FluxInvoice = {
      invoiceId: 'test',
      amount: '2000000',
      currency: 'ADA',
      payTo: 'addr_main...',
      chain: 'cardano-mainnet',
      splitMode: 'additional',
      splits: [
        { to: 'addr_split...', amount: '1000000', currency: 'USDC' },
      ],
    };

    const request = parseFluxInvoice(invoice);
    expect(request.splits?.outputs[0]?.asset).toBe('USDC');
  });

  it('omits role and currency when not in split', () => {
    const invoice: FluxInvoice = {
      invoiceId: 'test',
      amount: '2000000',
      currency: 'ADA',
      payTo: 'addr_main...',
      chain: 'cardano-mainnet',
      splits: [
        { to: 'addr_split...', amount: '500000' }, // No role or currency
      ],
    };

    const request = parseFluxInvoice(invoice);
    expect(request.splits?.outputs[0]?.role).toBeUndefined();
    expect(request.splits?.outputs[0]?.asset).toBeUndefined();
  });

  it('preserves unknown chain format as-is (may already be CAIP-2)', () => {
    const invoice: FluxInvoice = {
      invoiceId: 'test',
      amount: '1000000',
      currency: 'ETH',
      payTo: '0x123...',
      chain: 'eip155:42161', // Already CAIP-2
    };

    const request = parseFluxInvoice(invoice);
    expect(request.chain).toBe('eip155:42161');
  });

  describe('timeout calculation from expiresAt', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('calculates timeout from future expiration', () => {
      // Set current time to 2024-01-01T00:00:00Z
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

      const invoice: FluxInvoice = {
        invoiceId: 'test',
        amount: '1000000',
        currency: 'ADA',
        payTo: 'addr...',
        chain: 'cardano-mainnet',
        expiresAt: '2024-01-01T00:05:00Z', // 5 minutes later
      };

      const request = parseFluxInvoice(invoice);
      expect(request.timeoutSeconds).toBe(300); // 5 minutes = 300 seconds
    });

    it('sets timeout to 0 for expired invoices', () => {
      // Set current time to 2024-01-01T00:10:00Z
      vi.setSystemTime(new Date('2024-01-01T00:10:00Z'));

      const invoice: FluxInvoice = {
        invoiceId: 'test',
        amount: '1000000',
        currency: 'ADA',
        payTo: 'addr...',
        chain: 'cardano-mainnet',
        expiresAt: '2024-01-01T00:05:00Z', // 5 minutes ago
      };

      const request = parseFluxInvoice(invoice);
      expect(request.timeoutSeconds).toBe(0);
    });

    it('omits timeout when expiresAt not provided', () => {
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

      const invoice: FluxInvoice = {
        invoiceId: 'test',
        amount: '1000000',
        currency: 'ADA',
        payTo: 'addr...',
        chain: 'cardano-mainnet',
        // No expiresAt
      };

      const request = parseFluxInvoice(invoice);
      expect(request.timeoutSeconds).toBeUndefined();
    });
  });
});

describe('looksLikeFluxResponse', () => {
  it('returns true for 402 with JSON content type', () => {
    const response = new Response('{}', {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(looksLikeFluxResponse(response)).toBe(true);
  });

  it('returns true for 402 with JSON content type and charset', () => {
    const response = new Response('{}', {
      status: 402,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
    expect(looksLikeFluxResponse(response)).toBe(true);
  });

  it('returns false if PAYMENT-REQUIRED header present (x402)', () => {
    const response = new Response('{}', {
      status: 402,
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-REQUIRED': 'base64...',
      },
    });
    expect(looksLikeFluxResponse(response)).toBe(false);
  });

  it('returns false for non-JSON content', () => {
    const response = new Response('error', {
      status: 402,
      headers: { 'Content-Type': 'text/plain' },
    });
    expect(looksLikeFluxResponse(response)).toBe(false);
  });

  it('returns false when no Content-Type header', () => {
    const response = new Response('error', { status: 402 });
    expect(looksLikeFluxResponse(response)).toBe(false);
  });

  it('returns false for HTML content', () => {
    const response = new Response('<html></html>', {
      status: 402,
      headers: { 'Content-Type': 'text/html' },
    });
    expect(looksLikeFluxResponse(response)).toBe(false);
  });
});

describe('parse402Response', () => {
  it('parses valid Flux 402 response', async () => {
    const invoice = {
      invoiceId: 'inv_123',
      amount: '2000000',
      currency: 'ADA',
      payTo: 'addr_test1...',
      chain: 'cardano-mainnet',
    };

    const response = new Response(JSON.stringify(invoice), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    });

    const request = await parse402Response(response);

    expect(request).not.toBeNull();
    expect(request?.invoiceId).toBe('inv_123');
    expect(request?.amountUnits).toBe('2000000');
    expect(request?.chain).toBe('cardano:mainnet');
  });

  it('returns null for non-JSON content type', async () => {
    const response = new Response('error', {
      status: 402,
      headers: { 'Content-Type': 'text/plain' },
    });

    const result = await parse402Response(response);
    expect(result).toBeNull();
  });

  it('returns null for JSON without invoiceId', async () => {
    const response = new Response(JSON.stringify({ error: 'payment required' }), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await parse402Response(response);
    expect(result).toBeNull();
  });

  it('returns null for missing required fields', async () => {
    const incomplete = {
      invoiceId: 'inv_123',
      // missing amount, currency, payTo, chain
    };

    const response = new Response(JSON.stringify(incomplete), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await parse402Response(response);
    expect(result).toBeNull();
  });

  it('returns null for invalid JSON', async () => {
    const response = new Response('not valid json', {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await parse402Response(response);
    expect(result).toBeNull();
  });

  it('does not consume the response body', async () => {
    const invoice = {
      invoiceId: 'inv_123',
      amount: '2000000',
      currency: 'ADA',
      payTo: 'addr_test1...',
      chain: 'cardano-mainnet',
    };

    const response = new Response(JSON.stringify(invoice), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    });

    await parse402Response(response);

    // Should still be able to read the body
    const body = await response.json();
    expect(body.invoiceId).toBe('inv_123');
  });

  it('returns null for null body', async () => {
    const response = new Response(JSON.stringify(null), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await parse402Response(response);
    expect(result).toBeNull();
  });

  it('returns null for non-string invoiceId', async () => {
    const response = new Response(JSON.stringify({ invoiceId: 123 }), {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    });

    const result = await parse402Response(response);
    expect(result).toBeNull();
  });
});

describe('extractInvoiceIdFromHeaders', () => {
  it('extracts invoice ID from X-Invoice-Id header', () => {
    const response = new Response('', {
      headers: { 'X-Invoice-Id': 'inv_abc123' },
    });

    expect(extractInvoiceIdFromHeaders(response)).toBe('inv_abc123');
  });

  it('returns null when header not present', () => {
    const response = new Response('');
    expect(extractInvoiceIdFromHeaders(response)).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { createFluxTransport, createExtendedFluxTransport } from '../index';
import { FLUX_HEADERS } from '@fluxpointstudios/orynq-sdk-core';

describe('FluxTransport', () => {
  const transport = createFluxTransport();

  describe('is402', () => {
    it('returns true for 402 with JSON body (no x402 header)', () => {
      const response = new Response('{"invoiceId":"test"}', {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      });
      expect(transport.is402(response)).toBe(true);
    });

    it('returns false for 402 with PAYMENT-REQUIRED header (x402)', () => {
      const response = new Response('', {
        status: 402,
        headers: {
          'Content-Type': 'application/json',
          'PAYMENT-REQUIRED': 'base64...',
        },
      });
      expect(transport.is402(response)).toBe(false);
    });

    it('returns false for non-JSON content', () => {
      const response = new Response('error', {
        status: 402,
        headers: { 'Content-Type': 'text/plain' },
      });
      expect(transport.is402(response)).toBe(false);
    });

    it('returns false for non-402 status', () => {
      const response = new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
      expect(transport.is402(response)).toBe(false);
    });

    it('returns false for 403 status', () => {
      const response = new Response('{}', {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
      expect(transport.is402(response)).toBe(false);
    });

    it('returns false for 401 status', () => {
      const response = new Response('{}', {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
      expect(transport.is402(response)).toBe(false);
    });

    it('returns true for 402 with JSON charset content type', () => {
      const response = new Response('{}', {
        status: 402,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      });
      expect(transport.is402(response)).toBe(true);
    });

    it('returns false when no Content-Type header', () => {
      const response = new Response('{}', {
        status: 402,
      });
      expect(transport.is402(response)).toBe(false);
    });
  });

  describe('parse402', () => {
    it('parses JSON body to PaymentRequest', async () => {
      const invoice = {
        invoiceId: 'inv_123',
        amount: '2000000',
        currency: 'ADA',
        payTo: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
        chain: 'cardano-mainnet',
      };

      const response = new Response(JSON.stringify(invoice), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      });

      const request = await transport.parse402(response);

      expect(request.invoiceId).toBe('inv_123');
      expect(request.amountUnits).toBe('2000000');
      expect(request.chain).toBe('cardano:mainnet');
      expect(request.protocol).toBe('flux');
    });

    it('throws on non-JSON content type', async () => {
      const response = new Response('error', {
        status: 402,
        headers: { 'Content-Type': 'text/plain' },
      });

      await expect(transport.parse402(response)).rejects.toThrow();
    });

    it('throws on invalid JSON', async () => {
      const response = new Response('not valid json', {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      });

      await expect(transport.parse402(response)).rejects.toThrow();
    });

    it('throws on missing required fields', async () => {
      const incomplete = {
        invoiceId: 'inv_123',
        // missing amount, currency, payTo, chain
      };

      const response = new Response(JSON.stringify(incomplete), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      });

      await expect(transport.parse402(response)).rejects.toThrow();
    });

    it('parses response with splits', async () => {
      const invoice = {
        invoiceId: 'inv_split',
        amount: '3000000',
        currency: 'ADA',
        payTo: 'addr_primary...',
        chain: 'cardano-mainnet',
        splitMode: 'inclusive',
        splits: [
          { to: 'addr_partner...', amount: '500000', role: 'partner' },
        ],
      };

      const response = new Response(JSON.stringify(invoice), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      });

      const request = await transport.parse402(response);

      expect(request.splits).toBeDefined();
      expect(request.splits?.mode).toBe('inclusive');
      expect(request.splits?.outputs).toHaveLength(1);
    });
  });

  describe('applyPayment', () => {
    it('returns new Request with payment headers', () => {
      const originalReq = new Request('https://api.example.com/v1/infer', {
        method: 'POST',
      });

      const proof = { kind: 'cardano-txhash' as const, txHash: 'abc123def456789012345678901234567890123456789012345678901234567890' };

      const newReq = transport.applyPayment(originalReq, proof, 'inv_123');

      expect(newReq.headers.get(FLUX_HEADERS.INVOICE_ID)).toBe('inv_123');
      expect(newReq.headers.get(FLUX_HEADERS.PAYMENT)).toBe('abc123def456789012345678901234567890123456789012345678901234567890');
    });

    it('preserves existing headers', () => {
      const originalReq = new Request('https://api.example.com/v1/infer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer token',
        },
      });

      const proof = { kind: 'cardano-txhash' as const, txHash: 'abc123' };

      const newReq = transport.applyPayment(originalReq, proof, 'inv_123');

      expect(newReq.headers.get('Content-Type')).toBe('application/json');
      expect(newReq.headers.get('Authorization')).toBe('Bearer token');
    });

    it('preserves request URL and method', () => {
      const originalReq = new Request('https://api.example.com/v1/resource', {
        method: 'PUT',
      });

      const proof = { kind: 'cardano-txhash' as const, txHash: 'abc123' };

      const newReq = transport.applyPayment(originalReq, proof, 'inv_123');

      expect(newReq.url).toBe('https://api.example.com/v1/resource');
      expect(newReq.method).toBe('PUT');
    });

    it('throws for x402-signature proof', () => {
      const originalReq = new Request('https://api.example.com/v1/infer');
      const proof = { kind: 'x402-signature' as const, signature: 'sig123' };

      expect(() => transport.applyPayment(originalReq, proof, 'inv_123')).toThrow();
    });

    it('works with cardano-signed-cbor proof', () => {
      const originalReq = new Request('https://api.example.com/v1/infer');
      const proof = { kind: 'cardano-signed-cbor' as const, cborHex: '84a40081...' };

      const newReq = transport.applyPayment(originalReq, proof, 'inv_123');

      expect(newReq.headers.get(FLUX_HEADERS.PAYMENT)).toBe('84a40081...');
    });

    it('works with evm-txhash proof', () => {
      const originalReq = new Request('https://api.example.com/v1/infer');
      const proof = { kind: 'evm-txhash' as const, txHash: '0xabcdef123456' };

      const newReq = transport.applyPayment(originalReq, proof, 'inv_123');

      expect(newReq.headers.get(FLUX_HEADERS.PAYMENT)).toBe('0xabcdef123456');
    });
  });

  describe('full payment flow', () => {
    it('handles complete Flux payment flow', async () => {
      // Step 1: Initial request returns 402
      const invoice = {
        invoiceId: 'inv_flow_test',
        amount: '5000000',
        currency: 'ADA',
        payTo: 'addr_receiving_wallet...',
        chain: 'cardano-mainnet',
        partner: 'partner_id_123',
      };

      const response402 = new Response(JSON.stringify(invoice), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      });

      // Check if this is a Flux 402
      expect(transport.is402(response402)).toBe(true);

      // Step 2: Parse the payment requirement
      const request = await transport.parse402(response402);
      expect(request.protocol).toBe('flux');
      expect(request.invoiceId).toBe('inv_flow_test');
      expect(request.amountUnits).toBe('5000000');
      expect(request.partner).toBe('partner_id_123');

      // Step 3: Create payment proof and apply to request
      const originalReq = new Request('https://api.example.com/v1/service', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const proof = {
        kind: 'cardano-txhash' as const,
        txHash: 'tx_hash_after_wallet_submission_1234567890abcdef1234567890abcdef12345678',
      };

      const paidReq = transport.applyPayment(originalReq, proof, request.invoiceId!);

      expect(paidReq.headers.get(FLUX_HEADERS.INVOICE_ID)).toBe('inv_flow_test');
      expect(paidReq.headers.get(FLUX_HEADERS.PAYMENT)).toBe('tx_hash_after_wallet_submission_1234567890abcdef1234567890abcdef12345678');
      expect(paidReq.headers.get('Content-Type')).toBe('application/json');
    });
  });
});

describe('ExtendedFluxTransport', () => {
  const transport = createExtendedFluxTransport();

  describe('applyPaymentWithOptions', () => {
    it('includes all optional headers', () => {
      const originalReq = new Request('https://api.example.com/v1/infer');
      const proof = { kind: 'cardano-txhash' as const, txHash: 'abc123' };

      const newReq = transport.applyPaymentWithOptions(originalReq, proof, 'inv_123', {
        partner: 'partner_xyz',
        walletAddress: 'addr_wallet_123',
        chain: 'cardano-mainnet',
        idempotencyKey: 'idem_key_456',
      });

      expect(newReq.headers.get(FLUX_HEADERS.INVOICE_ID)).toBe('inv_123');
      expect(newReq.headers.get(FLUX_HEADERS.PAYMENT)).toBe('abc123');
      expect(newReq.headers.get(FLUX_HEADERS.PARTNER)).toBe('partner_xyz');
      expect(newReq.headers.get(FLUX_HEADERS.WALLET_ADDRESS)).toBe('addr_wallet_123');
      expect(newReq.headers.get(FLUX_HEADERS.CHAIN)).toBe('cardano-mainnet');
      expect(newReq.headers.get(FLUX_HEADERS.IDEMPOTENCY_KEY)).toBe('idem_key_456');
    });

    it('also provides base transport methods', () => {
      // Verify is402 works
      const response = new Response('{}', {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      });
      expect(transport.is402(response)).toBe(true);
    });

    it('provides applyPayment without options', () => {
      const originalReq = new Request('https://api.example.com/v1/infer');
      const proof = { kind: 'cardano-txhash' as const, txHash: 'abc123' };

      const newReq = transport.applyPayment(originalReq, proof, 'inv_123');

      expect(newReq.headers.get(FLUX_HEADERS.INVOICE_ID)).toBe('inv_123');
      expect(newReq.headers.get(FLUX_HEADERS.PAYMENT)).toBe('abc123');
      // Should not have optional headers
      expect(newReq.headers.has(FLUX_HEADERS.PARTNER)).toBe(false);
    });
  });
});

describe('Protocol discrimination', () => {
  const fluxTransport = createFluxTransport();

  it('correctly identifies Flux vs x402 responses', () => {
    // Flux response (JSON without PAYMENT-REQUIRED header)
    const fluxResponse = new Response('{"invoiceId":"test"}', {
      status: 402,
      headers: { 'Content-Type': 'application/json' },
    });

    // x402 response (has PAYMENT-REQUIRED header)
    const x402Response = new Response('', {
      status: 402,
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-REQUIRED': 'eyJ2ZXJzaW9uIjoiMSIsInNjaGVtZSI6ImV4YWN0In0=',
      },
    });

    expect(fluxTransport.is402(fluxResponse)).toBe(true);
    expect(fluxTransport.is402(x402Response)).toBe(false);
  });

  it('rejects non-JSON 402 responses', () => {
    // HTML error page
    const htmlResponse = new Response('<html><body>Payment Required</body></html>', {
      status: 402,
      headers: { 'Content-Type': 'text/html' },
    });

    // Plain text error
    const textResponse = new Response('Payment required', {
      status: 402,
      headers: { 'Content-Type': 'text/plain' },
    });

    expect(fluxTransport.is402(htmlResponse)).toBe(false);
    expect(fluxTransport.is402(textResponse)).toBe(false);
  });
});

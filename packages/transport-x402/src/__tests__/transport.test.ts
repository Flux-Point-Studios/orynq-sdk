import { describe, it, expect } from 'vitest';
import { createX402Transport } from '../index';
import { X402_HEADERS } from '@fluxpointstudios/orynq-sdk-core';

describe('X402Transport', () => {
  const transport = createX402Transport();

  describe('is402', () => {
    it('returns true for 402 with PAYMENT-REQUIRED header', () => {
      const response = new Response('', {
        status: 402,
        headers: { [X402_HEADERS.PAYMENT_REQUIRED]: 'base64...' },
      });
      expect(transport.is402(response)).toBe(true);
    });

    it('returns false for 402 without PAYMENT-REQUIRED header', () => {
      const response = new Response('', { status: 402 });
      expect(transport.is402(response)).toBe(false);
    });

    it('returns false for non-402 status with PAYMENT-REQUIRED header', () => {
      const response = new Response('', {
        status: 200,
        headers: { [X402_HEADERS.PAYMENT_REQUIRED]: 'base64...' },
      });
      expect(transport.is402(response)).toBe(false);
    });

    it('returns false for 403 status', () => {
      const response = new Response('', {
        status: 403,
        headers: { [X402_HEADERS.PAYMENT_REQUIRED]: 'base64...' },
      });
      expect(transport.is402(response)).toBe(false);
    });

    it('returns false for 401 status', () => {
      const response = new Response('', { status: 401 });
      expect(transport.is402(response)).toBe(false);
    });

    it('returns false for 500 status', () => {
      const response = new Response('', { status: 500 });
      expect(transport.is402(response)).toBe(false);
    });
  });

  describe('parse402', () => {
    it('parses valid x402 payment required response', async () => {
      const payload = {
        version: '1',
        scheme: 'exact',
        network: 'eip155:8453',
        maxAmountRequired: '1000000',
        resource: '/api/v1/infer',
        payTo: '0x1234567890123456789012345678901234567890',
        maxTimeoutSeconds: 300,
      };
      const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');

      const response = new Response('', {
        status: 402,
        headers: { [X402_HEADERS.PAYMENT_REQUIRED]: encoded },
      });

      const request = await transport.parse402(response);

      expect(request.protocol).toBe('x402');
      expect(request.chain).toBe('eip155:8453');
      expect(request.amountUnits).toBe('1000000');
      expect(request.payTo).toBe('0x1234567890123456789012345678901234567890');
      expect(request.timeoutSeconds).toBe(300);
    });

    it('throws when PAYMENT-REQUIRED header missing', async () => {
      const response = new Response('', { status: 402 });

      await expect(transport.parse402(response)).rejects.toThrow();
      await expect(transport.parse402(response)).rejects.toThrow(/PAYMENT-REQUIRED/);
    });

    it('throws on invalid header content', async () => {
      const response = new Response('', {
        status: 402,
        headers: { [X402_HEADERS.PAYMENT_REQUIRED]: 'invalid!!!' },
      });

      await expect(transport.parse402(response)).rejects.toThrow();
    });
  });

  describe('applyPayment', () => {
    it('returns new Request with payment headers', () => {
      const originalReq = new Request('https://api.example.com/v1/infer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      const proof = {
        kind: 'x402-signature' as const,
        signature: 'sig123',
      };

      const newReq = transport.applyPayment(originalReq, proof);

      expect(newReq.headers.get(X402_HEADERS.PAYMENT_SIGNATURE)).toBe('sig123');
      expect(newReq.headers.get('Content-Type')).toBe('application/json');
    });

    it('preserves all request properties', () => {
      const originalReq = new Request('https://api.example.com/v1/infer', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer token123',
        },
      });

      const proof = {
        kind: 'x402-signature' as const,
        signature: 'sig123',
      };

      const newReq = transport.applyPayment(originalReq, proof);

      expect(newReq.url).toBe('https://api.example.com/v1/infer');
      expect(newReq.method).toBe('PUT');
      expect(newReq.headers.get('Authorization')).toBe('Bearer token123');
    });

    it('throws for non-x402 proof types', () => {
      const originalReq = new Request('https://api.example.com/v1/infer');

      const proof = {
        kind: 'cardano-txhash' as const,
        txHash: 'abc123',
      };

      expect(() => transport.applyPayment(originalReq, proof)).toThrow();
    });
  });

  describe('parseSettlement', () => {
    it('parses successful settlement from header', () => {
      const payload = {
        success: true,
        txHash: '0xabc123',
        settledAt: '2024-01-15T10:30:00Z',
      };
      const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');

      const response = new Response('', {
        status: 200,
        headers: { [X402_HEADERS.PAYMENT_RESPONSE]: encoded },
      });

      const settlement = transport.parseSettlement(response);

      expect(settlement).not.toBeNull();
      expect(settlement?.success).toBe(true);
      expect(settlement?.txHash).toBe('0xabc123');
      expect(settlement?.settledAt).toBe('2024-01-15T10:30:00Z');
    });

    it('returns null when PAYMENT-RESPONSE header missing', () => {
      const response = new Response('', { status: 200 });

      const settlement = transport.parseSettlement(response);

      expect(settlement).toBeNull();
    });

    it('parses failed settlement', () => {
      const payload = {
        success: false,
        error: 'Invalid signature',
      };
      const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');

      const response = new Response('', {
        status: 200,
        headers: { [X402_HEADERS.PAYMENT_RESPONSE]: encoded },
      });

      const settlement = transport.parseSettlement(response);

      expect(settlement).not.toBeNull();
      expect(settlement?.success).toBe(false);
      expect(settlement?.error).toBe('Invalid signature');
    });
  });

  describe('full payment flow', () => {
    it('handles complete x402 payment flow', async () => {
      // Step 1: Initial request returns 402
      const paymentPayload = {
        version: '1',
        scheme: 'exact',
        network: 'eip155:8453',
        maxAmountRequired: '1000000',
        resource: '/api/v1/infer',
        payTo: '0x1234567890123456789012345678901234567890',
      };
      const paymentEncoded = Buffer.from(JSON.stringify(paymentPayload)).toString('base64');

      const response402 = new Response('', {
        status: 402,
        headers: { [X402_HEADERS.PAYMENT_REQUIRED]: paymentEncoded },
      });

      // Check if this is an x402 402
      expect(transport.is402(response402)).toBe(true);

      // Step 2: Parse the payment requirement
      const request = await transport.parse402(response402);
      expect(request.protocol).toBe('x402');
      expect(request.amountUnits).toBe('1000000');

      // Step 3: Create payment proof and apply to request
      const originalReq = new Request('https://api.example.com/v1/infer', {
        method: 'POST',
      });

      const proof = {
        kind: 'x402-signature' as const,
        signature: 'signature-after-wallet-signing',
      };

      const paidReq = transport.applyPayment(originalReq, proof);
      expect(paidReq.headers.get(X402_HEADERS.PAYMENT_SIGNATURE)).toBe('signature-after-wallet-signing');

      // Step 4: Parse settlement from successful response
      const settlementPayload = {
        success: true,
        txHash: '0xfinal-tx-hash',
        settledAt: '2024-01-15T12:00:00Z',
      };
      const settlementEncoded = Buffer.from(JSON.stringify(settlementPayload)).toString('base64');

      const responseSuccess = new Response('{"result": "success"}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          [X402_HEADERS.PAYMENT_RESPONSE]: settlementEncoded,
        },
      });

      const settlement = transport.parseSettlement(responseSuccess);
      expect(settlement?.success).toBe(true);
      expect(settlement?.txHash).toBe('0xfinal-tx-hash');
    });
  });
});

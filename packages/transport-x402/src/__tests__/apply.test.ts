import { describe, it, expect } from 'vitest';
import {
  createPaymentSignatureHeader,
  createPaymentSignatureHeaderEncoded,
  applyPaymentHeaders,
  createPaymentHeaders,
  applyPaymentToRequest,
} from '../apply';
import { X402_HEADERS, type PaymentProof, type X402SignatureProof } from '@fluxpointstudios/poi-sdk-core';

describe('createPaymentSignatureHeader', () => {
  it('extracts signature from x402-signature proof', () => {
    const proof: PaymentProof = {
      kind: 'x402-signature',
      signature: 'base64-signature-data',
    };

    const header = createPaymentSignatureHeader(proof);
    expect(header).toBe('base64-signature-data');
  });

  it('throws for cardano-txhash proof', () => {
    const proof: PaymentProof = {
      kind: 'cardano-txhash',
      txHash: 'abc123def456789012345678901234567890123456789012345678901234567890',
    };

    expect(() => createPaymentSignatureHeader(proof)).toThrow();
    expect(() => createPaymentSignatureHeader(proof)).toThrow(/x402/);
  });

  it('throws for cardano-signed-cbor proof', () => {
    const proof: PaymentProof = {
      kind: 'cardano-signed-cbor',
      cborHex: 'a1234567890...',
    };

    expect(() => createPaymentSignatureHeader(proof)).toThrow();
    expect(() => createPaymentSignatureHeader(proof)).toThrow(/x402/);
  });

  it('throws for evm-txhash proof', () => {
    const proof: PaymentProof = {
      kind: 'evm-txhash',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    };

    expect(() => createPaymentSignatureHeader(proof)).toThrow();
    expect(() => createPaymentSignatureHeader(proof)).toThrow(/x402/);
  });

  it('handles signatures with special characters', () => {
    const proof: PaymentProof = {
      kind: 'x402-signature',
      signature: '0xabc123def456+/=',
    };

    const header = createPaymentSignatureHeader(proof);
    expect(header).toBe('0xabc123def456+/=');
  });
});

describe('createPaymentSignatureHeaderEncoded', () => {
  it('encodes signature to base64 JSON', () => {
    const proof: X402SignatureProof = {
      kind: 'x402-signature',
      signature: 'sig123',
    };

    const header = createPaymentSignatureHeaderEncoded(proof);

    // Decode and verify
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf-8'));
    expect(decoded.signature).toBe('sig123');
  });

  it('includes payload when present', () => {
    const proof: X402SignatureProof = {
      kind: 'x402-signature',
      signature: 'sig123',
      payload: '{"amount":"1000000"}',
    };

    const header = createPaymentSignatureHeaderEncoded(proof);

    // Decode and verify
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf-8'));
    expect(decoded.signature).toBe('sig123');
    expect(decoded.payload).toBe('{"amount":"1000000"}');
  });

  it('omits payload field when not present', () => {
    const proof: X402SignatureProof = {
      kind: 'x402-signature',
      signature: 'sig123',
    };

    const header = createPaymentSignatureHeaderEncoded(proof);

    // Decode and verify
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf-8'));
    expect(decoded.signature).toBe('sig123');
    expect(decoded.payload).toBeUndefined();
    expect(Object.keys(decoded)).toEqual(['signature']);
  });
});

describe('applyPaymentHeaders', () => {
  it('adds PAYMENT-SIGNATURE header', () => {
    const headers = new Headers();
    const proof: PaymentProof = {
      kind: 'x402-signature',
      signature: 'sig123',
    };

    applyPaymentHeaders(headers, proof);

    expect(headers.get(X402_HEADERS.PAYMENT_SIGNATURE)).toBe('sig123');
  });

  it('preserves existing headers', () => {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const proof: PaymentProof = {
      kind: 'x402-signature',
      signature: 'sig123',
    };

    applyPaymentHeaders(headers, proof);

    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get(X402_HEADERS.PAYMENT_SIGNATURE)).toBe('sig123');
  });

  it('returns the same Headers object for chaining', () => {
    const headers = new Headers();
    const proof: PaymentProof = {
      kind: 'x402-signature',
      signature: 'sig123',
    };

    const result = applyPaymentHeaders(headers, proof);

    expect(result).toBe(headers);
  });

  it('overwrites existing payment signature header', () => {
    const headers = new Headers({
      [X402_HEADERS.PAYMENT_SIGNATURE]: 'old-signature',
    });
    const proof: PaymentProof = {
      kind: 'x402-signature',
      signature: 'new-signature',
    };

    applyPaymentHeaders(headers, proof);

    expect(headers.get(X402_HEADERS.PAYMENT_SIGNATURE)).toBe('new-signature');
  });

  it('throws for non-x402 proof types', () => {
    const headers = new Headers();
    const proof: PaymentProof = {
      kind: 'cardano-txhash',
      txHash: 'abc123',
    };

    expect(() => applyPaymentHeaders(headers, proof)).toThrow();
  });
});

describe('createPaymentHeaders', () => {
  it('creates new Headers with payment signature', () => {
    const proof: PaymentProof = {
      kind: 'x402-signature',
      signature: 'sig123',
    };

    const headers = createPaymentHeaders(undefined, proof);

    expect(headers.get(X402_HEADERS.PAYMENT_SIGNATURE)).toBe('sig123');
  });

  it('copies existing Headers and adds payment signature', () => {
    const existing = new Headers({ 'Authorization': 'Bearer token123' });
    const proof: PaymentProof = {
      kind: 'x402-signature',
      signature: 'sig123',
    };

    const headers = createPaymentHeaders(existing, proof);

    expect(headers.get('Authorization')).toBe('Bearer token123');
    expect(headers.get(X402_HEADERS.PAYMENT_SIGNATURE)).toBe('sig123');
    // Verify original is not modified
    expect(existing.has(X402_HEADERS.PAYMENT_SIGNATURE)).toBe(false);
  });

  it('accepts HeadersInit as input', () => {
    const existing: HeadersInit = { 'X-Custom': 'value' };
    const proof: PaymentProof = {
      kind: 'x402-signature',
      signature: 'sig123',
    };

    const headers = createPaymentHeaders(existing, proof);

    expect(headers.get('X-Custom')).toBe('value');
    expect(headers.get(X402_HEADERS.PAYMENT_SIGNATURE)).toBe('sig123');
  });
});

describe('applyPaymentToRequest', () => {
  it('returns new Request with payment headers', () => {
    const originalReq = new Request('https://api.example.com/v1/infer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const proof: PaymentProof = {
      kind: 'x402-signature',
      signature: 'sig123',
    };

    const newReq = applyPaymentToRequest(originalReq, proof);

    expect(newReq.headers.get(X402_HEADERS.PAYMENT_SIGNATURE)).toBe('sig123');
    expect(newReq.headers.get('Content-Type')).toBe('application/json');
  });

  it('preserves request properties', () => {
    const originalReq = new Request('https://api.example.com/v1/infer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const proof: PaymentProof = {
      kind: 'x402-signature',
      signature: 'sig123',
    };

    const newReq = applyPaymentToRequest(originalReq, proof);

    expect(newReq.url).toBe('https://api.example.com/v1/infer');
    expect(newReq.method).toBe('POST');
  });

  it('does not modify original request', () => {
    const originalReq = new Request('https://api.example.com/v1/infer', {
      method: 'POST',
    });

    const proof: PaymentProof = {
      kind: 'x402-signature',
      signature: 'sig123',
    };

    applyPaymentToRequest(originalReq, proof);

    expect(originalReq.headers.has(X402_HEADERS.PAYMENT_SIGNATURE)).toBe(false);
  });

  it('throws for non-x402 proof types', () => {
    const originalReq = new Request('https://api.example.com/v1/infer');
    const proof: PaymentProof = {
      kind: 'evm-txhash',
      txHash: '0x123...',
    };

    expect(() => applyPaymentToRequest(originalReq, proof)).toThrow();
  });
});

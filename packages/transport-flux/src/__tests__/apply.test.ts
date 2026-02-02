import { describe, it, expect } from 'vitest';
import {
  createPaymentHeader,
  applyPaymentHeaders,
  applyPaymentToRequest,
  hasPaymentHeaders,
  extractPaymentFromRequest,
  stripPaymentHeaders,
} from '../apply';
import { FLUX_HEADERS, type PaymentProof } from '@fluxpointstudios/orynq-sdk-core';

describe('createPaymentHeader', () => {
  it('extracts txHash from cardano-txhash proof', () => {
    const proof: PaymentProof = {
      kind: 'cardano-txhash',
      txHash: 'abc123def456789012345678901234567890123456789012345678901234567890',
    };
    expect(createPaymentHeader(proof)).toBe('abc123def456789012345678901234567890123456789012345678901234567890');
  });

  it('extracts cborHex from cardano-signed-cbor proof', () => {
    const proof: PaymentProof = {
      kind: 'cardano-signed-cbor',
      cborHex: '84a400818258203b40265111d8bb3c3c608d95b3a0bf83461ace32d79336579a1939b3aad1c0b700018182583900cb9358529df4729c3246a2a033cb9821abbfd16de4888005904ab6',
    };
    expect(createPaymentHeader(proof)).toBe('84a400818258203b40265111d8bb3c3c608d95b3a0bf83461ace32d79336579a1939b3aad1c0b700018182583900cb9358529df4729c3246a2a033cb9821abbfd16de4888005904ab6');
  });

  it('extracts txHash from evm-txhash proof', () => {
    const proof: PaymentProof = {
      kind: 'evm-txhash',
      txHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    };
    expect(createPaymentHeader(proof)).toBe('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
  });

  it('throws for x402-signature proof', () => {
    const proof: PaymentProof = {
      kind: 'x402-signature',
      signature: 'sig...',
    };
    expect(() => createPaymentHeader(proof)).toThrow();
    expect(() => createPaymentHeader(proof)).toThrow(/Flux/);
    expect(() => createPaymentHeader(proof)).toThrow(/x402-signature/);
  });
});

describe('applyPaymentHeaders', () => {
  it('sets required headers', () => {
    const headers = new Headers();
    const proof: PaymentProof = {
      kind: 'cardano-txhash',
      txHash: 'abc123def456789012345678901234567890123456789012345678901234567890',
    };

    applyPaymentHeaders(headers, proof, 'inv_123');

    expect(headers.get(FLUX_HEADERS.INVOICE_ID)).toBe('inv_123');
    expect(headers.get(FLUX_HEADERS.PAYMENT)).toBe('abc123def456789012345678901234567890123456789012345678901234567890');
  });

  it('sets optional headers when provided', () => {
    const headers = new Headers();
    const proof: PaymentProof = {
      kind: 'cardano-txhash',
      txHash: 'abc123def456789012345678901234567890123456789012345678901234567890',
    };

    applyPaymentHeaders(headers, proof, 'inv_123', {
      partner: 'my_partner',
      walletAddress: 'addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp',
      chain: 'cardano-mainnet',
      idempotencyKey: 'key_123',
    });

    expect(headers.get(FLUX_HEADERS.PARTNER)).toBe('my_partner');
    expect(headers.get(FLUX_HEADERS.WALLET_ADDRESS)).toBe('addr_test1qz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3jcu5d8ps7zex2k2xt3uqxgjqnnj83ws8lhrn648jjxtwq2ytjqp');
    expect(headers.get(FLUX_HEADERS.CHAIN)).toBe('cardano-mainnet');
    expect(headers.get(FLUX_HEADERS.IDEMPOTENCY_KEY)).toBe('key_123');
  });

  it('returns the modified Headers object for chaining', () => {
    const headers = new Headers();
    const proof: PaymentProof = { kind: 'cardano-txhash', txHash: 'abc123' };

    const result = applyPaymentHeaders(headers, proof, 'inv_123');

    expect(result).toBe(headers);
  });

  it('preserves existing headers', () => {
    const headers = new Headers({
      'Content-Type': 'application/json',
      'Authorization': 'Bearer token123',
    });
    const proof: PaymentProof = { kind: 'cardano-txhash', txHash: 'abc123' };

    applyPaymentHeaders(headers, proof, 'inv_123');

    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Authorization')).toBe('Bearer token123');
    expect(headers.get(FLUX_HEADERS.INVOICE_ID)).toBe('inv_123');
  });

  it('does not set optional headers when not provided', () => {
    const headers = new Headers();
    const proof: PaymentProof = { kind: 'cardano-txhash', txHash: 'abc123' };

    applyPaymentHeaders(headers, proof, 'inv_123');

    expect(headers.has(FLUX_HEADERS.PARTNER)).toBe(false);
    expect(headers.has(FLUX_HEADERS.WALLET_ADDRESS)).toBe(false);
    expect(headers.has(FLUX_HEADERS.CHAIN)).toBe(false);
    expect(headers.has(FLUX_HEADERS.IDEMPOTENCY_KEY)).toBe(false);
  });

  it('does not set optional headers when options object is empty', () => {
    const headers = new Headers();
    const proof: PaymentProof = { kind: 'cardano-txhash', txHash: 'abc123' };

    applyPaymentHeaders(headers, proof, 'inv_123', {});

    expect(headers.has(FLUX_HEADERS.PARTNER)).toBe(false);
    expect(headers.has(FLUX_HEADERS.WALLET_ADDRESS)).toBe(false);
  });

  it('handles evm-txhash proof', () => {
    const headers = new Headers();
    const proof: PaymentProof = {
      kind: 'evm-txhash',
      txHash: '0xabcdef123456',
    };

    applyPaymentHeaders(headers, proof, 'inv_evm');

    expect(headers.get(FLUX_HEADERS.INVOICE_ID)).toBe('inv_evm');
    expect(headers.get(FLUX_HEADERS.PAYMENT)).toBe('0xabcdef123456');
  });
});

describe('applyPaymentToRequest', () => {
  it('creates new Request with payment headers', () => {
    const originalReq = new Request('https://api.example.com/v1/infer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const proof: PaymentProof = { kind: 'cardano-txhash', txHash: 'abc123' };

    const newReq = applyPaymentToRequest(originalReq, proof, 'inv_123');

    expect(newReq.headers.get(FLUX_HEADERS.INVOICE_ID)).toBe('inv_123');
    expect(newReq.headers.get(FLUX_HEADERS.PAYMENT)).toBe('abc123');
    expect(newReq.headers.get('Content-Type')).toBe('application/json');
  });

  it('preserves request properties', () => {
    const originalReq = new Request('https://api.example.com/v1/resource', {
      method: 'PUT',
    });

    const proof: PaymentProof = { kind: 'cardano-txhash', txHash: 'abc123' };

    const newReq = applyPaymentToRequest(originalReq, proof, 'inv_123');

    expect(newReq.url).toBe('https://api.example.com/v1/resource');
    expect(newReq.method).toBe('PUT');
  });

  it('does not modify original request', () => {
    const originalReq = new Request('https://api.example.com/v1/infer');

    const proof: PaymentProof = { kind: 'cardano-txhash', txHash: 'abc123' };

    applyPaymentToRequest(originalReq, proof, 'inv_123');

    expect(originalReq.headers.has(FLUX_HEADERS.INVOICE_ID)).toBe(false);
    expect(originalReq.headers.has(FLUX_HEADERS.PAYMENT)).toBe(false);
  });

  it('includes optional headers when provided', () => {
    const originalReq = new Request('https://api.example.com/v1/infer');

    const proof: PaymentProof = { kind: 'cardano-txhash', txHash: 'abc123' };

    const newReq = applyPaymentToRequest(originalReq, proof, 'inv_123', {
      partner: 'partner_abc',
      walletAddress: 'addr_wallet',
    });

    expect(newReq.headers.get(FLUX_HEADERS.PARTNER)).toBe('partner_abc');
    expect(newReq.headers.get(FLUX_HEADERS.WALLET_ADDRESS)).toBe('addr_wallet');
  });
});

describe('hasPaymentHeaders', () => {
  it('returns true when both required headers present', () => {
    const request = new Request('https://api.example.com', {
      headers: {
        [FLUX_HEADERS.INVOICE_ID]: 'inv_123',
        [FLUX_HEADERS.PAYMENT]: 'abc123',
      },
    });
    expect(hasPaymentHeaders(request)).toBe(true);
  });

  it('returns false when invoice ID missing', () => {
    const request = new Request('https://api.example.com', {
      headers: {
        [FLUX_HEADERS.PAYMENT]: 'abc123',
      },
    });
    expect(hasPaymentHeaders(request)).toBe(false);
  });

  it('returns false when payment missing', () => {
    const request = new Request('https://api.example.com', {
      headers: {
        [FLUX_HEADERS.INVOICE_ID]: 'inv_123',
      },
    });
    expect(hasPaymentHeaders(request)).toBe(false);
  });

  it('returns false when no payment headers present', () => {
    const request = new Request('https://api.example.com');
    expect(hasPaymentHeaders(request)).toBe(false);
  });
});

describe('extractPaymentFromRequest', () => {
  it('extracts payment info when present', () => {
    const request = new Request('https://api.example.com', {
      headers: {
        [FLUX_HEADERS.INVOICE_ID]: 'inv_123',
        [FLUX_HEADERS.PAYMENT]: 'txhash_abc123',
      },
    });

    const result = extractPaymentFromRequest(request);

    expect(result).not.toBeNull();
    expect(result?.invoiceId).toBe('inv_123');
    expect(result?.payment).toBe('txhash_abc123');
  });

  it('returns null when invoice ID missing', () => {
    const request = new Request('https://api.example.com', {
      headers: {
        [FLUX_HEADERS.PAYMENT]: 'abc123',
      },
    });

    expect(extractPaymentFromRequest(request)).toBeNull();
  });

  it('returns null when payment missing', () => {
    const request = new Request('https://api.example.com', {
      headers: {
        [FLUX_HEADERS.INVOICE_ID]: 'inv_123',
      },
    });

    expect(extractPaymentFromRequest(request)).toBeNull();
  });

  it('returns null when no headers present', () => {
    const request = new Request('https://api.example.com');
    expect(extractPaymentFromRequest(request)).toBeNull();
  });
});

describe('stripPaymentHeaders', () => {
  it('removes all Flux payment headers', () => {
    const request = new Request('https://api.example.com', {
      headers: {
        [FLUX_HEADERS.INVOICE_ID]: 'inv_123',
        [FLUX_HEADERS.PAYMENT]: 'abc123',
        [FLUX_HEADERS.PARTNER]: 'partner_xyz',
        [FLUX_HEADERS.WALLET_ADDRESS]: 'addr_wallet',
        [FLUX_HEADERS.CHAIN]: 'cardano-mainnet',
        [FLUX_HEADERS.IDEMPOTENCY_KEY]: 'idem_key',
        'Content-Type': 'application/json',
      },
    });

    const strippedReq = stripPaymentHeaders(request);

    expect(strippedReq.headers.has(FLUX_HEADERS.INVOICE_ID)).toBe(false);
    expect(strippedReq.headers.has(FLUX_HEADERS.PAYMENT)).toBe(false);
    expect(strippedReq.headers.has(FLUX_HEADERS.PARTNER)).toBe(false);
    expect(strippedReq.headers.has(FLUX_HEADERS.WALLET_ADDRESS)).toBe(false);
    expect(strippedReq.headers.has(FLUX_HEADERS.CHAIN)).toBe(false);
    expect(strippedReq.headers.has(FLUX_HEADERS.IDEMPOTENCY_KEY)).toBe(false);
    // Other headers should be preserved
    expect(strippedReq.headers.get('Content-Type')).toBe('application/json');
  });

  it('preserves non-payment headers', () => {
    const request = new Request('https://api.example.com', {
      headers: {
        'Authorization': 'Bearer token123',
        'Content-Type': 'application/json',
        'X-Custom-Header': 'custom-value',
        [FLUX_HEADERS.INVOICE_ID]: 'inv_123',
      },
    });

    const strippedReq = stripPaymentHeaders(request);

    expect(strippedReq.headers.get('Authorization')).toBe('Bearer token123');
    expect(strippedReq.headers.get('Content-Type')).toBe('application/json');
    expect(strippedReq.headers.get('X-Custom-Header')).toBe('custom-value');
  });

  it('does not modify original request', () => {
    const request = new Request('https://api.example.com', {
      headers: {
        [FLUX_HEADERS.INVOICE_ID]: 'inv_123',
        [FLUX_HEADERS.PAYMENT]: 'abc123',
      },
    });

    stripPaymentHeaders(request);

    expect(request.headers.has(FLUX_HEADERS.INVOICE_ID)).toBe(true);
    expect(request.headers.has(FLUX_HEADERS.PAYMENT)).toBe(true);
  });

  it('preserves request URL and method', () => {
    const request = new Request('https://api.example.com/resource', {
      method: 'DELETE',
      headers: {
        [FLUX_HEADERS.INVOICE_ID]: 'inv_123',
      },
    });

    const strippedReq = stripPaymentHeaders(request);

    expect(strippedReq.url).toBe('https://api.example.com/resource');
    expect(strippedReq.method).toBe('DELETE');
  });

  it('works on request without payment headers', () => {
    const request = new Request('https://api.example.com', {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const strippedReq = stripPaymentHeaders(request);

    expect(strippedReq.headers.get('Content-Type')).toBe('application/json');
    expect(strippedReq.headers.has(FLUX_HEADERS.INVOICE_ID)).toBe(false);
  });
});

/**
 * @summary Tests for type validation and type guards.
 */

import { describe, it, expect } from 'vitest';
import type {
  PaymentRequest,
  PaymentProof,
  ChainId,
  SplitOutput,
  PaymentSplits,
  PaymentAttempt,
  PaymentStatus,
} from '../types/payment.js';
import {
  isCardanoTxHashProof,
  isCardanoSignedCborProof,
  isEvmTxHashProof,
  isX402SignatureProof,
  isCardanoProof,
  isEvmProof,
} from '../types/payment.js';

describe('PaymentRequest type', () => {
  it('accepts valid flux payment request', () => {
    const request: PaymentRequest = {
      protocol: 'flux',
      invoiceId: 'inv_123',
      chain: 'cardano:mainnet',
      asset: 'ADA',
      amountUnits: '2000000', // 2 ADA as STRING
      payTo: 'addr_test1qz...',
    };

    expect(request.amountUnits).toBe('2000000');
    expect(typeof request.amountUnits).toBe('string');
    expect(request.protocol).toBe('flux');
  });

  it('accepts valid x402 payment request', () => {
    const request: PaymentRequest = {
      protocol: 'x402',
      chain: 'eip155:8453',
      asset: 'ETH',
      amountUnits: '1000000000000000000', // 1 ETH in wei
      payTo: '0x1234...',
    };

    expect(request.protocol).toBe('x402');
    expect(request.chain).toBe('eip155:8453');
  });

  it('accepts optional fields', () => {
    const request: PaymentRequest = {
      protocol: 'flux',
      chain: 'cardano:mainnet',
      asset: 'ADA',
      amountUnits: '1000000',
      payTo: 'addr_test1...',
      version: '1.0',
      invoiceId: 'inv_123',
      decimals: 6,
      timeoutSeconds: 300,
      partner: 'partner_123',
      raw: { originalHeader: 'value' },
    };

    expect(request.version).toBe('1.0');
    expect(request.decimals).toBe(6);
    expect(request.timeoutSeconds).toBe(300);
  });

  it('accepts splits with inclusive mode', () => {
    const request: PaymentRequest = {
      protocol: 'flux',
      chain: 'cardano:mainnet',
      asset: 'ADA',
      amountUnits: '3000000',
      payTo: 'addr_primary...',
      splits: {
        mode: 'inclusive',
        outputs: [
          { to: 'addr_partner...', amountUnits: '500000', role: 'partner' },
          { to: 'addr_treasury...', amountUnits: '500000', role: 'treasury' },
        ],
      },
    };

    expect(request.splits?.mode).toBe('inclusive');
    expect(request.splits?.outputs).toHaveLength(2);
    expect(request.splits?.outputs[0]?.role).toBe('partner');
    expect(request.splits?.outputs[0]?.amountUnits).toBe('500000');
  });

  it('accepts splits with additional mode', () => {
    const request: PaymentRequest = {
      protocol: 'flux',
      chain: 'cardano:mainnet',
      asset: 'ADA',
      amountUnits: '2000000',
      payTo: 'addr_primary...',
      splits: {
        mode: 'additional',
        outputs: [
          { to: 'addr_fee...', amountUnits: '100000' },
        ],
      },
    };

    expect(request.splits?.mode).toBe('additional');
  });

  it('accepts facilitator configuration', () => {
    const request: PaymentRequest = {
      protocol: 'flux',
      chain: 'cardano:mainnet',
      asset: 'ADA',
      amountUnits: '1000000',
      payTo: 'addr_test1...',
      facilitator: {
        provider: 'flux',
        url: 'https://facilitator.example.com',
      },
    };

    expect(request.facilitator?.provider).toBe('flux');
    expect(request.facilitator?.url).toBe('https://facilitator.example.com');
  });
});

describe('SplitOutput type', () => {
  it('accepts minimal split output', () => {
    const output: SplitOutput = {
      to: 'addr_recipient...',
      amountUnits: '500000',
    };

    expect(output.to).toBeDefined();
    expect(output.amountUnits).toBe('500000');
    expect(output.role).toBeUndefined();
    expect(output.asset).toBeUndefined();
  });

  it('accepts split output with all fields', () => {
    const output: SplitOutput = {
      role: 'platform',
      to: 'addr_platform...',
      asset: 'AGENT',
      amountUnits: '100',
    };

    expect(output.role).toBe('platform');
    expect(output.asset).toBe('AGENT');
  });
});

describe('PaymentSplits type', () => {
  it('accepts inclusive splits', () => {
    const splits: PaymentSplits = {
      mode: 'inclusive',
      outputs: [
        { to: 'addr1', amountUnits: '100' },
        { to: 'addr2', amountUnits: '200' },
      ],
    };

    expect(splits.mode).toBe('inclusive');
    expect(splits.outputs).toHaveLength(2);
  });

  it('accepts additional splits', () => {
    const splits: PaymentSplits = {
      mode: 'additional',
      outputs: [
        { to: 'addr1', amountUnits: '50', role: 'fee' },
      ],
    };

    expect(splits.mode).toBe('additional');
  });
});

describe('PaymentProof type', () => {
  it('accepts cardano-txhash proof', () => {
    const proof: PaymentProof = {
      kind: 'cardano-txhash',
      txHash: 'abc123def456789...',
    };
    expect(proof.kind).toBe('cardano-txhash');
    expect((proof as { txHash: string }).txHash).toBe('abc123def456789...');
  });

  it('accepts cardano-signed-cbor proof', () => {
    const proof: PaymentProof = {
      kind: 'cardano-signed-cbor',
      cborHex: 'a1b2c3d4e5f6...',
    };
    expect(proof.kind).toBe('cardano-signed-cbor');
    expect((proof as { cborHex: string }).cborHex).toBe('a1b2c3d4e5f6...');
  });

  it('accepts evm-txhash proof', () => {
    const proof: PaymentProof = {
      kind: 'evm-txhash',
      txHash: '0x1234567890abcdef...',
    };
    expect(proof.kind).toBe('evm-txhash');
    expect((proof as { txHash: string }).txHash).toBe('0x1234567890abcdef...');
  });

  it('accepts x402-signature proof', () => {
    const proof: PaymentProof = {
      kind: 'x402-signature',
      signature: 'base64signature...',
      payload: '{"amount":"1000000"}',
    };
    expect(proof.kind).toBe('x402-signature');
    expect((proof as { signature: string }).signature).toBe('base64signature...');
    expect((proof as { payload?: string }).payload).toBe('{"amount":"1000000"}');
  });

  it('accepts x402-signature proof without payload', () => {
    const proof: PaymentProof = {
      kind: 'x402-signature',
      signature: 'base64signature...',
    };
    expect(proof.kind).toBe('x402-signature');
  });
});

describe('PaymentProof type guards', () => {
  describe('isCardanoTxHashProof', () => {
    it('returns true for cardano-txhash proofs', () => {
      const proof: PaymentProof = { kind: 'cardano-txhash', txHash: 'abc' };
      expect(isCardanoTxHashProof(proof)).toBe(true);
    });

    it('returns false for other proofs', () => {
      const proof: PaymentProof = { kind: 'evm-txhash', txHash: '0xabc' };
      expect(isCardanoTxHashProof(proof)).toBe(false);
    });
  });

  describe('isCardanoSignedCborProof', () => {
    it('returns true for cardano-signed-cbor proofs', () => {
      const proof: PaymentProof = { kind: 'cardano-signed-cbor', cborHex: 'abc' };
      expect(isCardanoSignedCborProof(proof)).toBe(true);
    });

    it('returns false for other proofs', () => {
      const proof: PaymentProof = { kind: 'cardano-txhash', txHash: 'abc' };
      expect(isCardanoSignedCborProof(proof)).toBe(false);
    });
  });

  describe('isEvmTxHashProof', () => {
    it('returns true for evm-txhash proofs', () => {
      const proof: PaymentProof = { kind: 'evm-txhash', txHash: '0xabc' };
      expect(isEvmTxHashProof(proof)).toBe(true);
    });

    it('returns false for other proofs', () => {
      const proof: PaymentProof = { kind: 'cardano-txhash', txHash: 'abc' };
      expect(isEvmTxHashProof(proof)).toBe(false);
    });
  });

  describe('isX402SignatureProof', () => {
    it('returns true for x402-signature proofs', () => {
      const proof: PaymentProof = { kind: 'x402-signature', signature: 'sig' };
      expect(isX402SignatureProof(proof)).toBe(true);
    });

    it('returns false for other proofs', () => {
      const proof: PaymentProof = { kind: 'evm-txhash', txHash: '0xabc' };
      expect(isX402SignatureProof(proof)).toBe(false);
    });
  });

  describe('isCardanoProof', () => {
    it('returns true for cardano-txhash proofs', () => {
      const proof: PaymentProof = { kind: 'cardano-txhash', txHash: 'abc' };
      expect(isCardanoProof(proof)).toBe(true);
    });

    it('returns true for cardano-signed-cbor proofs', () => {
      const proof: PaymentProof = { kind: 'cardano-signed-cbor', cborHex: 'abc' };
      expect(isCardanoProof(proof)).toBe(true);
    });

    it('returns false for EVM proofs', () => {
      const proof: PaymentProof = { kind: 'evm-txhash', txHash: '0xabc' };
      expect(isCardanoProof(proof)).toBe(false);
    });
  });

  describe('isEvmProof', () => {
    it('returns true for evm-txhash proofs', () => {
      const proof: PaymentProof = { kind: 'evm-txhash', txHash: '0xabc' };
      expect(isEvmProof(proof)).toBe(true);
    });

    it('returns true for x402-signature proofs', () => {
      const proof: PaymentProof = { kind: 'x402-signature', signature: 'sig' };
      expect(isEvmProof(proof)).toBe(true);
    });

    it('returns false for Cardano proofs', () => {
      const proof: PaymentProof = { kind: 'cardano-txhash', txHash: 'abc' };
      expect(isEvmProof(proof)).toBe(false);
    });
  });
});

describe('PaymentAttempt type', () => {
  it('accepts valid payment attempt', () => {
    const request: PaymentRequest = {
      protocol: 'flux',
      chain: 'cardano:mainnet',
      asset: 'ADA',
      amountUnits: '1000000',
      payTo: 'addr_test1...',
    };

    const proof: PaymentProof = {
      kind: 'cardano-txhash',
      txHash: 'abc123...',
    };

    const attempt: PaymentAttempt = {
      request,
      proof,
      idempotencyKey: 'idem_abc123def456',
    };

    expect(attempt.request).toBe(request);
    expect(attempt.proof).toBe(proof);
    expect(attempt.idempotencyKey).toBe('idem_abc123def456');
  });
});

describe('PaymentStatus type', () => {
  it('accepts pending status', () => {
    const status: PaymentStatus = {
      invoiceId: 'inv_123',
      status: 'pending',
    };
    expect(status.status).toBe('pending');
  });

  it('accepts submitted status with txHash', () => {
    const status: PaymentStatus = {
      invoiceId: 'inv_123',
      status: 'submitted',
      txHash: 'abc123...',
    };
    expect(status.status).toBe('submitted');
    expect(status.txHash).toBe('abc123...');
  });

  it('accepts confirmed status with settledAt', () => {
    const status: PaymentStatus = {
      invoiceId: 'inv_123',
      status: 'confirmed',
      txHash: 'abc123...',
      settledAt: '2024-01-15T10:30:00Z',
    };
    expect(status.status).toBe('confirmed');
    expect(status.settledAt).toBe('2024-01-15T10:30:00Z');
  });

  it('accepts consumed status', () => {
    const status: PaymentStatus = {
      invoiceId: 'inv_123',
      status: 'consumed',
    };
    expect(status.status).toBe('consumed');
  });

  it('accepts expired status', () => {
    const status: PaymentStatus = {
      invoiceId: 'inv_123',
      status: 'expired',
    };
    expect(status.status).toBe('expired');
  });

  it('accepts failed status with error', () => {
    const status: PaymentStatus = {
      invoiceId: 'inv_123',
      status: 'failed',
      error: 'Insufficient funds',
    };
    expect(status.status).toBe('failed');
    expect(status.error).toBe('Insufficient funds');
  });
});

describe('ChainId type', () => {
  it('accepts CAIP-2 EVM chain IDs', () => {
    const baseMainnet: ChainId = 'eip155:8453';
    const ethMainnet: ChainId = 'eip155:1';
    const polygon: ChainId = 'eip155:137';

    expect(baseMainnet).toBe('eip155:8453');
    expect(ethMainnet).toBe('eip155:1');
    expect(polygon).toBe('eip155:137');
  });

  it('accepts CAIP-2 Cardano chain IDs', () => {
    const mainnet: ChainId = 'cardano:mainnet';
    const preprod: ChainId = 'cardano:preprod';
    const preview: ChainId = 'cardano:preview';

    expect(mainnet).toBe('cardano:mainnet');
    expect(preprod).toBe('cardano:preprod');
    expect(preview).toBe('cardano:preview');
  });
});

describe('amount string precision', () => {
  it('preserves large ADA amounts as strings', () => {
    const request: PaymentRequest = {
      protocol: 'flux',
      chain: 'cardano:mainnet',
      asset: 'ADA',
      amountUnits: '99999999999999999999', // Very large amount
      payTo: 'addr_test1...',
    };

    // String comparison to verify no precision loss
    expect(request.amountUnits).toBe('99999999999999999999');
    expect(request.amountUnits.length).toBe(20);
  });

  it('preserves large ETH amounts as strings', () => {
    const request: PaymentRequest = {
      protocol: 'x402',
      chain: 'eip155:1',
      asset: 'ETH',
      amountUnits: '1000000000000000000000000', // 1 million ETH in wei
      payTo: '0x...',
    };

    expect(request.amountUnits).toBe('1000000000000000000000000');
  });

  it('handles precise decimal conversions as strings', () => {
    // 1.5 ADA = 1500000 lovelace
    const request: PaymentRequest = {
      protocol: 'flux',
      chain: 'cardano:mainnet',
      asset: 'ADA',
      amountUnits: '1500000',
      decimals: 6,
      payTo: 'addr_test1...',
    };

    expect(request.amountUnits).toBe('1500000');
    expect(request.decimals).toBe(6);
  });
});

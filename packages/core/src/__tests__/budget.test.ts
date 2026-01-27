/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/core/src/__tests__/budget.test.ts
 * @summary Tests for budget store implementations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryBudgetStore, InMemoryInvoiceCache } from '../types/budget.js';
import type { PaymentProof } from '../types/payment.js';

describe('InMemoryBudgetStore', () => {
  let store: InMemoryBudgetStore;

  beforeEach(() => {
    store = new InMemoryBudgetStore();
  });

  describe('getSpent', () => {
    it('returns 0n for untracked chain/asset', async () => {
      const spent = await store.getSpent('cardano:mainnet', 'ADA', '2024-01-01');
      expect(spent).toBe(0n);
    });

    it('returns 0n for untracked day', async () => {
      await store.recordSpend('cardano:mainnet', 'ADA', 1000000n);
      const spent = await store.getSpent('cardano:mainnet', 'ADA', '2023-01-01'); // Different day
      expect(spent).toBe(0n);
    });
  });

  describe('recordSpend', () => {
    it('records and retrieves spend', async () => {
      await store.recordSpend('cardano:mainnet', 'ADA', 1000000n);
      const today = new Date().toISOString().slice(0, 10);
      const spent = await store.getSpent('cardano:mainnet', 'ADA', today);
      expect(spent).toBe(1000000n);
    });

    it('accumulates multiple spends', async () => {
      await store.recordSpend('cardano:mainnet', 'ADA', 1000000n);
      await store.recordSpend('cardano:mainnet', 'ADA', 2000000n);
      await store.recordSpend('cardano:mainnet', 'ADA', 3000000n);
      const today = new Date().toISOString().slice(0, 10);
      const spent = await store.getSpent('cardano:mainnet', 'ADA', today);
      expect(spent).toBe(6000000n);
    });

    it('handles large amounts without precision loss', async () => {
      const largeAmount = 999999999999999999n; // Larger than Number.MAX_SAFE_INTEGER
      await store.recordSpend('cardano:mainnet', 'ADA', largeAmount);
      const today = new Date().toISOString().slice(0, 10);
      const spent = await store.getSpent('cardano:mainnet', 'ADA', today);
      expect(spent).toBe(largeAmount);
    });
  });

  describe('asset and chain separation', () => {
    it('tracks different assets separately', async () => {
      await store.recordSpend('cardano:mainnet', 'ADA', 1000000n);
      await store.recordSpend('cardano:mainnet', 'AGENT', 500n);
      const today = new Date().toISOString().slice(0, 10);

      expect(await store.getSpent('cardano:mainnet', 'ADA', today)).toBe(1000000n);
      expect(await store.getSpent('cardano:mainnet', 'AGENT', today)).toBe(500n);
    });

    it('tracks different chains separately', async () => {
      await store.recordSpend('cardano:mainnet', 'ADA', 1000000n);
      await store.recordSpend('cardano:preprod', 'ADA', 2000000n);
      const today = new Date().toISOString().slice(0, 10);

      expect(await store.getSpent('cardano:mainnet', 'ADA', today)).toBe(1000000n);
      expect(await store.getSpent('cardano:preprod', 'ADA', today)).toBe(2000000n);
    });

    it('tracks EVM chains separately', async () => {
      await store.recordSpend('eip155:8453', 'ETH', 1000000000000000000n);
      await store.recordSpend('eip155:1', 'ETH', 2000000000000000000n);
      const today = new Date().toISOString().slice(0, 10);

      expect(await store.getSpent('eip155:8453', 'ETH', today)).toBe(1000000000000000000n);
      expect(await store.getSpent('eip155:1', 'ETH', today)).toBe(2000000000000000000n);
    });
  });

  describe('reset', () => {
    it('resets spend for specific chain/asset', async () => {
      await store.recordSpend('cardano:mainnet', 'ADA', 1000000n);
      await store.reset('cardano:mainnet', 'ADA');
      const today = new Date().toISOString().slice(0, 10);
      const spent = await store.getSpent('cardano:mainnet', 'ADA', today);
      expect(spent).toBe(0n);
    });

    it('does not affect other chain/asset combinations', async () => {
      await store.recordSpend('cardano:mainnet', 'ADA', 1000000n);
      await store.recordSpend('cardano:mainnet', 'AGENT', 500n);
      await store.recordSpend('cardano:preprod', 'ADA', 2000000n);

      await store.reset('cardano:mainnet', 'ADA');

      const today = new Date().toISOString().slice(0, 10);
      expect(await store.getSpent('cardano:mainnet', 'ADA', today)).toBe(0n);
      expect(await store.getSpent('cardano:mainnet', 'AGENT', today)).toBe(500n);
      expect(await store.getSpent('cardano:preprod', 'ADA', today)).toBe(2000000n);
    });
  });

  describe('resetAll', () => {
    it('resets all tracked spends', async () => {
      await store.recordSpend('cardano:mainnet', 'ADA', 1000000n);
      await store.recordSpend('cardano:mainnet', 'AGENT', 500n);
      await store.recordSpend('eip155:8453', 'ETH', 1000000000000000000n);

      await store.resetAll();

      const today = new Date().toISOString().slice(0, 10);
      expect(await store.getSpent('cardano:mainnet', 'ADA', today)).toBe(0n);
      expect(await store.getSpent('cardano:mainnet', 'AGENT', today)).toBe(0n);
      expect(await store.getSpent('eip155:8453', 'ETH', today)).toBe(0n);
    });
  });
});

describe('InMemoryInvoiceCache', () => {
  let cache: InMemoryInvoiceCache;

  const mockProof: PaymentProof = {
    kind: 'cardano-txhash',
    txHash: 'abc123def456789',
  };

  const mockEvmProof: PaymentProof = {
    kind: 'evm-txhash',
    txHash: '0x1234567890abcdef',
  };

  beforeEach(() => {
    cache = new InMemoryInvoiceCache();
  });

  describe('getPaid / setPaid', () => {
    it('returns null for unknown invoice', async () => {
      const proof = await cache.getPaid('unknown_invoice');
      expect(proof).toBeNull();
    });

    it('stores and retrieves payment proof by invoice ID', async () => {
      await cache.setPaid('inv_123', mockProof);
      const proof = await cache.getPaid('inv_123');
      expect(proof).toBe(mockProof);
    });

    it('overwrites existing proof', async () => {
      await cache.setPaid('inv_123', mockProof);
      await cache.setPaid('inv_123', mockEvmProof);
      const proof = await cache.getPaid('inv_123');
      expect(proof).toBe(mockEvmProof);
    });

    it('stores multiple invoices independently', async () => {
      await cache.setPaid('inv_1', mockProof);
      await cache.setPaid('inv_2', mockEvmProof);

      expect(await cache.getPaid('inv_1')).toBe(mockProof);
      expect(await cache.getPaid('inv_2')).toBe(mockEvmProof);
    });
  });

  describe('getByIdempotencyKey / setByIdempotencyKey', () => {
    it('returns null for unknown key', async () => {
      const proof = await cache.getByIdempotencyKey('unknown_key');
      expect(proof).toBeNull();
    });

    it('stores and retrieves payment proof by idempotency key', async () => {
      await cache.setByIdempotencyKey('idem_abc123', mockProof);
      const proof = await cache.getByIdempotencyKey('idem_abc123');
      expect(proof).toBe(mockProof);
    });

    it('idempotency keys and invoice IDs are independent', async () => {
      await cache.setPaid('inv_123', mockProof);
      await cache.setByIdempotencyKey('idem_456', mockEvmProof);

      expect(await cache.getPaid('inv_123')).toBe(mockProof);
      expect(await cache.getByIdempotencyKey('idem_456')).toBe(mockEvmProof);
      expect(await cache.getPaid('idem_456')).toBeNull();
      expect(await cache.getByIdempotencyKey('inv_123')).toBeNull();
    });
  });

  describe('delete', () => {
    it('deletes invoice from cache', async () => {
      await cache.setPaid('inv_123', mockProof);
      await cache.delete('inv_123');
      const proof = await cache.getPaid('inv_123');
      expect(proof).toBeNull();
    });

    it('does not affect other invoices', async () => {
      await cache.setPaid('inv_1', mockProof);
      await cache.setPaid('inv_2', mockEvmProof);
      await cache.delete('inv_1');

      expect(await cache.getPaid('inv_1')).toBeNull();
      expect(await cache.getPaid('inv_2')).toBe(mockEvmProof);
    });

    it('handles deleting non-existent invoice', async () => {
      // Should not throw
      await cache.delete('non_existent');
    });
  });

  describe('clear', () => {
    it('clears all invoices', async () => {
      await cache.setPaid('inv_1', mockProof);
      await cache.setPaid('inv_2', mockEvmProof);
      await cache.setByIdempotencyKey('idem_1', mockProof);

      await cache.clear();

      expect(await cache.getPaid('inv_1')).toBeNull();
      expect(await cache.getPaid('inv_2')).toBeNull();
      expect(await cache.getByIdempotencyKey('idem_1')).toBeNull();
    });
  });

  describe('proof types', () => {
    it('handles cardano-txhash proof', async () => {
      const proof: PaymentProof = {
        kind: 'cardano-txhash',
        txHash: 'abc123',
      };
      await cache.setPaid('inv_1', proof);
      const retrieved = await cache.getPaid('inv_1');
      expect(retrieved?.kind).toBe('cardano-txhash');
    });

    it('handles cardano-signed-cbor proof', async () => {
      const proof: PaymentProof = {
        kind: 'cardano-signed-cbor',
        cborHex: 'a1b2c3d4',
      };
      await cache.setPaid('inv_2', proof);
      const retrieved = await cache.getPaid('inv_2');
      expect(retrieved?.kind).toBe('cardano-signed-cbor');
    });

    it('handles evm-txhash proof', async () => {
      const proof: PaymentProof = {
        kind: 'evm-txhash',
        txHash: '0x123abc',
      };
      await cache.setPaid('inv_3', proof);
      const retrieved = await cache.getPaid('inv_3');
      expect(retrieved?.kind).toBe('evm-txhash');
    });

    it('handles x402-signature proof', async () => {
      const proof: PaymentProof = {
        kind: 'x402-signature',
        signature: 'sig_abc123',
        payload: '{"amount":"1000"}',
      };
      await cache.setPaid('inv_4', proof);
      const retrieved = await cache.getPaid('inv_4');
      expect(retrieved?.kind).toBe('x402-signature');
    });
  });
});

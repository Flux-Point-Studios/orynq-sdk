/**
 * @summary Tests for custom payment error classes.
 */

import { describe, it, expect } from 'vitest';
import {
  PaymentError,
  PaymentRequiredError,
  BudgetExceededError,
  InsufficientBalanceError,
  InvoiceExpiredError,
  DuplicatePaymentError,
  PaymentFailedError,
  PaymentTimeoutError,
  ChainNotSupportedError,
  AssetNotSupportedError,
  isPaymentError,
  isPaymentRequiredError,
  isBudgetExceededError,
  isInsufficientBalanceError,
  isRetryableError,
} from '../types/errors.js';
import type { PaymentRequest, PaymentProof } from '../types/payment.js';

describe('PaymentRequiredError', () => {
  const mockRequest: PaymentRequest = {
    protocol: 'flux',
    chain: 'cardano:mainnet',
    asset: 'ADA',
    amountUnits: '1000000',
    payTo: 'addr_test1qz...',
  };

  it('includes request and protocol', () => {
    const error = new PaymentRequiredError(mockRequest);

    expect(error.request).toBe(mockRequest);
    expect(error.protocol).toBe('flux');
    expect(error.code).toBe('PAYMENT_REQUIRED');
  });

  it('has default message', () => {
    const error = new PaymentRequiredError(mockRequest);
    expect(error.message).toContain('Payment required');
  });

  it('accepts custom message', () => {
    const error = new PaymentRequiredError(mockRequest, 'Custom payment message');
    expect(error.message).toBe('Custom payment message');
  });

  it('serializes to JSON correctly', () => {
    const error = new PaymentRequiredError(mockRequest);
    const json = error.toJSON();

    expect(json.name).toBe('PaymentRequiredError');
    expect(json.code).toBe('PAYMENT_REQUIRED');
    expect(json.request).toBe(mockRequest);
    expect(json.protocol).toBe('flux');
  });

  it('extends Error', () => {
    const error = new PaymentRequiredError(mockRequest);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(PaymentError);
  });

  it('handles x402 protocol', () => {
    const x402Request: PaymentRequest = {
      ...mockRequest,
      protocol: 'x402',
    };
    const error = new PaymentRequiredError(x402Request);
    expect(error.protocol).toBe('x402');
  });
});

describe('BudgetExceededError', () => {
  it('includes budget info in message', () => {
    const error = new BudgetExceededError('5000000', '10000000', '7000000');
    expect(error.message).toContain('5000000'); // requested
    expect(error.message).toContain('3000000'); // remaining (10000000 - 7000000)
    expect(error.message).toContain('10000000'); // limit
    expect(error.code).toBe('BUDGET_EXCEEDED');
  });

  it('stores all budget values', () => {
    const error = new BudgetExceededError('5000000', '10000000', '7000000', 'daily');
    expect(error.requestedAmount).toBe('5000000');
    expect(error.budgetLimit).toBe('10000000');
    expect(error.spentAmount).toBe('7000000');
    expect(error.period).toBe('daily');
  });

  it('defaults to daily period', () => {
    const error = new BudgetExceededError('1000000', '10000000', '0');
    expect(error.period).toBe('daily');
  });

  it('serializes to JSON correctly', () => {
    const error = new BudgetExceededError('5000000', '10000000', '7000000', 'per-request');
    const json = error.toJSON();

    expect(json.requestedAmount).toBe('5000000');
    expect(json.budgetLimit).toBe('10000000');
    expect(json.spentAmount).toBe('7000000');
    expect(json.period).toBe('per-request');
  });
});

describe('InsufficientBalanceError', () => {
  it('includes balance info', () => {
    const error = new InsufficientBalanceError('10000000', '5000000', 'ADA', 'cardano:mainnet');
    expect(error.message).toContain('10000000'); // required
    expect(error.message).toContain('5000000'); // available
    expect(error.message).toContain('5000000'); // deficit
    expect(error.message).toContain('ADA');
    expect(error.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('stores all balance values', () => {
    const error = new InsufficientBalanceError('10000000', '5000000', 'ADA', 'cardano:mainnet');
    expect(error.requiredAmount).toBe('10000000');
    expect(error.availableBalance).toBe('5000000');
    expect(error.asset).toBe('ADA');
    expect(error.chain).toBe('cardano:mainnet');
  });

  it('serializes to JSON correctly', () => {
    const error = new InsufficientBalanceError('10000000', '5000000', 'ADA', 'cardano:mainnet');
    const json = error.toJSON();

    expect(json.requiredAmount).toBe('10000000');
    expect(json.availableBalance).toBe('5000000');
    expect(json.asset).toBe('ADA');
    expect(json.chain).toBe('cardano:mainnet');
  });
});

describe('InvoiceExpiredError', () => {
  it('includes invoice ID', () => {
    const error = new InvoiceExpiredError('inv_123');
    expect(error.message).toContain('inv_123');
    expect(error.invoiceId).toBe('inv_123');
    expect(error.code).toBe('INVOICE_EXPIRED');
  });

  it('includes expiration time when provided', () => {
    const error = new InvoiceExpiredError('inv_123', '2024-01-15T10:00:00Z');
    expect(error.message).toContain('2024-01-15T10:00:00Z');
    expect(error.expiredAt).toBe('2024-01-15T10:00:00Z');
  });

  it('handles missing expiration time', () => {
    const error = new InvoiceExpiredError('inv_123');
    expect(error.expiredAt).toBeUndefined();
  });

  it('serializes to JSON correctly', () => {
    const error = new InvoiceExpiredError('inv_123', '2024-01-15T10:00:00Z');
    const json = error.toJSON();

    expect(json.invoiceId).toBe('inv_123');
    expect(json.expiredAt).toBe('2024-01-15T10:00:00Z');
  });
});

describe('DuplicatePaymentError', () => {
  const mockProof: PaymentProof = {
    kind: 'cardano-txhash',
    txHash: 'abc123def456...',
  };

  it('includes invoice ID', () => {
    const error = new DuplicatePaymentError('inv_123');
    expect(error.message).toContain('inv_123');
    expect(error.message).toContain('already been paid');
    expect(error.invoiceId).toBe('inv_123');
    expect(error.code).toBe('DUPLICATE_PAYMENT');
  });

  it('includes existing proof when provided', () => {
    const error = new DuplicatePaymentError('inv_123', mockProof);
    expect(error.existingProof).toBe(mockProof);
  });

  it('handles missing proof', () => {
    const error = new DuplicatePaymentError('inv_123');
    expect(error.existingProof).toBeUndefined();
  });

  it('serializes to JSON correctly', () => {
    const error = new DuplicatePaymentError('inv_123', mockProof);
    const json = error.toJSON();

    expect(json.invoiceId).toBe('inv_123');
    expect(json.existingProof).toBe(mockProof);
  });
});

describe('PaymentFailedError', () => {
  const mockRequest: PaymentRequest = {
    protocol: 'flux',
    chain: 'cardano:mainnet',
    asset: 'ADA',
    amountUnits: '1000000',
    payTo: 'addr_test1qz...',
  };

  it('includes request and reason', () => {
    const error = new PaymentFailedError(mockRequest, 'Transaction rejected');
    expect(error.message).toBe('Transaction rejected');
    expect(error.request).toBe(mockRequest);
    expect(error.reason).toBe('Transaction rejected');
    expect(error.code).toBe('PAYMENT_FAILED');
  });

  it('handles missing reason', () => {
    const error = new PaymentFailedError(mockRequest);
    expect(error.message).toBe('Payment transaction failed');
    expect(error.reason).toBeUndefined();
  });

  it('includes txHash when provided', () => {
    const error = new PaymentFailedError(mockRequest, 'Failed', 'tx_hash_123');
    expect(error.txHash).toBe('tx_hash_123');
  });

  it('includes cause when provided', () => {
    const cause = new Error('Network error');
    const error = new PaymentFailedError(mockRequest, 'Network failure', undefined, cause);
    expect(error.cause).toBe(cause);
  });

  it('serializes to JSON correctly', () => {
    const error = new PaymentFailedError(mockRequest, 'Failed', 'tx_123');
    const json = error.toJSON();

    expect(json.request).toBe(mockRequest);
    expect(json.reason).toBe('Failed');
    expect(json.txHash).toBe('tx_123');
  });
});

describe('PaymentTimeoutError', () => {
  const mockRequest: PaymentRequest = {
    protocol: 'flux',
    chain: 'cardano:mainnet',
    asset: 'ADA',
    amountUnits: '1000000',
    payTo: 'addr_test1qz...',
  };

  it('includes timeout details', () => {
    const error = new PaymentTimeoutError(mockRequest, 'submit', 30000);
    expect(error.message).toContain('submit');
    expect(error.message).toContain('30000ms');
    expect(error.request).toBe(mockRequest);
    expect(error.operation).toBe('submit');
    expect(error.timeoutMs).toBe(30000);
    expect(error.code).toBe('PAYMENT_TIMEOUT');
  });

  it('handles different operations', () => {
    const signError = new PaymentTimeoutError(mockRequest, 'sign', 5000);
    expect(signError.operation).toBe('sign');

    const confirmError = new PaymentTimeoutError(mockRequest, 'confirm', 60000);
    expect(confirmError.operation).toBe('confirm');
  });

  it('serializes to JSON correctly', () => {
    const error = new PaymentTimeoutError(mockRequest, 'submit', 30000);
    const json = error.toJSON();

    expect(json.request).toBe(mockRequest);
    expect(json.operation).toBe('submit');
    expect(json.timeoutMs).toBe(30000);
  });
});

describe('ChainNotSupportedError', () => {
  it('includes chain ID', () => {
    const error = new ChainNotSupportedError('solana:mainnet');
    expect(error.message).toContain('solana:mainnet');
    expect(error.chain).toBe('solana:mainnet');
    expect(error.code).toBe('CHAIN_NOT_SUPPORTED');
  });

  it('includes supported chains when provided', () => {
    const error = new ChainNotSupportedError('solana:mainnet', ['cardano:mainnet', 'eip155:8453']);
    expect(error.message).toContain('cardano:mainnet');
    expect(error.message).toContain('eip155:8453');
    expect(error.supportedChains).toEqual(['cardano:mainnet', 'eip155:8453']);
  });

  it('serializes to JSON correctly', () => {
    const error = new ChainNotSupportedError('solana:mainnet', ['cardano:mainnet']);
    const json = error.toJSON();

    expect(json.chain).toBe('solana:mainnet');
    expect(json.supportedChains).toEqual(['cardano:mainnet']);
  });
});

describe('AssetNotSupportedError', () => {
  it('includes asset and chain', () => {
    const error = new AssetNotSupportedError('UNKNOWN', 'cardano:mainnet');
    expect(error.message).toContain('UNKNOWN');
    expect(error.message).toContain('cardano:mainnet');
    expect(error.asset).toBe('UNKNOWN');
    expect(error.chain).toBe('cardano:mainnet');
    expect(error.code).toBe('ASSET_NOT_SUPPORTED');
  });

  it('serializes to JSON correctly', () => {
    const error = new AssetNotSupportedError('UNKNOWN', 'cardano:mainnet');
    const json = error.toJSON();

    expect(json.asset).toBe('UNKNOWN');
    expect(json.chain).toBe('cardano:mainnet');
  });
});

describe('type guards', () => {
  describe('isPaymentError', () => {
    it('returns true for PaymentError instances', () => {
      const error = new BudgetExceededError('1000', '100', '90');
      expect(isPaymentError(error)).toBe(true);
    });

    it('returns false for regular errors', () => {
      expect(isPaymentError(new Error('test'))).toBe(false);
    });

    it('returns false for non-errors', () => {
      expect(isPaymentError('not an error')).toBe(false);
      expect(isPaymentError(null)).toBe(false);
      expect(isPaymentError(undefined)).toBe(false);
    });
  });

  describe('isPaymentRequiredError', () => {
    const mockRequest: PaymentRequest = {
      protocol: 'flux',
      chain: 'cardano:mainnet',
      asset: 'ADA',
      amountUnits: '1000000',
      payTo: 'addr_test1qz...',
    };

    it('returns true for PaymentRequiredError', () => {
      const error = new PaymentRequiredError(mockRequest);
      expect(isPaymentRequiredError(error)).toBe(true);
    });

    it('returns false for other payment errors', () => {
      const error = new BudgetExceededError('1000', '100', '90');
      expect(isPaymentRequiredError(error)).toBe(false);
    });
  });

  describe('isBudgetExceededError', () => {
    it('returns true for BudgetExceededError', () => {
      const error = new BudgetExceededError('1000', '100', '90');
      expect(isBudgetExceededError(error)).toBe(true);
    });

    it('returns false for other payment errors', () => {
      const error = new InsufficientBalanceError('1000', '100', 'ADA', 'cardano:mainnet');
      expect(isBudgetExceededError(error)).toBe(false);
    });
  });

  describe('isInsufficientBalanceError', () => {
    it('returns true for InsufficientBalanceError', () => {
      const error = new InsufficientBalanceError('1000', '100', 'ADA', 'cardano:mainnet');
      expect(isInsufficientBalanceError(error)).toBe(true);
    });

    it('returns false for other payment errors', () => {
      const error = new BudgetExceededError('1000', '100', '90');
      expect(isInsufficientBalanceError(error)).toBe(false);
    });
  });

  describe('isRetryableError', () => {
    const mockRequest: PaymentRequest = {
      protocol: 'flux',
      chain: 'cardano:mainnet',
      asset: 'ADA',
      amountUnits: '1000000',
      payTo: 'addr_test1qz...',
    };

    it('returns true for timeout errors', () => {
      const error = new PaymentTimeoutError(mockRequest, 'submit', 30000);
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns true for network failures', () => {
      const error = new PaymentFailedError(mockRequest, 'network connection failed');
      expect(isRetryableError(error)).toBe(true);
    });

    it('returns false for budget exceeded', () => {
      const error = new BudgetExceededError('1000', '100', '90');
      expect(isRetryableError(error)).toBe(false);
    });

    it('returns false for non-payment errors', () => {
      expect(isRetryableError(new Error('test'))).toBe(false);
    });
  });
});

describe('error inheritance', () => {
  it('all payment errors extend PaymentError', () => {
    const mockRequest: PaymentRequest = {
      protocol: 'flux',
      chain: 'cardano:mainnet',
      asset: 'ADA',
      amountUnits: '1000000',
      payTo: 'addr_test1qz...',
    };

    const errors = [
      new PaymentRequiredError(mockRequest),
      new BudgetExceededError('1000', '100', '90'),
      new InsufficientBalanceError('1000', '100', 'ADA', 'cardano:mainnet'),
      new InvoiceExpiredError('inv_123'),
      new DuplicatePaymentError('inv_123'),
      new PaymentFailedError(mockRequest),
      new PaymentTimeoutError(mockRequest, 'submit', 30000),
      new ChainNotSupportedError('solana:mainnet'),
      new AssetNotSupportedError('UNKNOWN', 'cardano:mainnet'),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(PaymentError);
      expect(error).toBeInstanceOf(Error);
      expect(typeof error.code).toBe('string');
      expect(typeof error.toJSON).toBe('function');
    }
  });
});

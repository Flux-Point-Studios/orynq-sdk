/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/core/src/__tests__/chains.test.ts
 * @summary Tests for CAIP-2 chain identifier helpers and mappings.
 */

import { describe, it, expect } from 'vitest';
import {
  CHAINS,
  CHAIN_NAMES,
  EVM_CHAIN_IDS,
  CARDANO_NETWORKS,
  toCAIP2,
  fromCAIP2,
  tryFromCAIP2,
  normalizeChainId,
  isCAIP2,
  isKnownChain,
  isEvmChain,
  isCardanoChain,
  getChainFamily,
  getEvmChainId,
  evmChainId,
  getCardanoNetwork,
  cardanoChainId,
  isCardanoTestnet,
  getChainInfo,
  getAllChains,
  getChainsByFamily,
} from '../chains.js';

describe('CHAINS constant', () => {
  it('maps base-mainnet to eip155:8453', () => {
    expect(CHAINS['base-mainnet']).toBe('eip155:8453');
  });

  it('maps base-sepolia to eip155:84532', () => {
    expect(CHAINS['base-sepolia']).toBe('eip155:84532');
  });

  it('maps cardano-mainnet to cardano:mainnet', () => {
    expect(CHAINS['cardano-mainnet']).toBe('cardano:mainnet');
  });

  it('maps cardano-preprod to cardano:preprod', () => {
    expect(CHAINS['cardano-preprod']).toBe('cardano:preprod');
  });

  it('maps cardano-preview to cardano:preview', () => {
    expect(CHAINS['cardano-preview']).toBe('cardano:preview');
  });

  it('maps ethereum-mainnet to eip155:1', () => {
    expect(CHAINS['ethereum-mainnet']).toBe('eip155:1');
  });

  it('maps polygon-mainnet to eip155:137', () => {
    expect(CHAINS['polygon-mainnet']).toBe('eip155:137');
  });

  it('maps arbitrum-mainnet to eip155:42161', () => {
    expect(CHAINS['arbitrum-mainnet']).toBe('eip155:42161');
  });

  it('maps optimism-mainnet to eip155:10', () => {
    expect(CHAINS['optimism-mainnet']).toBe('eip155:10');
  });
});

describe('CHAIN_NAMES reverse mapping', () => {
  it('maps eip155:8453 to base-mainnet', () => {
    expect(CHAIN_NAMES['eip155:8453']).toBe('base-mainnet');
  });

  it('maps cardano:mainnet to cardano-mainnet', () => {
    expect(CHAIN_NAMES['cardano:mainnet']).toBe('cardano-mainnet');
  });

  it('has entry for every CHAINS value', () => {
    for (const [name, caip2] of Object.entries(CHAINS)) {
      expect(CHAIN_NAMES[caip2]).toBe(name);
    }
  });
});

describe('EVM_CHAIN_IDS', () => {
  it('contains correct chain IDs', () => {
    expect(EVM_CHAIN_IDS['eip155:1']).toBe(1);
    expect(EVM_CHAIN_IDS['eip155:8453']).toBe(8453);
    expect(EVM_CHAIN_IDS['eip155:137']).toBe(137);
    expect(EVM_CHAIN_IDS['eip155:42161']).toBe(42161);
    expect(EVM_CHAIN_IDS['eip155:10']).toBe(10);
  });
});

describe('CARDANO_NETWORKS', () => {
  it('contains mainnet, preprod, and preview', () => {
    expect(CARDANO_NETWORKS).toContain('mainnet');
    expect(CARDANO_NETWORKS).toContain('preprod');
    expect(CARDANO_NETWORKS).toContain('preview');
    expect(CARDANO_NETWORKS).toHaveLength(3);
  });
});

describe('toCAIP2', () => {
  it('converts friendly chain names to CAIP-2', () => {
    expect(toCAIP2('cardano-mainnet')).toBe('cardano:mainnet');
    expect(toCAIP2('base-mainnet')).toBe('eip155:8453');
    expect(toCAIP2('ethereum-mainnet')).toBe('eip155:1');
  });

  it('returns input unchanged if already CAIP-2 format', () => {
    expect(toCAIP2('cardano:mainnet')).toBe('cardano:mainnet');
    expect(toCAIP2('eip155:8453')).toBe('eip155:8453');
    expect(toCAIP2('eip155:1')).toBe('eip155:1');
  });

  it('throws for unknown chain names', () => {
    expect(() => toCAIP2('unknown-chain')).toThrow(/unknown chain/i);
  });
});

describe('fromCAIP2', () => {
  it('converts CAIP-2 to friendly chain names', () => {
    expect(fromCAIP2('cardano:mainnet')).toBe('cardano-mainnet');
    expect(fromCAIP2('eip155:8453')).toBe('base-mainnet');
    expect(fromCAIP2('eip155:1')).toBe('ethereum-mainnet');
  });

  it('throws for unknown CAIP-2 IDs', () => {
    expect(() => fromCAIP2('eip155:99999')).toThrow(/unknown caip-2/i);
  });
});

describe('tryFromCAIP2', () => {
  it('returns friendly name for known chains', () => {
    expect(tryFromCAIP2('cardano:mainnet')).toBe('cardano-mainnet');
    expect(tryFromCAIP2('eip155:8453')).toBe('base-mainnet');
  });

  it('returns undefined for unknown chains', () => {
    expect(tryFromCAIP2('eip155:99999')).toBeUndefined();
    expect(tryFromCAIP2('unknown:chain')).toBeUndefined();
  });
});

describe('normalizeChainId', () => {
  it('returns CAIP-2 input unchanged', () => {
    expect(normalizeChainId('eip155:8453')).toBe('eip155:8453');
    expect(normalizeChainId('cardano:mainnet')).toBe('cardano:mainnet');
  });

  it('converts friendly names to CAIP-2', () => {
    expect(normalizeChainId('base-mainnet')).toBe('eip155:8453');
    expect(normalizeChainId('cardano-mainnet')).toBe('cardano:mainnet');
  });

  it('converts numeric EVM chain IDs', () => {
    expect(normalizeChainId('8453')).toBe('eip155:8453');
    expect(normalizeChainId('1')).toBe('eip155:1');
  });

  it('throws for invalid input', () => {
    expect(() => normalizeChainId('invalid')).toThrow();
    expect(() => normalizeChainId('')).toThrow();
  });
});

describe('isCAIP2', () => {
  it('returns true for valid CAIP-2 format', () => {
    expect(isCAIP2('eip155:8453')).toBe(true);
    expect(isCAIP2('cardano:mainnet')).toBe(true);
    expect(isCAIP2('eip155:1')).toBe(true);
    expect(isCAIP2('bip122:000000000019d6689c085ae165831e93')).toBe(true);
  });

  it('returns false for friendly chain names', () => {
    expect(isCAIP2('base-mainnet')).toBe(false);
    expect(isCAIP2('cardano-mainnet')).toBe(false);
  });

  it('returns false for invalid formats', () => {
    expect(isCAIP2('invalid')).toBe(false);
    expect(isCAIP2('eip155:')).toBe(false);
    expect(isCAIP2(':8453')).toBe(false);
    expect(isCAIP2('')).toBe(false);
  });
});

describe('isKnownChain', () => {
  it('returns true for known friendly names', () => {
    expect(isKnownChain('base-mainnet')).toBe(true);
    expect(isKnownChain('cardano-mainnet')).toBe(true);
  });

  it('returns true for known CAIP-2 IDs', () => {
    expect(isKnownChain('eip155:8453')).toBe(true);
    expect(isKnownChain('cardano:mainnet')).toBe(true);
  });

  it('returns false for unknown chains', () => {
    expect(isKnownChain('unknown-chain')).toBe(false);
    expect(isKnownChain('eip155:99999')).toBe(false);
  });
});

describe('isEvmChain', () => {
  it('returns true for EVM chains', () => {
    expect(isEvmChain('eip155:8453')).toBe(true);
    expect(isEvmChain('eip155:1')).toBe(true);
    expect(isEvmChain('eip155:137')).toBe(true);
  });

  it('returns false for non-EVM chains', () => {
    expect(isEvmChain('cardano:mainnet')).toBe(false);
    expect(isEvmChain('cardano:preprod')).toBe(false);
  });
});

describe('isCardanoChain', () => {
  it('returns true for Cardano chains', () => {
    expect(isCardanoChain('cardano:mainnet')).toBe(true);
    expect(isCardanoChain('cardano:preprod')).toBe(true);
    expect(isCardanoChain('cardano:preview')).toBe(true);
  });

  it('returns false for non-Cardano chains', () => {
    expect(isCardanoChain('eip155:8453')).toBe(false);
    expect(isCardanoChain('eip155:1')).toBe(false);
  });
});

describe('getChainFamily', () => {
  it('returns "evm" for EVM chains', () => {
    expect(getChainFamily('eip155:8453')).toBe('evm');
    expect(getChainFamily('eip155:1')).toBe('evm');
  });

  it('returns "cardano" for Cardano chains', () => {
    expect(getChainFamily('cardano:mainnet')).toBe('cardano');
    expect(getChainFamily('cardano:preprod')).toBe('cardano');
  });

  it('returns "unknown" for unknown chain types', () => {
    expect(getChainFamily('solana:mainnet')).toBe('unknown');
    expect(getChainFamily('bitcoin:mainnet')).toBe('unknown');
  });
});

describe('getEvmChainId', () => {
  it('extracts numeric chain ID from EVM CAIP-2', () => {
    expect(getEvmChainId('eip155:8453')).toBe(8453);
    expect(getEvmChainId('eip155:1')).toBe(1);
    expect(getEvmChainId('eip155:137')).toBe(137);
  });

  it('throws for non-EVM chains', () => {
    expect(() => getEvmChainId('cardano:mainnet')).toThrow(/not an evm chain/i);
  });
});

describe('evmChainId', () => {
  it('creates EVM CAIP-2 identifier from numeric ID', () => {
    expect(evmChainId(8453)).toBe('eip155:8453');
    expect(evmChainId(1)).toBe('eip155:1');
    expect(evmChainId(137)).toBe('eip155:137');
  });
});

describe('getCardanoNetwork', () => {
  it('extracts network name from Cardano CAIP-2', () => {
    expect(getCardanoNetwork('cardano:mainnet')).toBe('mainnet');
    expect(getCardanoNetwork('cardano:preprod')).toBe('preprod');
    expect(getCardanoNetwork('cardano:preview')).toBe('preview');
  });

  it('throws for non-Cardano chains', () => {
    expect(() => getCardanoNetwork('eip155:8453')).toThrow(/not a cardano chain/i);
  });

  it('throws for invalid Cardano network', () => {
    expect(() => getCardanoNetwork('cardano:invalid')).toThrow(/invalid cardano network/i);
  });
});

describe('cardanoChainId', () => {
  it('creates Cardano CAIP-2 identifier from network name', () => {
    expect(cardanoChainId('mainnet')).toBe('cardano:mainnet');
    expect(cardanoChainId('preprod')).toBe('cardano:preprod');
    expect(cardanoChainId('preview')).toBe('cardano:preview');
  });
});

describe('isCardanoTestnet', () => {
  it('returns true for preprod', () => {
    expect(isCardanoTestnet('cardano:preprod')).toBe(true);
  });

  it('returns true for preview', () => {
    expect(isCardanoTestnet('cardano:preview')).toBe(true);
  });

  it('returns false for mainnet', () => {
    expect(isCardanoTestnet('cardano:mainnet')).toBe(false);
  });
});

describe('getChainInfo', () => {
  it('returns complete info for Base mainnet', () => {
    const info = getChainInfo('base-mainnet');
    expect(info.chainId).toBe('eip155:8453');
    expect(info.name).toBe('base-mainnet');
    expect(info.family).toBe('evm');
    expect(info.testnet).toBe(false);
    expect(info.nativeAsset).toBe('ETH');
    expect(info.nativeDecimals).toBe(18);
    expect(info.explorerUrl).toContain('basescan.org');
  });

  it('returns complete info for Cardano mainnet', () => {
    const info = getChainInfo('cardano-mainnet');
    expect(info.chainId).toBe('cardano:mainnet');
    expect(info.name).toBe('cardano-mainnet');
    expect(info.family).toBe('cardano');
    expect(info.testnet).toBe(false);
    expect(info.nativeAsset).toBe('ADA');
    expect(info.nativeDecimals).toBe(6);
    expect(info.explorerUrl).toContain('cardanoscan.io');
  });

  it('identifies testnets correctly', () => {
    expect(getChainInfo('base-sepolia').testnet).toBe(true);
    expect(getChainInfo('ethereum-sepolia').testnet).toBe(true);
    expect(getChainInfo('cardano-preprod').testnet).toBe(true);
    expect(getChainInfo('cardano-preview').testnet).toBe(true);
  });

  it('accepts CAIP-2 format input', () => {
    const info = getChainInfo('eip155:8453');
    expect(info.name).toBe('base-mainnet');
  });

  it('throws for unknown chains', () => {
    expect(() => getChainInfo('unknown-chain')).toThrow();
  });
});

describe('getAllChains', () => {
  it('returns all known chains', () => {
    const chains = getAllChains();
    expect(chains.length).toBe(Object.keys(CHAINS).length);
  });

  it('returns ChainInfo objects', () => {
    const chains = getAllChains();
    for (const chain of chains) {
      expect(chain).toHaveProperty('chainId');
      expect(chain).toHaveProperty('name');
      expect(chain).toHaveProperty('family');
      expect(chain).toHaveProperty('testnet');
      expect(chain).toHaveProperty('nativeAsset');
      expect(chain).toHaveProperty('nativeDecimals');
    }
  });
});

describe('getChainsByFamily', () => {
  it('returns only EVM chains for "evm" family', () => {
    const chains = getChainsByFamily('evm');
    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) {
      expect(chain.family).toBe('evm');
      expect(chain.chainId.startsWith('eip155:')).toBe(true);
    }
  });

  it('returns only Cardano chains for "cardano" family', () => {
    const chains = getChainsByFamily('cardano');
    expect(chains.length).toBe(3); // mainnet, preprod, preview
    for (const chain of chains) {
      expect(chain.family).toBe('cardano');
      expect(chain.chainId.startsWith('cardano:')).toBe(true);
    }
  });

  it('returns empty array for unknown family', () => {
    const chains = getChainsByFamily('unknown');
    expect(chains).toEqual([]);
  });
});

import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const root = import.meta.dirname;

export default defineConfig({
  resolve: {
    alias: {
      // Subpath exports (must come before main package aliases)
      '@fluxpointstudios/orynq-sdk-core/utils': resolve(root, 'packages/core/src/utils/index.ts'),
      '@fluxpointstudios/orynq-sdk-core/types': resolve(root, 'packages/core/src/types/index.ts'),
      '@fluxpointstudios/orynq-sdk-core/chains': resolve(root, 'packages/core/src/chains.ts'),
      // Main package aliases
      '@fluxpointstudios/orynq-sdk-anchors-cardano': resolve(root, 'packages/anchors-cardano/src/index.ts'),
      '@fluxpointstudios/orynq-sdk-anchors-materios': resolve(root, 'packages/anchors-materios/src/index.ts'),
      '@fluxpointstudios/orynq-sdk-client': resolve(root, 'packages/client/src/index.ts'),
      '@fluxpointstudios/orynq-sdk-core': resolve(root, 'packages/core/src/index.ts'),
      '@fluxpointstudios/orynq-sdk-flight-recorder': resolve(root, 'packages/flight-recorder/src/index.ts'),
      '@fluxpointstudios/orynq-sdk-hydra-batcher': resolve(root, 'packages/hydra-batcher/src/index.ts'),
      '@fluxpointstudios/orynq-sdk-midnight-prover': resolve(root, 'packages/midnight-prover/src/index.ts'),
      '@fluxpointstudios/orynq-sdk-attestor': resolve(root, 'packages/attestor/src/index.ts'),
      '@fluxpointstudios/orynq-sdk-storage-adapters': resolve(root, 'packages/storage-adapters/src/index.ts'),
      '@fluxpointstudios/orynq-sdk-gateway': resolve(root, 'packages/gateway/src/index.ts'),
      '@fluxpointstudios/orynq-sdk-payer-cardano-cip30': resolve(root, 'packages/payer-cardano-cip30/src/index.ts'),
      '@fluxpointstudios/orynq-sdk-payer-cardano-node': resolve(root, 'packages/payer-cardano-node/src/index.ts'),
      '@fluxpointstudios/orynq-sdk-payer-evm-direct': resolve(root, 'packages/payer-evm-direct/src/index.ts'),
      '@fluxpointstudios/orynq-sdk-payer-evm-x402': resolve(root, 'packages/payer-evm-x402/src/index.ts'),
      '@fluxpointstudios/orynq-sdk-payer-materios-x402': resolve(root, 'packages/payer-materios-x402/src/index.ts'),
      '@fluxpointstudios/orynq-sdk-process-trace': resolve(root, 'packages/process-trace/src/index.ts'),
      '@fluxpointstudios/orynq-sdk-tool-receipts': resolve(root, 'packages/tool-receipts/src/index.ts'),
      '@fluxpointstudios/orynq-sdk-quickstart': resolve(root, 'packages/quickstart/src/index.ts'),
      '@fluxpointstudios/orynq-sdk-server-middleware': resolve(root, 'packages/server-middleware/src/index.ts'),
      '@fluxpointstudios/orynq-sdk-transport-flux': resolve(root, 'packages/transport-flux/src/index.ts'),
      '@fluxpointstudios/orynq-sdk-transport-x402': resolve(root, 'packages/transport-x402/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/**/src/**/*.test.ts',
      'packages/**/tests/**/*.test.ts',
      'services/**/src/**/*.test.ts',
      'services/**/tests/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
    // Integration tests have longer timeouts
    testTimeout: 120_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});

import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Subpath exports (must come before main package aliases)
      '@fluxpointstudios/poi-sdk-core/utils': resolve(__dirname, 'packages/core/src/utils/index.ts'),
      '@fluxpointstudios/poi-sdk-core/types': resolve(__dirname, 'packages/core/src/types/index.ts'),
      '@fluxpointstudios/poi-sdk-core/chains': resolve(__dirname, 'packages/core/src/chains.ts'),
      // Main package aliases
      '@fluxpointstudios/poi-sdk-anchors-cardano': resolve(__dirname, 'packages/anchors-cardano/src/index.ts'),
      '@fluxpointstudios/poi-sdk-client': resolve(__dirname, 'packages/client/src/index.ts'),
      '@fluxpointstudios/poi-sdk-core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@fluxpointstudios/poi-sdk-flight-recorder': resolve(__dirname, 'packages/flight-recorder/src/index.ts'),
      '@fluxpointstudios/poi-sdk-gateway': resolve(__dirname, 'packages/gateway/src/index.ts'),
      '@fluxpointstudios/poi-sdk-payer-cardano-cip30': resolve(__dirname, 'packages/payer-cardano-cip30/src/index.ts'),
      '@fluxpointstudios/poi-sdk-payer-cardano-node': resolve(__dirname, 'packages/payer-cardano-node/src/index.ts'),
      '@fluxpointstudios/poi-sdk-payer-evm-direct': resolve(__dirname, 'packages/payer-evm-direct/src/index.ts'),
      '@fluxpointstudios/poi-sdk-payer-evm-x402': resolve(__dirname, 'packages/payer-evm-x402/src/index.ts'),
      '@fluxpointstudios/poi-sdk-process-trace': resolve(__dirname, 'packages/process-trace/src/index.ts'),
      '@fluxpointstudios/poi-sdk-server-middleware': resolve(__dirname, 'packages/server-middleware/src/index.ts'),
      '@fluxpointstudios/poi-sdk-transport-flux': resolve(__dirname, 'packages/transport-flux/src/index.ts'),
      '@fluxpointstudios/poi-sdk-transport-x402': resolve(__dirname, 'packages/transport-x402/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/**/src/**/*.test.ts',
      'packages/**/tests/**/*.test.ts',
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

import { resolve } from 'path';
import { defineConfig, mergeConfig } from 'vitest/config';
import workspace from '../../vitest.config.mts';

const { globals, environment, testTimeout, hookTimeout } = workspace.test!;

// The conduct suite, which the root config excludes because it reads the circuits build:conduct compiles.
export default mergeConfig(
  { resolve: workspace.resolve, test: { globals, environment, testTimeout, hookTimeout } },
  defineConfig({
    root: resolve(import.meta.dirname, '../..'),
    test: { include: ['packages/midnight-prover/tests/conduct/**/*.test.ts'] },
  }),
);

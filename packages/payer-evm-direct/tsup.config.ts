/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-evm-direct/tsup.config.ts
 * @summary Build configuration for @poi-sdk/payer-evm-direct package using tsup.
 *
 * This configuration produces both ESM and CJS outputs with declaration files.
 * The package is built for ES2022 target with full tree-shaking support.
 */

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  minify: false,
  target: "es2022",
  outDir: "dist",
  external: ["@poi-sdk/core", "viem"],
});

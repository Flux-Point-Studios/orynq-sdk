/**
 * @summary Build configuration for @fluxpointstudios/poi-sdk-payer-evm-direct package using tsup.
 *
 * This configuration produces both ESM and CJS outputs with declaration files.
 * The package is built for ES2022 target with full tree-shaking support.
 *
 * Entry points:
 * - src/index.ts: Main package exports (ViemPayer, utilities)
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
  external: ["@fluxpointstudios/poi-sdk-core", "viem"],
});

/**
 * @summary Build configuration for @fluxpointstudios/poi-sdk-payer-evm-x402 package using tsup.
 *
 * This configuration produces both ESM and CJS outputs with declaration files.
 * The package is built for ES2022 target with full tree-shaking support.
 *
 * External dependencies (not bundled):
 * - @fluxpointstudios/poi-sdk-core: workspace dependency
 * - @fluxpointstudios/poi-sdk-transport-x402: workspace dependency
 * - viem: peer dependency for EVM interactions
 * - @x402/evm: optional peer dependency for x402 protocol
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
  external: [
    "@fluxpointstudios/poi-sdk-core",
    "@fluxpointstudios/poi-sdk-transport-x402",
    "viem",
    "@x402/evm",
  ],
});

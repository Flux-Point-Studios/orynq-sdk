/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/transport-x402/tsup.config.ts
 * @summary Build configuration for @poi-sdk/transport-x402 package using tsup.
 *
 * This configuration produces both ESM and CJS outputs with declaration files.
 * The package wraps Coinbase's @x402/* packages for the x402 v2 wire format.
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
  external: ["@poi-sdk/core", "@x402/fetch", "@x402/evm"],
});

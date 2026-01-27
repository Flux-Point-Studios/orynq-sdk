/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/payer-cardano-cip30/tsup.config.ts
 * @summary Build configuration for @poi-sdk/payer-cardano-cip30 package using tsup.
 *
 * This configuration produces both ESM and CJS outputs with declaration files.
 * The package is designed for browser environments with CIP-30 wallet support.
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
  external: ["lucid-cardano", "@poi-sdk/core"],
});

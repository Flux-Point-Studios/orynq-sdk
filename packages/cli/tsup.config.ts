/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/cli/tsup.config.ts
 * @summary Build configuration for @poi-sdk/cli package using tsup.
 *
 * This configuration produces both ESM and CJS outputs with declaration files.
 * The CLI package provides dev tools for testing 402 payment flows.
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
  banner: {
    js: "#!/usr/bin/env node",
  },
  external: [
    "@poi-sdk/core",
    "@poi-sdk/client",
    "@poi-sdk/transport-x402",
    "@poi-sdk/transport-flux",
    "@poi-sdk/payer-evm-direct",
    "commander",
    "chalk",
    "viem",
  ],
});

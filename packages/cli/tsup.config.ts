/**
 * @summary Build configuration for @fluxpointstudios/poi-sdk-cli package using tsup.
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
    "@fluxpointstudios/poi-sdk-core",
    "@fluxpointstudios/poi-sdk-client",
    "@fluxpointstudios/poi-sdk-transport-x402",
    "@fluxpointstudios/poi-sdk-transport-flux",
    "@fluxpointstudios/poi-sdk-payer-evm-direct",
    "commander",
    "chalk",
    "viem",
  ],
});

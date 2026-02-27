/**
 * @summary Build configuration for @fluxpointstudios/orynq-sdk-cli package using tsup.
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
    "@fluxpointstudios/orynq-sdk-core",
    "@fluxpointstudios/orynq-sdk-client",
    "@fluxpointstudios/orynq-sdk-transport-x402",
    "@fluxpointstudios/orynq-sdk-transport-flux",
    "@fluxpointstudios/orynq-sdk-payer-evm-direct",
    "commander",
    "chalk",
    "viem",
  ],
});

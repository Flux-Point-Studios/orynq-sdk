/**
 * @summary Build configuration for @fluxpointstudios/orynq-sdk-transport-x402 package using tsup.
 *
 * This configuration produces both ESM and CJS outputs with declaration files.
 * The package wraps Coinbase's @x402/* packages for the x402 wire format.
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
  external: ["@fluxpointstudios/orynq-sdk-core", "@x402/fetch", "@x402/evm"],
});

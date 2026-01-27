/**
 * @summary Build configuration for @fluxpointstudios/poi-sdk-payer-cardano-cip30 package using tsup.
 *
 * This configuration produces both ESM and CJS outputs with declaration files.
 * The package is designed for browser environments with CIP-30 wallet support.
 * Uses @meshsdk/core for Cardano transaction building and wallet integration.
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
  external: ["@meshsdk/core", "@fluxpointstudios/poi-sdk-core"],
});

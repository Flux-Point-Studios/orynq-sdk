/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/client/tsup.config.ts
 * @summary Build configuration for @poi-sdk/client package using tsup.
 *
 * This configuration produces both ESM and CJS outputs with declaration files.
 * The client package provides the main PoiClient with auto-pay functionality.
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
    "@poi-sdk/core",
    "@poi-sdk/transport-x402",
    "@poi-sdk/transport-flux",
  ],
});

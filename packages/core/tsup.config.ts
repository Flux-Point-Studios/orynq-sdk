/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/core/tsup.config.ts
 * @summary Build configuration for @poi-sdk/core package using tsup.
 *
 * This configuration produces both ESM and CJS outputs with declaration files.
 * Entry points include the main index, types, chains, and utils modules.
 */

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/types/index.ts", "src/chains.ts", "src/utils/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  minify: false,
  target: "es2022",
  outDir: "dist",
});

/**
 * @summary Build configuration for @fluxpointstudios/orynq-sdk-transport-flux package using tsup.
 *
 * This configuration produces both ESM and CJS outputs with declaration files.
 * The package has a single entry point (index.ts) that re-exports all functionality.
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
  external: ["@fluxpointstudios/orynq-sdk-core"],
});

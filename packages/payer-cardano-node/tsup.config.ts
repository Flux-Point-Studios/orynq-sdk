/**
 * @summary Build configuration for @fluxpointstudios/poi-sdk-payer-cardano-node package using tsup.
 *
 * This configuration produces both ESM and CJS outputs with declaration files.
 * Entry points include the main index, signers, and providers modules.
 */

import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/signers/index.ts",
    "src/providers/index.ts",
  ],
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
    "@emurgo/cardano-serialization-lib-nodejs",
    "@aws-sdk/client-kms",
  ],
});

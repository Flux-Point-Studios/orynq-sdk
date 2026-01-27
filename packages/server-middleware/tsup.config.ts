/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/server-middleware/tsup.config.ts
 * @summary Build configuration for @poi-sdk/server-middleware package using tsup.
 *
 * This configuration produces both ESM and CJS outputs with declaration files.
 * Entry points include the main index, express, fastify, and verifiers modules.
 */

import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    express: "src/express.ts",
    fastify: "src/fastify.ts",
    "verifiers/index": "src/verifiers/index.ts",
  },
  format: ["esm", "cjs"],
  dts: {
    compilerOptions: {
      composite: false,
    },
  },
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  minify: false,
  target: "es2022",
  outDir: "dist",
  external: [
    "@poi-sdk/core",
    "express",
    "fastify",
    "viem",
    "viem/chains",
  ],
});

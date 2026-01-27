/**
 * @file D:/fluxPoint/PoI/poi-sdk/packages/gateway/tsup.config.ts
 * @summary Build configuration for @poi-sdk/gateway package using tsup.
 *
 * This configuration produces both ESM and CJS outputs with declaration files.
 * It also creates a CLI entry point for running the gateway server.
 */

import { defineConfig } from "tsup";

export default defineConfig([
  // Main library build
  {
    entry: {
      index: "src/index.ts",
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
      "@poi-sdk/transport-x402",
      "@poi-sdk/server-middleware",
      "express",
      "cors",
      "http-proxy-middleware",
    ],
  },
  // CLI build with shebang
  {
    entry: {
      cli: "src/cli.ts",
    },
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: true,
    splitting: false,
    treeshake: true,
    minify: false,
    target: "es2022",
    outDir: "dist",
    external: [
      "@poi-sdk/core",
      "@poi-sdk/transport-x402",
      "@poi-sdk/server-middleware",
      "express",
      "cors",
      "http-proxy-middleware",
    ],
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);

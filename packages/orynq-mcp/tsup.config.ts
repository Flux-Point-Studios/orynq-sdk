// packages/orynq-mcp/tsup.config.ts
// Build configuration for the orynq-mcp package.
// Produces dual ESM/CJS output with a shebang banner so the ESM
// entry can run directly as a CLI via the "bin" field in package.json.

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  minify: false,
  target: "es2022",
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
  external: [
    "@fluxpointstudios/orynq-sdk-core",
    "@fluxpointstudios/orynq-sdk-core/utils",
    "@fluxpointstudios/orynq-sdk-core/types",
    "@fluxpointstudios/orynq-sdk-core/chains",
    "@fluxpointstudios/orynq-sdk-process-trace",
    "@fluxpointstudios/orynq-sdk-anchors-cardano",
    "@fluxpointstudios/orynq-sdk-anchors-cardano/providers",
  ],
});

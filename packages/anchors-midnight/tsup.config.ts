import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  outDir: "dist",
  external: ["@midnight-ntwrk/compact-runtime", "@midnight-ntwrk/ledger-v8"],
});

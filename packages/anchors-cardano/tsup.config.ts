import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/providers/index.ts"],
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
    "@fluxpointstudios/poi-sdk-core",
    "@fluxpointstudios/poi-sdk-process-trace",
  ],
});

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
    "@fluxpointstudios/poi-sdk-core",
    "@fluxpointstudios/poi-sdk-core/utils",
    "@fluxpointstudios/poi-sdk-core/types",
    "@fluxpointstudios/poi-sdk-core/chains",
  ],
});

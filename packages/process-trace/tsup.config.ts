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
    "@fluxpointstudios/orynq-sdk-core",
    "@fluxpointstudios/orynq-sdk-core/utils",
    "@fluxpointstudios/orynq-sdk-core/types",
    "@fluxpointstudios/orynq-sdk-core/chains",
  ],
});

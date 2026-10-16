import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/midnight.ts"],
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
    "@fluxpointstudios/orynq-sdk-process-trace",
    "@fluxpointstudios/orynq-sdk-anchors-materios",
    "@fluxpointstudios/orynq-sdk-anchors-midnight",
    "@polkadot/keyring",
    "@polkadot/util",
    "@polkadot/util-crypto",
  ],
});

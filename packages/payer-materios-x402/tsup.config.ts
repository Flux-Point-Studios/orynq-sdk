/**
 * @summary Build configuration for @fluxpointstudios/orynq-sdk-payer-materios-x402.
 *
 * Produces dual ESM/CJS output with declaration files, ES2022 target.
 *
 * External dependencies (not bundled):
 * - @fluxpointstudios/orynq-sdk-core: workspace dependency
 * - @fluxpointstudios/orynq-sdk-transport-x402: workspace dependency
 * - @polkadot/keyring, @polkadot/util, @polkadot/util-crypto: substrate signing
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
  external: [
    "@fluxpointstudios/orynq-sdk-core",
    "@fluxpointstudios/orynq-sdk-transport-x402",
    "@polkadot/keyring",
    "@polkadot/util",
    "@polkadot/util-crypto",
  ],
});

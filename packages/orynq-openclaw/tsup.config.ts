import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["cjs"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
  banner: { js: "#!/usr/bin/env node" }
});

import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("package.json", "utf-8")) as { version: string };

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["cjs"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
  banner: { js: "#!/usr/bin/env node" },
  define: { __PACKAGE_VERSION__: JSON.stringify(version) }
});

import { defineConfig } from "vitest/config";

// Without its own config, `vitest run` here would take the repository's, whose globs are rooted
// at the repository and match nothing in this directory.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
});

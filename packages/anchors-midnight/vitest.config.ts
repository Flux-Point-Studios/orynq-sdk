import { defineConfig } from "vitest/config";

// test-journal needs node:sqlite (Node 22.13 or later), so the repository-wide suite, which CI
// runs on Node 20, does not collect it; this package's suite does.
export default defineConfig({
  test: { include: ["src/**/*.test.ts", "test-journal/**/*.test.ts"] },
});

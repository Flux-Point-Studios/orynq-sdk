import { defineConfig } from "vitest/config";

// The submit side needs node:sqlite and the wallet SDK (Node 22.13 or later), so the
// repository-wide suite, which CI runs on Node 20, does not collect test/; CI runs it on Node 24.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000 },
});

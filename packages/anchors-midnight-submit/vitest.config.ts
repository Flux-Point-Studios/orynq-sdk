import { defineConfig } from "vitest/config";

// The submit side needs node:sqlite and the wallet SDK (Node 22.13 or later), so the
// repository-wide suite, which also supports Node 20, does not collect test/ or rehearsal/test/;
// CI's midnight-submit step runs them.
export default defineConfig({
  test: { include: ["test/**/*.test.ts", "rehearsal/test/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000 },
});

import { defineConfig } from "vitest/config";

// Proves for real in the wallet SDK's worker thread: run under nice 19 with MIDNIGHT_PP holding
// what tools/compactc/install.sh verifies.
export default defineConfig({
  test: { include: ["test-slow/**/*.test.ts"], testTimeout: 600_000, hookTimeout: 600_000 },
});

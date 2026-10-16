import { defineConfig } from "vitest/config";

// Proves real registry calls in-process: run under nice 19 with MIDNIGHT_PP holding the
// k=13/14 parameters that tools/compactc/install.sh verifies.
export default defineConfig({
  test: { include: ["test-slow/**/*.test.ts"], testTimeout: 600_000, hookTimeout: 600_000 },
});

import { defineConfig } from "vitest/config";

// The real-socket suite runs the orynq-socket-frontend binary named by ORYNQ_SOCKET_FRONTEND.
export default defineConfig({
  test: { include: ["test-socket/**/*.test.ts"], testTimeout: 60_000, fileParallelism: false },
});

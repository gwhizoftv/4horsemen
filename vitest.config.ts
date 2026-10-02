import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration.test.ts"],
    testTimeout: 15_000,
    setupFiles: ["./test/support/yieldEventLoop.ts"]
  }
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/support/yieldEventLoop.ts"],
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration.test.ts"],
    testTimeout: 15_000
  }
});

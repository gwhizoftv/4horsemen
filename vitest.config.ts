import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration.test.ts", "test/cli.test.ts", "test/install.test.ts", "test/workspace.test.ts",
      "test/wipeIssue.test.ts", "test/wrapper.test.ts", "test/bootstrap.test.ts", "test/onboard.test.ts",
      "test/hookSync.test.ts", "test/agentHookSync.test.ts"],
    testTimeout: 15_000,
    setupFiles: ["./test/support/yieldEventLoop.ts"]
  }
});

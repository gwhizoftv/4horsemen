import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/cli.test.ts", "test/install.test.ts", "test/workspace.test.ts", "test/wipeIssue.test.ts",
      "test/wrapper.test.ts", "test/bootstrap.test.ts", "test/onboard.test.ts", "test/hookSync.test.ts", "test/agentHookSync.test.ts"],
    maxWorkers: 1,
    testTimeout: 15_000,
    setupFiles: ["./test/support/yieldEventLoop.ts"]
  }
});

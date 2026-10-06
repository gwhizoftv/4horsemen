import { defineConfig } from "vitest/config";

/**
 * Suites that drive real filesystems, Git clones, installed hooks and child
 * processes. They are separated from `test:fast` so the pre-commit gate stays
 * cheap, and `pnpm check` keeps running them before a pin is submitted.
 */
export default defineConfig({
  test: {
    include: [
      "test/cli.test.ts",
      "test/install.test.ts",
      "test/workspace.test.ts",
      "test/wipeIssue.test.ts",
      "test/wrapper.test.ts",
      "test/bootstrap.test.ts",
      "test/onboard.test.ts",
      "test/hookSync.test.ts",
      "test/agentHookSync.test.ts"
    ],
    testTimeout: 15_000,
    setupFiles: ["./test/support/yieldEventLoop.ts"]
  }
});

import { defineConfig } from "vitest/config";

/**
 * End-to-end tier: the four-agent integration canary only. The pre-push hook
 * invokes this through `pnpm test:e2e` for workflow-critical paths.
 *
 * `passWithNoTests` stays at its default (false) on purpose. If the canary is
 * ever renamed or deleted, this tier must fail loudly rather than report a
 * green run over an empty suite.
 */
export default defineConfig({
  test: {
    include: ["test/integration.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
});

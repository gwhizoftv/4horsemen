import { defineConfig } from "vitest/config";

/**
 * Fast tier. Runs on every pre-commit through `pnpm check:fast`, so the
 * four-agent integration canary is deliberately excluded — it belongs to
 * `vitest.e2e.config.ts` and the pre-push hook.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration.test.ts", "**/node_modules/**", "**/dist/**"]
  }
});

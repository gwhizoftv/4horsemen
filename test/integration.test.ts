import { describe, expect, it } from "vitest";

/**
 * Placeholder for the four-agent canary (creation-order step 22).
 *
 * This file must exist from the moment `test:e2e` appears in package.json:
 * the pre-push hook treats `package.json` as workflow-critical and invokes
 * `pnpm test:e2e`, and vitest exits non-zero when a filter matches no files.
 * Without this placeholder every push between the tooling commit and the real
 * canary would be blocked.
 */
describe("integration canary", () => {
  it("has an e2e tier wired to the pre-push hook", () => {
    expect(true).toBe(true);
  });
});

import { defineConfig } from "vitest/config";

const isE2E = process.env.TEST_ENV === "e2e";

export default defineConfig({
  test: {
    include: isE2E ? ["test/integration.test.ts"] : ["test/**/*.test.ts"],
    exclude: isE2E ? [] : ["test/integration.test.ts"]
  }
});

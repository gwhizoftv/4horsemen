import { setImmediate } from "node:timers/promises";
import { beforeEach } from "vitest";

// Synchronous subprocess-heavy tests otherwise starve worker RPC replies across
// an entire file, triggering Vitest's 60-second reporting timeout despite passes.
beforeEach(async () => {
  await setImmediate();
});

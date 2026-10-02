import { setImmediate } from "node:timers";
import { beforeEach } from "vitest";

/**
 * Synchronous tests (especially git-heavy install/hook files) never reach the
 * event-loop poll phase between cases, so the vitest worker's birpc reply for
 * onTaskUpdate can sit unread past the ~60 s timeout even when every assertion
 * passed. One macrotask yield before each test lets the worker drain RPC.
 */
beforeEach(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
});

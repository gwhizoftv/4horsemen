import { beforeEach } from "vitest";

/**
 * Vitest's worker acknowledges progress over an RPC with a fixed 60 s timeout.
 * Between tests the runner only awaits microtasks, so a file of synchronous,
 * subprocess-heavy tests (`install.test.ts` runs for over a minute) never lets
 * the worker poll for the reply: the timer fires first and the run exits 1 with
 * every test green. One macrotask turn per test drains the queued replies.
 */
beforeEach(() => new Promise<void>((resolve) => setImmediate(resolve)));

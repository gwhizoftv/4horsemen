# Issue 106: Coord EPIPE crash

## Exact File List to be changed or deleted

- `src/tmux.ts` — harden `runTmux` so a broken stdin pipe cannot take down the coordinator process. Stop opening a stdin pipe when there is nothing to write (match `runArgv` / `runGitCommand`), and when stdin is used, register an `error` handler that treats `EPIPE` as non-fatal before calling `end()`.
- `test/tmux.test.ts` — add a focused unit test that proves `runTmux` survives an `EPIPE` on `child.stdin` and still resolves with the child exit result.

## Exact file list to be created

- `.plans/issue-106/plan.md` — this file.

## Reuse and Scope

**Reuse (no new modules):**

- `runTmux`, `TmuxRunner`, and `TmuxResult` in `src/tmux.ts` — the public contract stays the same; only the spawn/stdin teardown inside `runTmux` changes.
- `TmuxController` and every caller of `this.runner(...)` — they already interpret `TmuxResult.exitCode` and do not depend on stdin being piped for empty input. No changes outside `runTmux`.
- `runArgv` in `src/runLoop.ts` and `runGitCommand` in `src/mirror.ts` — both use `stdio: ["ignore", "pipe", "pipe"]` when the child needs no stdin. `runTmux` should follow that same convention instead of always piping and immediately `end("")`.
- `test/tmux.test.ts` — extend the existing `tmux boundary` suite; keep using vitest and the file's `TmuxRunner` stub patterns for controller tests. The new case targets `runTmux` directly.

**Scope boundary:**

- Do not change `openDarwinTerminalWindows` (osascript spawn with `stdio: ["ignore", ...]` already). The crash stack in the issue points at `tmux.js:15` (`child.stdin.end`), which is `runTmux` only.
- Do not add logging, retry logic, or run-loop wrappers — one bad tmux call should return its normal `{ exitCode, stdout, stderr }` and let the tick continue; swallowing `EPIPE` is sufficient.
- No `package.json`, docs, or install-tree changes — this is a runtime hardening fix shipped through the normal build/install path.

## Tests

Commands (as declared in this repository):

- `pnpm check:fast` — `pnpm lint && pnpm typecheck && pnpm test:fast`. Run before commit; it is the declared `verify.precommit`.

New case in `test/tmux.test.ts` (same file as the existing tmux boundary tests):

1. **`runTmux` ignores stdin `EPIPE` and still resolves** — mock `node:child_process.spawn` to return a fake child whose `stdin` is an `EventEmitter`/`Writable`, whose `stdout`/`stderr` emit `end`, and whose `close` fires with a known exit code. Call `runTmux(["list-sessions"], "payload")`, emit `error` with `{ code: "EPIPE" }` on `stdin` (as Node does when the peer closes before the write finishes), and assert the promise resolves to that exit code instead of rejecting or leaving an unhandled rejection. This fails on the current code because `stdin.end` is called with no `error` listener.

2. **`runTmux` uses ignored stdin when input is absent** — same mock; call `runTmux(["has-session", "-t", "coord-1"])` with no second argument and assert `spawn` was invoked with `stdio` whose first element is `"ignore"` (not `"pipe"`). This prevents the empty-string `end()` race for every current production caller, none of which pass `input` today.

Optional tightening in the same test file (only if the mock setup is already in place): assert a non-`EPIPE` stdin error still rejects the `runTmux` promise so real pipe failures are not silently dropped.

Deleted tests: none.

## Alternatives Rejected

**Wrap every `TmuxController` call in try/catch at the run-loop level.** The failure is an unhandled `error` event on `child.stdin`, not a rejected `runTmux` promise — the process dies before the loop can catch anything. The fix belongs at the spawn boundary.

**`try/catch` around `child.stdin.end(...)`.** `EPIPE` is delivered asynchronously on the stream's `error` event; a synchronous catch does not run.

**Ignore all `stdin` errors.** A non-`EPIPE` error (e.g. `EBADF`) can indicate a real spawn/configuration problem and should still reject.

**Always pipe stdin and only add an `error` listener.** Works but keeps opening a pipe every tick just to `end("")`; using `"ignore"` when there is no payload matches existing subprocess helpers and removes the race for the common path entirely.

**Retry failed tmux commands in the run loop.** Out of scope; callers already treat non-zero `exitCode` as a soft failure (empty capture, deferred delivery). The bug is process termination, not a missing retry.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| A future caller passes `input` and relies on write failure surfacing | Non-`EPIPE` stdin errors still reject; only the broken-pipe case is swallowed, which is the documented tmux race. |
| Mocking `spawn` in `test/tmux.test.ts` is brittle across Node versions | Keep the mock minimal (stdin/stdout/stderr event emitters + `close`); assert behaviour (resolve vs reject), not internal stream state. |
| Real tmux unavailable in CI | The new test does not invoke the `tmux` binary; it exercises `runTmux` through the mock only. Existing integration paths stay unchanged. |
| Hiding a tmux command that failed because the session died | `EPIPE` on stdin does not change `exitCode`/`stderr` from the child `close` event; callers that already handle non-zero exit codes continue to do so. |

## Conclusion

Harden `runTmux` in `src/tmux.ts` by (1) using `stdio: ["ignore", "pipe", "pipe"]` when `input` is undefined or empty, and (2) attaching a stdin `error` handler that ignores `EPIPE` before `end()` when input is provided. Add one mocked unit test in `test/tmux.test.ts` proving the coordinator no longer crashes on the race seen in issue 106. No other files change. Verify with `pnpm check:fast` before commit.

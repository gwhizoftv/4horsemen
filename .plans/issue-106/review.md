# Issue 106 plan review — claude

Plans reviewed (bound pins):

- codex `a60e99434ea6a13f0bebd87cf0714485e7ee0635` — `.plans/issue-106/plan.md`
- cursor `2c627878ca43664c46fee3a57a5c7c7af1fbb7eb` — `.plans/issue-106/plan.md`
- claude `20bde887e99d5ffb3ae67fbb392cd8a6663091d2` — `.plans/issue-106/plan.md`

All three land the same product change in the same place (`runTmux`,
`src/tmux.ts:13-23`) and the same test file (`test/tmux.test.ts`), name
`pnpm check:fast`, and create no new module. The findings below are about the
parts that would not survive being implemented as written.

## Findings

### 1. codex — Reuse and Scope / Tests: an EventEmitter fake child cannot get as far as stdin

- **Claim.** codex, *Reuse and Scope*: "mock only the `node:child_process.spawn`
  boundary with an EventEmitter-shaped fake child and stdin"; *Tests*: "starts
  `runTmux` with a fake child, emits an `EPIPE` from `child.stdin` during `end`".
  cursor, *Tests* item 1, specifies the same shape: "a fake child whose `stdin`
  is an `EventEmitter`/`Writable`, whose `stdout`/`stderr` emit `end`".
- **Rule.** A fake substituted for a real object must implement every member the
  code under test calls on it, in the order the code calls them.
- **Failure.** `runTmux` touches stdout and stderr before it touches stdin:
  `child.stdout.setEncoding("utf8").on("data", ...)` (`src/tmux.ts:18`) and the
  same for stderr (`src/tmux.ts:19`). `EventEmitter` has no `setEncoding`, so
  the call throws `child.stdout.setEncoding is not a function` at line 18 —
  before `child.stdin.end` at line 22 ever runs. The regression case therefore
  fails identically on the current code and on a correctly fixed build: it never
  reaches the bug, so it cannot show the bug is gone. It is a red test that
  proves nothing.
- **Correction.** Use `PassThrough` from `node:stream` for the fake `stdout` and
  `stderr` (it implements `setEncoding` and returns `this`), and keep the fake
  `stdin` an object that emits `error` on `end()`.

### 2. codex and cursor — Reuse and Scope / Tests: a file-wide `vi.mock` of `node:child_process` drops `spawnSync`

- **Claim.** codex, *Reuse and Scope*: "The test will mock only the
  `node:child_process.spawn` boundary ... reusing its Vitest `describe` / `it` /
  `expect` setup"; cursor, *Tests* item 1: "mock `node:child_process.spawn` to
  return a fake child".
- **Rule.** A module mock is file-wide and hoisted, so it must preserve every
  binding the module under test imports from that module; and a plan's "reuse
  existing test support" claim must point at support that exists in the repo.
- **Failure.** `src/tmux.ts:2` is a static ESM import of two bindings:
  `import { spawn, spawnSync } from "node:child_process"`. The only way to
  substitute `spawn` for a statically imported binding is
  `vi.mock("node:child_process", factory)`, which vitest hoists above the
  imports and applies to all of `test/tmux.test.ts` (1014 lines, one
  `describe("tmux boundary")` at `test/tmux.test.ts:61`). Neither plan says the
  factory must re-export the module's other bindings, so a factory of
  `() => ({ spawn: fakeSpawn })` leaves `spawnSync` undefined inside the module
  under test, silently disabling `closeDarwinTerminalWindows`
  (`src/tmux.ts:479`) and `listOpenDarwinTerminalTitles` (`src/tmux.ts:513`) for
  every case in that file — the next case added to it that exercises either path
  dies with a mock-export error whose cause is in an unrelated test. Separately,
  the "reuse the existing setup" justification does not hold: `grep -rn
  "vi\.mock\|vi\.spyOn" test` returns nothing, so this repo has no module-mock
  precedent to reuse; its convention is dependency injection
  (`runner: TmuxRunner = runTmux`, `src/tmux.ts:560`) and real on-disk fixtures.
- **Correction.** If the mock stays, require the factory to spread
  `await importOriginal()` so `spawnSync` survives. Otherwise drive the real
  `spawn` with a stub `tmux` on `PATH`, which needs no mock at all.

### 3. codex and cursor — the EPIPE-only filter leaves the same race fatal and can discard a successful tmux result

- **Claim.** codex, *Exact File List* and *Risks*: "Preserve rejection for spawn
  failures and unexpected stdin errors ... branch specifically on the Node error
  code `EPIPE`; retain rejection for other stdin errors". cursor, *Alternatives
  Rejected*: "A non-`EPIPE` error (e.g. `EBADF`) can indicate a real
  spawn/configuration problem and should still reject."
- **Rule.** The defect is an *unhandled stream `error` event*, not one errno, so
  the fix must make the whole "the child was gone before the stdin write landed"
  class non-fatal; and settling must not throw away a result the child already
  produced.
- **Failure.** The same race does not always surface as `EPIPE`: once Node has
  destroyed the stdin socket after the child exited, the write is reported as
  `ERR_STREAM_DESTROYED`, and a reset peer reports `ECONNRESET`. Under both
  plans those reject. A rejection settles the promise first and permanently, so
  the pending `child.once("close", ...)` result (`src/tmux.ts:21`) is discarded
  even when tmux exited 0 and the command took effect. `TmuxController.nudge`
  issues the nudge as a sequence of `send-keys` calls through `send()`
  (`src/tmux.ts:888-895`): prelude keys, then `-l <text>`, then the submit keys.
  If the rejection lands on the call after the text was already typed, `nudge`
  throws instead of returning `{ status: "sent" }`, `runLoop` never reaches
  `markActionInjected` (`src/runLoop.ts:986`, `src/runLoop.ts:1265`), and the
  loop re-delivers the same action — the nudge text is typed into the agent's
  pane twice. The plans trade a crash for a duplicate-delivery bug on the codes
  they chose not to cover.
- **Correction.** Do not branch on the code. Let `close` remain the single
  settler and record the stdin error's `code` into the already-captured `stderr`
  accumulator (`src/tmux.ts:17`), which every throw site in the file already
  interpolates (`src/tmux.ts:685`, `694`, `714`, `787`, `895`), so a genuine
  stdin failure is still visible in the message without being fatal.

### 4. cursor — Tests item 2 asserts the spawn arguments, not the behavior the issue is about

- **Claim.** cursor, *Tests* item 2: "assert `spawn` was invoked with `stdio`
  whose first element is `"ignore"` (not `"pipe"`)" — while cursor's own
  *Risks* row says "assert behaviour (resolve vs reject), not internal stream
  state".
- **Rule.** A regression test must fail when the reported failure mode is
  present and pass when it is absent; it must not pin an implementation choice
  that is incidental to the defect.
- **Failure.** The assertion is satisfied by the argument list alone. A build
  that ignores stdin but omits the `error` handler passes item 2 while
  `runTmux(["load-buffer", "-"], "payload")` — the branch cursor's own design
  keeps piped — still kills the coordinator exactly as issue 106 reports. In the
  other direction, a correct build that keeps `stdio: ["pipe", "pipe", "pipe"]`
  and handles the stdin error fails item 2 despite having fixed the bug. The
  test contradicts the plan's own stated rule for its tests one section later.
- **Correction.** Drop item 2 and keep one behavioral case; if the stdio change
  is kept, cover the piped path (`input` provided) behaviorally instead.

### 5. cursor — "stop opening a stdin pipe" is a second change the issue does not require

- **Claim.** cursor, *Exact File List* and *Conclusion*: "Stop opening a stdin
  pipe when there is nothing to write (match `runArgv` / `runGitCommand`)", plus
  the `error` handler "when stdin is used".
- **Rule.** Make the smallest change that fully solves the issue; every extra
  change must be needed by the fix.
- **Failure.** With the `error` handler in place the pipe is already harmless,
  so the stdio switch removes no remaining failure — it only adds a second code
  path (`child.stdin` is `null` when `stdio[0]` is `"ignore"`) that every future
  edit to `runTmux` must null-guard, and it splits the function's behavior on an
  argument no caller in the repo passes today (every `this.runner(...)` call at
  `src/tmux.ts:609-893` is one-argument). Following the plan as written also
  leaves the two paths asymmetric: the empty-input path is protected by
  construction while the input path is protected by a handler, so the two can
  drift and only one is covered behaviorally (see finding 4).
- **Correction.** Ship the handler alone; if the stdio change is still wanted,
  raise it separately rather than inside the crash fix.

### 6. codex and cursor — the plan file is listed as a file the implementation creates

- **Claim.** codex, *Exact file list to be created*: "`.plans/issue-106/plan.md`
  — this implementation plan"; cursor, same heading: "`.plans/issue-106/plan.md`
  — this file."
- **Rule.** The file lists bound what the *implementation* changes and creates.
  The plan is the artifact of the planning action and already exists at the
  pinned commit under review.
- **Failure.** An implementer working the file lists literally writes
  `.plans/issue-106/plan.md` on the implementation commit — an artifact the
  implementation action did not request, on top of the very file the coordinator
  pinned as bound input, so the implementation commit no longer matches the plan
  it was bound to. It also leaves both plans without an explicit statement that
  the implementation creates *no* files, which is the fact a reviewer needs.
- **Correction.** State "None" under the created-files heading and justify why no
  new file is needed.

### 7. claude (own plan) — the test asserts the errno the fix deliberately does not depend on

- **Claim.** claude, *Tests*: `expect(result.stderr).toContain("EPIPE")`, against
  a handler the same plan specifies as appending `error.code ?? error.message`
  without branching on the code.
- **Rule.** A plan's assertions must follow from the design that same plan
  specifies; a code-agnostic fix must not be verified by a code-specific
  assertion.
- **Failure.** By finding 3's own reasoning, the race can surface as
  `ERR_STREAM_DESTROYED` rather than `EPIPE`. On such a run the handler records
  the sibling code, the fix is working exactly as designed, and the assertion
  fails — a correct build reported as a regression, on a case whose whole job is
  to distinguish correct from broken.
- **Correction.** Assert `result.exitCode === 3` (the `close` handler still
  reports tmux's real exit) plus that `stderr` names the stdin failure (match on
  `stdin`, not on the errno).

## Conclusion

All three plans agree on the diagnosis and on the one-function blast radius,
which is right: `child.once("error", reject)` (`src/tmux.ts:20`) subscribes to
the ChildProcess and not to `child.stdin`, so the write at `src/tmux.ts:22`
escapes as an unhandled event.

The implementable core is: attach an `error` listener to `child.stdin` before
`end()`, keep `close` as the single settler, and do not branch on the errno
(finding 3). Findings 1 and 2 must be resolved before either mocked test is
written — as specified, codex's and cursor's regression cases fail for reasons
unrelated to the defect and cannot distinguish a fixed build from a broken one;
a stub `tmux` on `PATH`, or a `PassThrough`-based fake with an
`importOriginal()`-preserving factory, fixes that. Finding 4 should remove
cursor's spawn-argument assertion, finding 5 should defer cursor's stdio change,
finding 6 is a bookkeeping correction both peers should make, and finding 7 is a
correction to my own plan's assertion. None of the findings require a different
file set: `src/tmux.ts` plus `test/tmux.test.ts`, verified with
`pnpm check:fast`, remains the right scope.

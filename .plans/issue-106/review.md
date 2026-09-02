# Issue 106 peer plan review

Reviewed bound plans:

- Codex: `a60e99434ea6a13f0bebd87cf0714485e7ee0635`
- Cursor: `2c627878ca43664c46fee3a57a5c7c7af1fbb7eb`
- Claude: `20bde887e99d5ffb3ae67fbb392cd8a6663091d2`

Against issue 106 (stdin `EPIPE` from `runTmux` kills the coordinator mid-tick) and
the current implementation at `src/tmux.ts:13-23`.

All three plans stay within the issue: two tracked product files (`src/tmux.ts`,
`test/tmux.test.ts`), no new modules, no run-loop or install-tree churn, and one
focused regression case. Each reuses `runTmux` / `TmuxRunner` / `TmuxResult` and
extends the existing tmux test file. Differences are in stdin-handling semantics,
preventive `stdio` choice, and test technique.

## Findings

### 1. [P1] Codex and Cursor — filtering stdin errors to `EPIPE` only can still abort a tick

**Plan claim:** Codex Risks (lines 63-65) and Cursor Tests optional tightening
(lines 39, 49) branch on `error.code === "EPIPE"` and reject or re-throw every
other stdin error.

**Rule:** After `child.stdin.end(input ?? "")`, any error meaning “the tmux child
is already gone” must be non-fatal; the promise must settle from the existing
`close` handler with tmux’s exit code and captured streams, because
`TmuxController` call sites await `this.runner(...)` and branch on
`exitCode`/`stderr`, not on a rejected promise (e.g. `inspectPane` at
`src/tmux.ts:791-801`, `capturePane` at `833-835`).

**Concrete failure:** The same race that produces `EPIPE` can surface as
`ECONNRESET` or `ERR_STREAM_DESTROYED` depending on timing and Node version. A
stdin handler that re-throws those codes rejects `runTmux`; the awaiting tick
throws before `exitCode` is read, so one bad tmux call still takes down the run
loop—only with a catchable rejection instead of an unhandled stream event. Issue
106 asks that the coordinator log and continue, not merely crash with a different
exception type.

**Smallest correction:** Adopt Claude’s handler shape: `child.stdin.once("error",
…)` appends `error.code ?? error.message` to the `stderr` accumulator and does
not reject; leave `child.once("close", …)` as the sole settler.

### 2. [P2] Cursor and Codex — `vi.mock("node:child_process")` is a new test convention

**Plan claim:** Cursor Tests item 1 (lines 35-35) and Codex Reuse and Scope /
Tests (lines 28-29, 36-40) propose mocking `spawn` with a fake
EventEmitter-shaped child.

**Rule:** New tests should follow patterns already present under `test/` unless
the plan justifies a new one.

**Concrete failure:** No file under `test/` uses `vi.mock` or `vi.spyOn`. A module
mock exercises stub stream wiring, not that `runTmux` calls `spawn("tmux", …)`
with the intended argv and stdio. Claude’s PATH-prepended `#!/bin/sh\nexit 3`
stub reuses the same executable-fixture idiom already in `test/tmux.test.ts`
(e.g. `ensureSession` cases at lines 373-408) and hits the real `spawn` path.

**Smallest correction:** Replace the spawn mock with Claude’s temp-dir stub on
`PATH` plus a write large enough to exceed the pipe buffer; keep assertions on
`exitCode` and recorded stderr.

### 3. [P2] Claude — blanket rejection of `stdio: ["ignore", …]` blocks a smaller preventive fix

**Plan claim:** Claude Alternatives Rejected (lines 124-127) rejects
`stdio: ["ignore", "pipe", "pipe"]` because it “drops the `input` parameter” of
`TmuxRunner`.

**Rule:** Rejected alternatives must not rule out strictly smaller variants that
preserve the public contract.

**Concrete failure:** Cursor’s conditional stdio—`ignore` when `input` is
undefined or `""`, `pipe` only when a payload is present—matches `runArgv`
(`src/runLoop.ts:99-102`) and `runGitCommand` (`src/mirror.ts:48-50`), keeps
`TmuxRunner`’s optional `input`, and removes the empty `end("")` race for every
current caller (grep shows no `this.runner(..., input)` in `TmuxController`).
Following Claude’s blanket rejection leaves a preventable pipe open on every tick
even though the handler alone would survive the crash.

**Smallest correction:** Accept conditional ignored stdin for the no-payload
path; retain piped stdin plus the error handler when `input` is non-empty.

### 4. [P3] Cursor — `pnpm check` omitted from the Tests section

**Plan claim:** Cursor Tests (lines 29-31) names only `pnpm check:fast`.

**Rule:** Plans should name the coordinator’s stricter acceptance suite when it
differs from the pre-commit hook.

**Concrete failure:** Codex Tests (lines 41-44) also lists `pnpm check` for final
acceptance. An implementer who stops at `check:fast` can pass the commit hook
yet fail coordinator verification if e2e or build steps regress. (For this
change the diff is small; the omission is documentation, not a design flaw.)

**Smallest correction:** Add `pnpm check` alongside `pnpm check:fast`, matching
Codex and Claude.

### 5. [P3] Codex — no stderr diagnostic for swallowed stdin failures

**Plan claim:** Codex Conclusion (lines 75-78) handles `EPIPE` silently at the
stream boundary with no mention of surfacing the code in `TmuxResult.stderr`.

**Rule:** Issue 106 asks that a bad tmux call “log and continue”; callers that
throw on failure already interpolate `result.stderr` (`src/tmux.ts:685`, `694`,
`787`, `895`).

**Concrete failure:** Silently swallowing stdin errors makes a subsequent
non-zero `exitCode` harder to diagnose in journal output—the coordinator
continues, but operators lose the “write EPIPE” hint that motivated the issue.
Not a functional regression, but weaker than Claude’s append-to-`stderr` approach.

**Smallest correction:** Record `error.code ?? error.message` into the stderr
accumulator before `close` settles, as Claude specifies.

### Scope, reuse, and tests (cross-plan)

| Criterion | Codex | Cursor | Claude |
| --- | --- | --- | --- |
| Within issue | Yes | Yes | Yes |
| Reuses existing seams | Yes | Yes | Yes — strongest line-level citation |
| Justifies new files | Yes (plan only) | Yes | Yes — explicitly none |
| Focused tests | One mock case | Two mock cases | One PATH-stub case |
| Root-cause analysis | Adequate | Good | Best — ChildProcess vs stdin `error` |

No plan expands scope to `openDarwinTerminalWindows`, run-loop retries, or docs.
No plan proposes an unjustified new file or dependency.

## Conclusion

**Verdict: merge Claude’s production semantics with Cursor’s conditional stdio
and Codex’s acceptance commands; use Claude’s PATH-stub test, not a spawn mock.**

Claude’s plan is the strongest base: it correctly identifies that
`child.once("error", reject)` on the ChildProcess does not cover `child.stdin`,
keeps `close` as the sole promise settler, records stdin failures into the
existing `stderr` buffer for observability, and tests the real `spawn` path with
an idiom the repo already uses. Cursor adds valuable preventive hardening
(ignored stdin when there is nothing to write) that Claude incorrectly rejects.
Codex is the smallest adequate fix but is weaker on diagnostics and names full
`pnpm check`.

Before implementation, revise the chosen plan to: (1) attach a stdin `error`
handler that appends to `stderr` and never rejects, for all stdin error codes,
not only `EPIPE`; (2) use `stdio: ["ignore", "pipe", "pipe"]` when `input` is
absent or empty; (3) implement one PATH-stub regression test in
`test/tmux.test.ts`; (4) run `pnpm check:fast` before commit and `pnpm check`
before coordinator acceptance. No other files are required.

# Issue 154 plan — interactive coordinator controls and turn-boundary guidance

Baseline: `ed813ca97a3646654b0769f4c31849703d43ec5e`.

The issue asks for three things in the foreground runner (`coord <issue>`,
`coord run`, `coord resume --run`): single-key owner controls, inline answering
of owner questions, and `/steer` guidance that is queued durably and delivered
as an advisory `## Owner guidance` section at the next workflow step. The owner
clarification makes all three required, requires strict TTY gating, and
requires that typing directly into any agent's tmux CLI keeps working while the
interactive coordinator runs.

Guidance lifetime decision (the open question in the scope comment): queued
guidance is **bound once** to the next workflow step `(stepId, round)` that
prepares an action, is delivered identically to every agent ordered for that
step (including reissues, rewrites and restarted runners), and **expires** when
a different step binds. Guidance that should persist must be re-entered. This
keeps it advisory and auditable instead of an unbounded standing instruction.

## Exact File List to be changed or deleted

- `src/cli.ts`
  - `runIssue` (line ~910) is the single foreground path shared by
    `coord <issue>`, `coord run` and `resume --run`. It creates an
    `AbortController`, calls `makeRunLoop(paths).run(controller.signal)` and,
    only when the injected terminal input reports `isTTY === true`, starts the
    interactive session from `src/interactive.ts`; the session is always closed
    in `finally`. `detachCompletedIssue` keeps running only after a normal
    return (it already no-ops unless `completed`), so `q` never detaches tmux.
  - `defaultMakeRunLoop`'s `log` routes through a mutable sink so that while the
    session is active, runner log lines are printed through the session's
    log-safe `print` (prompt cleared, line printed, prompt redrawn).
  - `CliDependencies` gains an optional `terminal?: { input; output }` override
    (defaults `process.stdin` / `process.stdout`) so tests inject fake TTY
    streams.
  - The `answer`, `drop`, `pause`/`resume` handlers keep their argument
    parsing, messages and their own `runTick()` calls but delegate the state
    mutation to `src/ownerControls.ts`. No behaviour change for external
    commands.
  - Interactive command callbacks wired here: status (`renderIssueReport` with
    `readStartState`/`readCursorsState`/`readAgentLifecycle`), attach (the same
    `TmuxController.openOwnerAgentClients` + `reportOwnerAgentClients` path as
    `coord attach`), and the owner-control mutations. None of them call
    `runTick()`; the single foreground loop observes the change on its next
    poll.
- `src/state.ts`
  - `cursorsStateSchema` gains
    `ownerGuidance: { pending: GuidanceEntry[], bound: { stepId, round, boundAt, entries } | null }`
    with `.default({ pending: [], bound: null })`, so existing `cursors.json`
    files parse unchanged (no `RUNTIME_FORMAT_VERSION` bump). `GuidanceEntry` is
    `{ id: uuid, text, enqueuedAt }`; `text` is 1–2000 characters, single line,
    no control characters; `pending` is capped (32) so a stuck terminal cannot
    grow state without bound.
  - `journalEventTypeSchema` gains `owner-guidance-queued` and
    `owner-guidance-bound`.
  - Pure helpers next to `setPaused`/`releaseHold`:
    `enqueueOwnerGuidance(cursors, entry, now)`,
    `bindOwnerGuidance(cursors, stepId, round, now)` (returns the input object
    unchanged when `bound` already has that key; otherwise moves `pending` into
    a new `bound` snapshot, replacing and thereby expiring the previous one),
    and `ownerGuidanceFor(cursors, stepId, round)` (bound entries only when the
    key matches, else `[]`).
- `src/runLoop.ts`
  - `applyDecisions`, `prepare-action` branch: before `prepareAction`, if
    `bindOwnerGuidance` would change state, persist it with `this.mutate` and
    journal `owner-guidance-bound` (entry ids, stepId, round). Because every
    agent's `prepare-action` for a step shares the same key, the first one binds
    and the rest see the same snapshot; guidance queued after binding stays
    `pending` until the next step.
  - `buildOrder` sets `ownerGuidance: ownerGuidanceFor(cursors, stepId, round)`.
    `prepareAction`, `rewriteOrderedAction`, `reissue` and the evidence path all
    go through `buildOrder`, so reissues/rewrites/restarts re-render the same
    bound snapshot and never pick up newer pending text.
  - `run(signal)`: the poll `sleep` is raced with the signal's `abort` event so
    `q`/Ctrl-C returns within one tick rather than after `pollIntervalMs`. No
    other change to the loop.
- `src/steps.ts` — `InternalOrder` gains optional
  `ownerGuidance?: readonly string[]` (optional for the same reason the type
  already documents for `contextPaths`/`changeScope`).
- `src/action.ts` — new `ownerGuidanceSection(order.ownerGuidance)` appended
  after `changeScopeSection` in both `renderGitAction` and
  `renderResponseAction`; empty string when absent/empty. The section states it
  is advisory and cannot expand the approved file map, change required
  paths/headings, evidence rules or submission mode. Each entry renders as one
  `- ` bullet; front matter is untouched.
- `test/cli.test.ts`, `test/state.test.ts`, `test/runLoop.test.ts`,
  `test/action.test.ts` — extended (see Tests).
- `README.md` — hotkeys, `/steer` syntax, TTY-only activation, `q` vs
  `coord detach`, and that agent tmux panes still accept direct typing.
- `docs/coord-driver.md` — "Owner controls" section: interactive mode, guidance
  binding/expiry semantics, new runtime field and journal events, interaction
  with holds, pause and owner questions.

No files are deleted.

## Exact file list to be created

- `src/interactive.ts` — the terminal session (justified below).
- `src/ownerControls.ts` — extracted owner mutations (justified below).
- `test/interactive.test.ts` — unit tests for the session with injected streams.

## Reuse and Scope

Reused, not reimplemented:

- State integrity: `mutateCursorsState`, `appendJournal`, `cursorsStateSchema`,
  `StateConflictError`, `setPaused`, `releaseHold`, `replaceCursor`,
  `rederiveAfterDrop`, `invalidateUnpublishedBatches`, `clearAgentLocalWork`
  (all existing, `src/state.ts` / `src/cli.ts` imports). Interactive actions
  use exactly the same locked mutation + journal path as external commands, so
  `coord pause`/`answer`/`drop` from another shell stay race-safe.
- Runner: `CoordinatorRunLoop.run(signal)` already accepts an `AbortSignal`;
  only the CLI wiring and the sleep race are new. `CliRunLoop` type unchanged.
- Status: `renderIssueReport` (`src/issueReport.ts`) for `s`.
- Attach: `TmuxController.openOwnerAgentClients` and `reportOwnerAgentClients`
  — same code path as `coord attach`.
- Order pipeline: `buildOrder`, `renderAction`, `writeAction`; the new section
  follows the existing advisory-section pattern (`repoContextSection`,
  `changeScopeSection`).
- Terminal I/O: Node's built-in `readline.emitKeypressEvents` and
  `setRawMode`; no new dependency.
- Tests: `fakeLoop` and `resolvableStartGit` helpers in `test/cli.test.ts`, the
  workspace fixture in `test/support/workspaceFixture.ts`, and the existing
  `buildOrder`/run-loop fixtures in `test/runLoop.test.ts` and
  `test/action.test.ts` order fixtures.

New files:

- `src/ownerControls.ts`: `answer` and `drop` mutations live inline in
  `runCli` and each ends with its own `runTick()`. The interactive session must
  apply the identical validation (stale question id, hold restriction, final
  agent, authorized reviser, round-4 limit) without starting a second tick
  loop. Extracting `applyOwnerAnswer`, `dropAgent`, `setManualPause`,
  `releaseOwnerHold` and `queueOwnerGuidance` (each: validate + mutate +
  journal, return new state) is the smallest way to share them; leaving them in
  `cli.ts` would force interactive code to import from the CLI module or
  duplicate the checks.
- `src/interactive.ts`: raw-mode key handling, menus, the `/steer` line
  editor, prompt redraw and terminal restoration are a self-contained concern
  with their own lifecycle. Putting them in the already 1.7k-line `cli.ts`
  would make them untestable without driving the whole CLI. It exports
  `startInteractiveSession({ input, output, commands, readQuestion, signal })`
  returning `{ print, close }`, or `null` when `input.isTTY !== true`.

Interactive keys (from the issue): `s` status, `p`/Space toggle manual pause,
`a` attach, `d` numbered drop menu (active roster), `r` numbered hold-release
menu (explicit hold selection; never resets the nudge budget —
`--reset-nudge-budget` stays CLI-only), `/` opens a line editor accepting
`/steer <text>`, `?`/`h` cheatsheet, `q`/Ctrl-C graceful stop. When
`ownerQuestion` changes (checked on each runner log line and a 1 s interval),
the session shows the numbered menu built from `kind` and `allowedAnswers`; a
choice calls `applyOwnerAnswer` with that question id, so a question answered
from another shell first is reported as stale rather than misapplied.

Out of scope: an external `coord steer` command, changes to `issueReport.ts`,
`coord detach`, tmux pane input handling, or any workflow-step semantics.

## Tests

Each case fails on the baseline (missing export, field or behaviour) and passes
after the change.

- `test/state.test.ts` (join "operational state"):
  1. A `cursors.json` without `ownerGuidance` parses to
     `{ pending: [], bound: null }`.
  2. enqueue → `bindOwnerGuidance(R2.plan, null)` moves entries to `bound` and
     empties `pending`; binding the same key again is a no-op; text enqueued
     after binding stays `pending`; binding `R3.plan-ballot` replaces `bound`
     and `ownerGuidanceFor(…, "R2.plan", null)` returns `[]`.
  3. Schema rejects empty, multi-line/control-character and over-length text.
- `test/action.test.ts` ("advisory action sections"): a Git order and a
  response order with `ownerGuidance` both render `## Owner guidance` with each
  entry and the advisory sentence; an order without it renders no such heading;
  `parseAction` front matter is unchanged.
- `test/runLoop.test.ts`:
  1. ("effectful run loop") guidance queued while step A is in flight is absent
     from A's rewritten/reissued action and present in every active agent's
     action for the next step; a new `CoordinatorRunLoop` instance (restart)
     reissuing that step renders the same entries; guidance queued after B is
     bound is absent from B and journaled as queued only.
  2. ("runner waiting and initialization") `run(signal)` with a long
     `pollIntervalMs` and a never-resolving injected `sleep` returns promptly
     after `abort()`.
- `test/interactive.test.ts` (new; injected `PassThrough` input with fake
  `isTTY`/`setRawMode`, captured output, stub commands):
  1. Non-TTY input returns `null` and never calls `setRawMode`.
  2. `s`, `p`, Space, `a`, `?` invoke the matching command once.
  3. `d` then `2` drops the second active agent; `d` then Escape cancels.
  4. `/steer keep Go 1.22 compatibility` + Enter calls `queueOwnerGuidance`
     with that text; `/steer` with no text and unknown `/cmd` print usage.
  5. A `print()` call while a line is being typed clears the prompt, writes the
     log line, and redraws the partial input.
  6. A pending owner question shows the numbered menu; `1` answers with that
     question id; a stale-question error from the command is printed, not
     thrown.
  7. `q`, Ctrl-C, input EOF and a thrown command error each abort the signal
     path once and restore `setRawMode(false)` and remove listeners.
- `test/cli.test.ts` ("CLI"):
  1. `coord run` with default (non-TTY) terminal passes an `AbortSignal` to
     `run` and starts no interactive session.
  2. With an injected TTY terminal, typing `q` makes `runCli` return 0 without
     invoking `detachIssue` and with raw mode restored.
  3. Existing `answer`/`drop`/`pause`/`resume` tests continue to pass unchanged
     (regression for the extraction).

Required commands: `pnpm check:fast` before every commit; `pnpm check` (build +
check:fast + e2e) before submission. Manual smoke in a real terminal: start an
issue, confirm log lines do not corrupt a half-typed `/steer`, `p` toggles pause
visible in `coord status` from a second shell, `a` raises agent tabs, typing
directly in an agent's tmux pane is handled by that CLI while the coordinator
is in raw mode, `q` and Ctrl-C leave the terminal sane and the tmux session
alive, and `coord run` resumes.

## Alternatives Rejected

- **Bind guidance in every transition site** (`advance`, `amendmentTransition`,
  owner `answer` reset, CLI reset): five scattered sites, easy to miss one.
  Binding lazily at the first `prepare-action` for a new key is one site and is
  exactly the "next turn boundary" where `action.md` is generated.
- **Read pending guidance directly in `buildOrder`**: a reissue or the second
  agent's preparation would see text queued after the first agent was ordered,
  giving agents different instructions for the same step.
- **Persistent guidance until cleared**: silently accumulates standing
  instructions across steps; one-step expiry is explicit and re-enterable.
- **Implement `q` via `coord detach`**: it closes tmux/Terminal sessions; the
  issue requires leaving them intact.
- **Calling the existing CLI handlers from interactive mode**: they each call
  `runTick()`, creating a concurrent second tick loop.
- **A full-screen TUI dependency (ink/blessed)**: new dependency for a small
  prompt; built-in `readline` raw mode suffices.
- **Separate `test/ownerControls.test.ts`**: extraction is behaviour-preserving
  and the existing CLI tests already exercise every validation branch; the
  interactive tests cover the no-tick reuse path.
- **Integration test changes**: the run-loop and CLI cases above already cover
  enqueue → bind → render and controls alongside a runner without a second
  heavy fixture.

## Risks and Mitigations

- **Terminal left in raw mode** on crash/signal: `close()` is idempotent and
  runs from `finally` in `runIssue`, from `SIGINT`/`SIGTERM` handlers installed
  only while the session is active, and on input `end`/`error`; tests assert
  `setRawMode(false)` on every exit path.
- **Interactive mode in CI/scripts**: strictly gated on `input.isTTY === true`;
  non-TTY path is byte-for-byte the previous behaviour plus an abort signal.
- **Races with external commands**: every mutation goes through
  `mutateCursorsState`; the runner already treats `StateConflictError` as
  "re-observe next poll".
- **Guidance used to expand scope**: rendered as advisory text stating it
  cannot change file maps, paths, headings or evidence; evidence evaluation does
  not read it.
- **Prompt injection into `action.md` structure**: single-line, control-free,
  length-capped text rendered as a bullet in the body; front matter unchanged.
- **Stale owner question answered**: interactive answer carries the question
  id it displayed and reuses the stale-id check.
- **Direct agent input regression**: raw mode only affects the coordinator's
  own stdin; tmux panes are separate TTYs. Covered by the manual smoke step and
  documented.
- **Older runtimes**: `.default(...)` keeps old `cursors.json` readable; covered
  by a state test.

## Conclusion

Wire `AbortSignal` and an optional TTY-gated interactive session into the one
shared foreground runner; extract owner mutations into `src/ownerControls.ts`
so keys reuse the same locked, journaled validation without a second tick
loop; add a backward-compatible `ownerGuidance` queue that binds once at the
next step's first action preparation and renders as an advisory
`## Owner guidance` section for every agent of that step. Fourteen files
(three new), no new dependencies, validated by focused unit tests,
`pnpm check:fast`, `pnpm check`, and a real-terminal smoke check.

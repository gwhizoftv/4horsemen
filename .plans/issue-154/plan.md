# Issue 154: Interactive mode and turn-boundary owner input for `coord` CLI

## Exact File List to be changed or deleted

- `src/state.ts` — add optional queued owner-guidance field on `cursorsStateSchema` (strict, default empty); add journal event type `owner-guidance-queued` (and clear/consume details on existing `action-prepared` or a dedicated `owner-guidance-consumed` if needed for audit); enqueue/clear helpers used by interactive + run loop
- `src/steps.ts` — optional advisory `ownerGuidance?: string` on `InternalOrder` (same optional pattern as `contextPaths`)
- `src/action.ts` — render advisory `## Owner guidance` when present (omit when empty), mirroring `repoContextSection`
- `src/runLoop.ts` — gate interactive stdin only when TTY; integrate non-blocking key/command handling with `run()` sleep/poll; on `owner-action-required`, print numbered inline prompt using `ownerQuestion` (no pasted UUID); at `buildOrder`/`prepareAction`, copy queued guidance into the order and clear it from `cursors.json` via `mutateCursorsState`; keep using `renderIssueReport`, `setPaused`/`releaseHold`, attach, and drop through shared owner-control helpers
- `src/cli.ts` — extract shared owner-control mutations (answer / pause-resume / drop+rederive) into the new helper module and call them from existing CLI commands so interactive and CLI stay race-safe and identical; wire interactive enablement into `runIssue` / `makeRunLoop` only when `stdin.isTTY`
- `src/tmux.ts` — no behavior change expected; reuse `openOwnerAgentClients` / `reportOwnerAgentClients` for hotkey `a` (touch only if a tiny export is required for the helper)
- `docs/coord-driver.md` — document TTY-only hotkeys, inline owner-question prompts, `/steer` queue semantics, and that `q` stops the foreground runner without detaching tmux/agent Terminals
- `test/state.test.ts` — schema defaults + enqueue/clear guidance mutations + journal types
- `test/action.test.ts` — advisory `## Owner guidance` present/absent rendering
- `test/runLoop.test.ts` — guidance attached on prepare-action then cleared; owner-action-required logging/prompt path still journals `owner-question`; pause idle path unchanged when non-TTY
- `test/cli.test.ts` — CLI answer/pause/drop still pass through shared helpers (regression); non-TTY `coord run` does not install interactive handlers

## Exact file list to be created

- `src/ownerControls.ts` — shared, pure-ish owner mutations used by both CLI and interactive mode: answer `ownerQuestion` (idempotent via `lastOwnerAnswer`), pause/resume (`setPaused` / hold release parity with CLI), drop agent (`dropAgent` + `rederiveAfterDrop` logic moved out of private `cli.ts`), status snapshot string via `renderIssueReport`. Justified: drop/answer logic today is private in `cli.ts` and must not be duplicated for TTY keys.
- `src/interactiveMode.ts` — TTY detection (`process.stdin.isTTY`), raw-mode single-key dispatch (`s` status, `p`/`Space` pause-toggle, `a` attach, `d` drop menu, `q` stop foreground runner, `?`/`h` cheatsheet), line-mode `/steer <text>` enqueue, and numbered owner-question prompt when `ownerQuestion` is set. Justified: no existing raw-mode / readline owner UI in `src/`.
- `test/interactiveMode.test.ts` — unit tests for key dispatch, non-TTY no-op, drop menu selection bounds, `/steer` enqueue, inline answer without UUID; fake stdin/stdout (no real TTY required)
- `test/ownerControls.test.ts` — shared answer/pause/drop helpers match current CLI invariants (holds refuse drop, last-agent refuse, idempotent re-answer)

## Reuse and Scope

Reuse existing `mutateCursorsState` / `requireStateMutation` / `StateConflictError`, `setPaused`, `releaseHold`, `dropAgent`, `appendJournal`, `renderIssueReport`, `holdRecoveryCommand`, `TmuxController.openOwnerAgentClients` / `reportOwnerAgentClients`, `buildOrder` → `writeAction` / `renderAction`, `ownerQuestion` + CLI answer semantics (`retry`|`revise`|`abandon`), and `CoordinatorRunLoop.run` / `RunLoopDependencies.log|sleep|now`. Do not call `detachIssue` for hotkey `q` (issue: leave tmux and background state intact). Do not invent a second control plane: interactive actions must mutate the same `cursors.json` / `journal.jsonl` paths as `coord pause|resume|answer|drop|status|attach`. New files are limited to extracting shared owner mutations and the TTY adapter; no new dependencies.

## Tests

- `pnpm check:fast` (lint, typecheck, fast tests — live `verify.precommit`)
- `test/interactiveMode.test.ts` — non-TTY install is a no-op; `s` prints report text from injected status fn; `p` toggles pause via ownerControls; `d` + digit drops only a listed active agent; `/steer …` appends queued guidance; when `ownerQuestion` is set, `1..n` maps to `allowedAnswers` without requiring the UUID
- `test/ownerControls.test.ts` — answer idempotency / invalid choice; drop refused under holds / last agent (extend fixtures already used in `test/cli.test.ts` rather than inventing a second world)
- `test/action.test.ts` — order with `ownerGuidance` renders `## Owner guidance`; without it, section omitted
- `test/runLoop.test.ts` — prepare-action consumes queued guidance into the written `action.md` and clears cursors; non-TTY run path unchanged
- `test/state.test.ts` — new schema field default + journal enum accepts new type(s)
- `test/cli.test.ts` — existing answer/pause/drop/attach cases still pass after extraction

## Alternatives Rejected

- Separate interactive daemon / second process — issue wants typing into the same foreground `coord run` / `coord <issue>` log stream
- Reimplement pause/answer/drop inside the TTY module — would race and diverge from CLI; must share `mutateCursorsState` helpers
- Call `detachIssue` on `q` — issue explicitly keeps tmux sessions and background state; `q` only stops the foreground runner
- Require pasting the owner-question UUID in the TTY prompt — defeats the in-line answering goal; use `cursors.ownerQuestion` already in memory/on disk
- Mid-turn rewrite of in-flight `action.md` when `/steer` arrives — issue requires turn-boundary processing only (queue now, render on next `prepare-action`)
- Always-on raw mode even when stdin is not a TTY — would break CI/scripts/piped runs; gate on `stdin.isTTY`
- New npm dependency for keypress/readline UI — Node stdin raw mode + small local parser is enough

## Risks and Mitigations

- Raw mode interleaving with phase logs — keep a short dedicated prompt line / restore cooked mode for multi-character menus and `/steer` lines; log via existing `log` callback so tests stay injectable
- Concurrent external `coord pause|answer` while interactive is open — continue using `mutateCursorsState` / `stateRevision` CAS; surface `StateConflictError` as an inline retry message, same as today
- Guidance applied to the wrong agent/step — consume queue only inside `prepareAction`/`buildOrder` for the actions being written in that tick; clear atomically with the same mutation that records prepare
- Accidental drop via hotkey — `d` opens a numbered menu and requires a digit confirm; refuse when CLI would refuse
- Stopping the runner with `q` while a mutation is in flight — finish the current tick’s critical section before exit (same discipline as Ctrl-C/`AbortSignal` handling today)
- Schema strictness — default new guidance field to `[]` so older runtime fixtures in tests keep parsing; bump only the field, not `formatVersion`, unless an existing migration rule requires otherwise (follow `state.ts` precedents for additive defaults)

## Conclusion

Add a TTY-gated interactive adapter on the foreground coordinator run loop that drives the existing owner control plane (status, pause/resume, attach, drop, answer) without leaving the log stream, and queue `/steer` text in `cursors.json` for advisory `## Owner guidance` on the next prepared `action.md`. Non-TTY runs stay unchanged; CLI commands keep working concurrently through the same atomic mutations.

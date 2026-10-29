# Issue 257 implementation comparison

Protocol version: 1. Action: `db0f7dd9-966d-4b3d-9db6-393def39488c`.

## Comparison

Reviewed the coordinator-exported worktrees directly at these product pins:

- Codex: `46c3e3b9ec822f32e882b3d0fc84b014be56e51e`.
- Claude: `0ee801e2ad6838e8eaab800fd5965167da24f419`.

Both implement the selected plan's attended route: opt-in installation, pull
delivery, optional provider/model selection, saved-model preservation, shared
tmux launch/recovery, version-only maintenance, Enter owner reminders, and native
OpenCode permissions. Both support nested OpenRouter identifiers and colon
variants, forward model arguments literally, preserve the default roster, and
document provider setup and restart behavior. Neither introduces credentials,
native hooks, an automatic terminal adapter, or a new dependency.

Both stay within the approved product file map and reuse the existing installer,
launcher template, agent schema, tmux controller, and test fixtures. Codex changes
ten approved product files; Claude changes all eleven. Neither adds a product
file or unrelated refactor. Claude's additional run-loop case reuses
`safetyFixture` to cover pull delivery, a deliberate reminder, and a ready receipt.
Codex keeps the run loop unchanged and extends the existing owner-reminder table;
its schema and transport tests cover more failure boundaries: frozen-state
rejection, manual launches, and actual execution with no configured model.
Codex also tests preservation of an existing native permission file and inherited
`OPENCODE_PERMISSION`; Claude's install test checks that no native config is
created but does not exercise an existing policy.

Executable preference differs: Claude prefers `~/.opencode/bin`, then the shared
search path; Codex preserves the shared Node/PATH preference and adds that directory
as a fallback. Both document and test their choice. This is not a blocker.

## Findings

1. **P2 — Claude, `src/tmux.ts:1192`:** An OpenCode launcher path must remain one
   shell command word whether or not a model is configured. The no-model branch
   returns the unquoted absolute path. For a clone named `clone with 'quote'`, the
   actual command emitted by `startSession` exits 127 when executed by `/bin/sh`:
   it tries to execute the prefix ending in `/clone`. This breaks the explicitly
   supported interactive `/connect` and `/models` route, including relaunches,
   for workspace paths containing spaces. The configured-model branch succeeds
   for the same path. Extend `test/tmux.test.ts:563` to execute the no-model
   command against its existing capture stub and assert exit zero with empty
   argv; currently that case only asserts the unquoted string. The same focused
   reproduction passes with and without a model on the Codex pin.

2. **P2 — Claude, `src/state.ts:326`:** OpenCode's pull-only restriction and the
   OpenCode-only model field must hold when reading frozen issue state as well
   as runtime configuration. These checks exist only in
   `coordinatorConfigSchema.superRefine`; `startStateSchema` consumes the
   unrefined `agentConfigSchema` at `src/state.ts:470`. A snapshot containing
   `opencode` with `delivery: "both"` therefore parses, although the equivalent
   config is rejected. On resume, the run loop uses that frozen delivery value
   (`src/runLoop.ts:2036`), admitting automatic sends through the unmeasured
   generic terminal fallback. A focused test using that parsed agent and a
   synthetic provider-picker capture returned `status: "sent"` from `nudge`.
   A snapshot assigning `model` to `claude` is likewise accepted, and the launch
   expression applies `--model` without checking the agent id. Add rejected
   snapshot cases alongside the existing config cases in `test/state.test.ts`.
   Codex puts the constraints in the shared agent schema and rejects both
   snapshots. This reproduces a persisted-state validation gap; it is not a
   claim that ordinary fresh startup writes an invalid snapshot.

## Verification

Read the existing issue journal's hook observations; no full product suite was
rerun for this comparison. The accepted implementation entries in `cursors.json`
bind the outgoing submissions to the product pins above.

| Pin | Existing verification evidence |
| --- | --- |
| Codex `46c3e3b9` | `pnpm run check:fast` passed, journal sequence 93; `pnpm run test:e2e` passed, sequence 96, outgoing submission `1617dfb5e4a448d516d7805bd03b31e3c829d98e`. Earlier failed attempts precede the successful check. |
| Claude `0ee801e2` | `pnpm run check:fast` passed, journal sequence 101; `pnpm run test:e2e` passed, sequence 103, outgoing submission `275edce2f802b671c0cc64e2f6a3823591010c6a`. |

These are advisory hook records, not coordinator final verification. During this
review I loaded the exact exported TypeScript sources with in-memory compilation
and ran only the focused launcher, schema, and automatic-send reproductions
described above. Launcher fixtures were isolated under `.codex/tmp` and removed;
the bound sources were unchanged. The send check used an injected runner, not a
live OpenCode session. Neither implementation establishes live OpenRouter
authentication or live TUI compatibility, and both disclose that limitation.

## Verdict

Select Codex `46c3e3b9ec822f32e882b3d0fc84b014be56e51e` as the implementation base.
No blocking defect was found in that pin. Claude's pin has two reproduced gaps
in the optional-model launch and frozen-state boundaries; its useful additional
run-loop coverage does not compensate for those failures.

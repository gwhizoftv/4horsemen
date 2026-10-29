# Issue 257 implementation comparison — claude

Bound implementation pins:

- codex `46c3e3b9ec822f32e882b3d0fc84b014be56e51e`
- claude `0ee801e2ad6838e8eaab800fd5965167da24f419`

Both were read from the bound worktrees and compared file by file with plain
`diff -u` between the two checkouts. Both implement the selected codex plan
(`1db91964c3920092fd1a74bd081a0ad6f4e7dc15`).

No product suite was re-run for this comparison. The action lists no
coordinator verification results for either pin, so none are cited. The only
results I have are for my own pin, from its implementation action:

- the five touched test files passed (396 fast + 170 system);
- the pre-commit hook's `check:fast` passed;
- the pre-push checks passed.

## Comparison

### Where they agree

The two pins are behaviourally the same on the core of the plan:

- **Schema.** An optional `model` is allowed only on `opencode`, and `opencode` is rejected unless `delivery: "pull"`. Both accept `:` variant suffixes, which the plan review raised as F3.
- **`buildWorkspaceConfig`.** Generates `pull` for `opencode`, keeps a saved model, and clears it when the field is removed.
- **Owner-UI defaults.** Prelude `[]`, submit `["Enter"]`, profile `Basic`, and the label "OpenCode".
- **`vimInsertPrelude`.** Excludes `opencode` with an identical change at `src/tmux.ts:358`.
- **Launch.** A quoted `--model` is added at `launchAgent`, which is shared by start, manual sessions and dead-pane recovery.
- **Launcher.** Executable lookup includes `~/.opencode/bin`; `OPENCODE_DISABLE_AUTOUPDATE=1` is exported; argv is forwarded with no `--add-dir`, sandbox or approval flags; `OPENCODE_PERMISSION` and native config are left untouched.
- **`agentExecutables`.** Version-only, with a skip message that no longer claims OpenCode has no updater.

**Scope and reuse.** Neither pin adds a file, dependency or abstraction, and both stay within the approved map. codex changes 9 product paths, claude 11; the extra two are `test/runLoop.test.ts` and its run-loop case. Both reuse `agentOwnerUiDefaults`, `shellQuote`, `launchAgent`, `write_launcher`, and the existing install, cli, state and tmux fixtures.

### Differences, ranked

#### C1 — claude `src/tmux.ts:1192`: the launcher path is quoted only when a model is set (favours codex)

**Rule.** The command handed to `respawn-pane` is run by a shell, so every operand must be quoted, including the launcher path.

**Failure.** For an `opencode` agent without `model`, the claude pin passes the raw launcher path. A clone whose path contains a space or `'`, as in the claude pin's own install fixture `home with spaces`, is split by `/bin/sh`, and the OpenCode pane exits at launch. The codex pin quotes `[launcher, …model]` for `opencode` in every case. Its test runs the captured command through `/bin/sh` for start, manual and dead-pane recovery, with and without a model, from a root named `coord-opencode's launch-…`.

This is pre-existing behaviour for every other agent, so it is not a regression in the claude pin. It is still a gap on the one launch path the issue touches.

**Illustrative test.** The codex `"passes OpenCode model arguments literally on %s"` case with `model: undefined` fails on the claude pin.

#### C2 — claude `scripts/lib/launcher.sh:45`: `~/.opencode/bin` is prepended ahead of the owner `PATH` (favours codex)

**Rule.** The selected plan says to resolve OpenCode "under the user's .opencode/bin, without replacing product Node/PATH behavior". An installation the owner chose on `PATH` (npm, Homebrew) must not be silently shadowed.

**Failure.** Take an owner who upgraded OpenCode through Homebrew but still has an old install-script copy in `~/.opencode/bin`. The claude pin launches and records the old binary: `coord start` and the pane agree with each other, but both disagree with the owner's `opencode --version`. The codex pin, at `scripts/lib/launcher.sh:43`, appends `~/.opencode/bin` as a fallback, and its install test asserts that a `PATH` copy wins when present.

**Illustrative test.** Put stubs in both a `PATH` directory and `~/.opencode/bin`, then assert the launcher executes the `PATH` stub.

#### C3 — codex `src/state.ts:212`: the model regex admits empty path segments (favours claude, low)

**Rule.** The selected plan says to "reject … malformed provider/model values". The configured value is the only pre-launch check before OpenCode parses `--model`.

**Failure.** `^[A-Za-z0-9][A-Za-z0-9._-]*\/[^\s\p{Cc}]+$` accepts `openrouter//x` and `openrouter/x/`. These values pass `coordinatorConfigSchema`, freeze into the start state, and only fail when OpenCode starts in the pane. The claude pin requires every `/` segment to be non-empty and rejects both.

**Illustrative test.** Add `"openrouter//x"` and `"openrouter/x/"` to the codex reject table in `test/state.test.ts`.

#### C4 — codex omits the selected plan's Tests item 5 (`test/runLoop.test.ts`) (neutral)

The claude pin adds one run-loop case:

- a frozen pull OpenCode agent gets no automatic send across ticks, before and after a `ready` receipt;
- a `reminders()` selection sends exactly `renderNudgeText(...)` once.

On the baseline this fails, because the vim `a` prelude prefixes the sent text. The codex pin covers the same key behaviour at the `TmuxController.remind` level, in its extended vendor `it.each`. That check also proves custom `nudgePrelude`/`nudgeSubmit` are preserved.

Both prove the owner-reminder keys. The claude case additionally proves the run-loop wiring; codex's omission follows the plan review's advice (F4) more than the plan text.

#### C5 — coverage breadth (favours codex)

- **Launch tests.** The codex launch test covers three entry points with and without a model, and a model carrying `'$(touch …)"` and `:free`. The claude test covers two entry points, with a model.
- **Install tests.** The codex install test also asserts the following; the claude install test checks only the first, through `PATH`-only discovery:
  - an inherited `OPENCODE_PERMISSION` reaches OpenCode unchanged;
  - an existing `~/.config/opencode/opencode.json` is byte-identical afterwards;
  - no `opencode.json` is written into the clone;
  - the product worktree stays clean.
- **Start-state validation.** The codex pin validates delivery at the `agentConfigSchema` level, so a hand-edited frozen start state is also rejected; its test covers this. The claude pin validates only at config level, like the existing `codexQuota` rule.

#### C6 — documentation (equivalent)

Both document the same points:

- opt-in `--agents`;
- in-pane `/connect` and `/models`;
- the runtime `model` field with an example, copied from `opencode models openrouter`;
- precedence and freezing, and direct-launcher `--model`;
- owner delivery through `coord next` or the reminder menu;
- interactive permissions;
- unverified hooks and containment;
- no live OpenCode or OpenRouter verification.

Each pin's docs match its own `PATH` order; see C2.

**Verdict for selection.** Prefer codex `46c3e3b9ec822f32e882b3d0fc84b014be56e51e`. It satisfies the plan's `PATH`-preservation wording (C2), quotes the launcher on every OpenCode launch (C1), and has broader tests that keep owner settings intact (C5). The only point in claude's favour is C3, which is low severity: tightening the reject cases is a one-line regex change plus two table entries, which a revision can absorb. The claude pin's run-loop case (C4) is optional extra coverage, not a reason to select it.

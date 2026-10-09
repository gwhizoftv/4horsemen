# Issue 186 — reliable Codex submission and issue-scoped shell context

Protocol version: 1. Planning action: `4b16949a-e895-4f65-ab8b-c967f500fc3d`.
Baseline: `15c2973d02e848cc537efd8e7bf9acc56c0304ee`.

## Issue context and observed evidence

Re-read the live [issue 186](https://github.com/gwhizoftv/coordination/issues/186)
after the owner added item 3. Scope includes the unsent Codex composer, repeated
`delivery-uncertain` holds, and stale issue-139 containment/lifecycle context.
The frozen issue snapshot predates item 3; the owner explicitly requested its
inclusion. Do not change the frozen automation digest to match the edited issue.

Earlier readiness-stage observation, included as requested:

> The action digest matches and the branch is issue-186/codex. The containment
> probe was blocked by the hook, but its message referenced issue 139; recording
> the observation failed with “session or installed policy unknown.” Containment
> remains unverified. I’ll continue with the readiness artifact as instructed.

That quote describes the completed readiness action, not this planning action.
During planning, the actual shell reported `COORD_ISSUE=139`, while
`tmux show-environment -t coord-186 COORD_ISSUE` reported 186. A local Codex
shell snapshot contains `declare -x COORD_ISSUE="139"`. Issue 186's Codex lifecycle
entry has a null session and no hook receipt. This supports a stale child/shell
context diagnosis; it does not prove the shared app-server needs restarting.
The installed CLI reports `codex-cli 0.162.0`, with `shell_snapshot` enabled.

The source has two relevant delivery gaps: `i` is suppressed outside vim NORMAL
only for override sends, and post-key composer/acceptance checks also only run
on override sends. The default sequence is `C-j`, then `C-m`; override delivery
can stop between those keys, while ordinary delivery reports success without
checking submission. A tmux write is not proof that the TUI submitted the text.

## Exact File List to be changed or deleted

Change only these existing product files; delete none:

1. `src/tmux.ts` — unify Codex composer/mode safeguards across ordinary,
   ready-file and sentinel delivery; implement bounded CR submission with
   positive confirmation and no text replay.
2. `src/setupWorkspace.ts` — change the Codex default submit key from the
   two-key sequence to a single `C-m`; keep the existing default helper and
   other vendors' defaults.
3. `src/runLoop.ts` — supply current-action lifecycle acceptance/change
   observations to ordinary Codex delivery as well as overrides, without
   granting ordinary sends stale-working override authority.
4. `scripts/lib/launcher.sh` — make coordinator-managed automated Codex launches
   disable shell snapshots and explicitly bind the child command environment
   to the launch issue; preserve manual mode, other vendors and narrow grants.
5. `src/shellGuard.ts` — distinguish an explicit probe's issue/environment
   mismatch from missing lifecycle session and missing installed policy, with
   actionable diagnostics; do not weaken or reroute the guard.
6. `config.example.json` — align the shipped Codex submit example with `C-m`.
7. `docs/coord-driver.md` — document the mode-aware CR delivery, confirmation
   boundary, legacy-key handling, and fresh issue-scoped Codex launch/recovery.
8. `test/tmux.test.ts` — extend the existing Codex pane and nudge tests.
9. `test/runLoop.test.ts` — extend durable-delivery tests for confirmed Codex
   submission versus genuine uncertainty.
10. `test/install.test.ts` — extend existing generated-launcher execution and
    default-config assertions, including automated and manual Codex cases.
11. `test/cli.test.ts` — extend containment-probe diagnostics/recording coverage.

## Exact file list to be created

Only `.plans/issue-186/plan.md`, the coordination artifact required by this
action. No new product files, test files, fixture files, dependencies, or state
formats are needed. Later implementation evidence is governed by its own action.

## Reuse and Scope

### Codex delivery

Reuse `TmuxController.nudge`, `injectionGate`, `capturePane`, the injected
`TmuxRunner`/sleep functions, `resolveNudgeKeys`, `agentOwnerUiDefaults`,
`codexTail`, `codexComposerEmpty`, `codexComposerHolds`, `codexVimNormal`, and
`codexNudgeSubmitted`. Keep helpers local to the existing module; no transport
framework or vendor-adapter hierarchy.

- Recognize an empty Codex composer before *every* delivery path can type.
  Preserve foreground, copy-mode, input-off, trust-dialog, live-turn and owner
  draft vetoes. Check again before each side effect. Use the existing ready
  receipt/sentinel rules only when they actually authorize an override.
- Send the conventional `i` prelude only with positive current vim NORMAL
  evidence, including the ordinary first send. Never prepend it in INSERT or
  a non-vim composer. Honor an explicit empty prelude and retain genuine custom
  configurations rather than silently replacing all keys.
- Use `C-m` as the default submit key. Normalize only the known legacy default
  pair `["C-j", "C-m"]` to `C-m` when resolving old frozen issue configs; do not
  mutate start.json or the owner's live configuration. Single Enter/C-m remain
  valid. Explicit unrelated submit overrides retain their configured meaning.
- After literal text delivery, wait for the rendered composer to contain the
  complete current nudge instead of treating one transient repaint as an owner
  edit. Bound this observation to ten 100 ms waits. A recognizable conflicting
  draft/activity or changed authority aborts immediately; empty/unavailable
  captures never authorize a key. Exhaustion after any write remains uncertain.
- Send one CR, then observe for at most ten 100 ms waits. Successful transport
  confirmation is either a newly correlated lifecycle acceptance for the exact
  action UUID/digest/session, or a newly rendered exact user transcript message
  plus an emptied composer. Compare against the pre-send capture so old
  scrollback cannot count; do not require the word `Working`, since the CLI can
  move to tool activity or finish before a capture. This does not fabricate
  lifecycle acceptance or workflow completion.
- If CR was not accepted and the same unchanged, fully rendered nudge is still
  in the idle composer after that bounded window, permit **one** additional
  `C-m`, with all gates rechecked, then the same bounded confirmation window.
  This fallback is only for the default/known legacy CR route. Never retype the
  message, submit an edited draft, press Escape into a running turn, or send
  further keys after confirmation. Genuine uncertainty still returns a
  mid-send refusal and retains the existing hold.

Reuse the run-loop lifecycle snapshot, hook receipt sequence, action UUID/digest
checks, `readyForNextAction`, reservation callback, `markActionInjected` and
existing hold path. Separate observation of acceptance from permission to
override lifecycle readiness: passing an acceptance callback to ordinary Codex
delivery must not implicitly require a sentinel or permit a stale-working send.
Keep one durable send charge for the attempt, including its bounded CR fallback.
Do not clear old reservations/holds automatically, extend the resend budget, or
make elapsed time authorize a duplicate action.

Official OpenAI documentation shows Enter/Ctrl-M as composer submit bindings and
allows customization; it does not establish that every installation treats
Ctrl-J as submit. This plan therefore avoids an unconditional Ctrl-J step.
[TUI keymap documentation](https://learn.chatgpt.com/docs/config-file/config-basic#tui-keymap)

### Issue-scoped launch context and diagnosis

Reuse `launcher_command`/`write_launcher`, the launcher grant array, the existing
issue-specific tmux launch lifecycle and `recordContainmentProbe`/`runtimeFor`.
Do not add a global server supervisor or a new runtime identity registry.

- For automated Codex launches with a valid launch issue, add
  `--disable shell_snapshot` and a per-launch config override setting
  `shell_environment_policy.set.COORD_ISSUE` to that validated issue string.
  Use shell-array argument handling compatible with macOS Bash 3.2. These are
  launch settings, not edits to user-global configuration or cached snapshots.
  Preserve the existing workspace-write policy and exact add-dir grants.
  No such automated binding is added to owner-driven manual launches.
- The installed CLI exposes the snapshot feature and `--disable` switch.
  The supported environment-set configuration is documented by OpenAI;
  applying it to this snapshot symptom is a proposed mitigation to verify, not
  a claim that an argv-only unit test proves runtime containment.
  [Shell environment policy](https://learn.chatgpt.com/docs/config-file/config-advanced#permissions-and-sandbox)
- Newly launched issue panes must use fresh issue-scoped harness processes.
  Existing live panes are not killed by `ensureSession`, and changing tmux's
  environment is not claimed to update their children. Document that installing
  this fix requires the owner to finish/preserve current work and relaunch the
  affected Codex harness via the corrected launcher, then repeat the prescribed
  containment probe. Do not restart a shared app-server automatically every
  issue: other work may depend on it, and the observed fault is narrower.
- On `containment-probe --issue N`, report inherited issue M (or missing issue),
  requested N, and the fresh-launch guidance when they disagree, even if no
  lifecycle session is recorded. Also distinguish absent session from absent
  installed policy. Preserve existing evidence semantics: mismatched environment
  cannot make shim coverage active; no synthesized session, hook receipt,
  denial, or successful observation. Failed prerequisites must not publish a
  misleading probe mailbox or alter the owner runtime.

No changes to action routing based on branch names, no redirecting old issue
events into a new issue, no hook-trust bypass, and no edits to installed hooks,
AGENTS.md, `.git` configuration, or the product `githooks/` tree are planned.
If launch-time isolation does not correct actual hook/tool identity, capture
that failure and request a scoped plan amendment rather than claiming success
or expanding into app-server lifecycle management silently.

## Tests

Use existing fixtures, not a new test harness:

1. In `test/tmux.test.ts`, extend `codexPane`/`codexComposer` and the stateful
   nudge runner with a compact table for ordinary, ready-file and sentinel
   sends. Assert no literal `i` in INSERT/non-vim, exactly one `i` in NORMAL,
   legacy-pair normalization, delayed draft repaint, first-CR success without
   `Working` chrome, and one ignored CR followed by exactly one successful
   fallback. Add adversarial rows for an edited draft, unrelated lifecycle
   activity, stale transcript acceptance, unavailable captures and a stuck
   composer. Assert the exact emitted keys and bounded observations, not merely
   `status: sent`. Several ordinary-path and delayed-submit rows fail today.
2. In `test/runLoop.test.ts`, extend `safetyFixture` and the existing durable
   delivery group: current-action acceptance during normal/override submission
   releases that attempt's reservation without a hold or duplicate text; a
   true partial send still holds across restart. Preserve changed-authority,
   wrong-digest/session, ready-receipt and four-send-budget negative coverage.
3. In `test/install.test.ts`, extend the existing `/bin/bash` launcher/stub-CLI
   test to assert automated Codex arguments bind the requested issue and disable
   snapshots without widening grants, while manual Codex and other vendors stay
   unchanged. Check generated defaults and the known legacy-key resolution.
   The required automated flags are absent before the change.
4. In `test/cli.test.ts`, extend the existing containment-probe test with
   environment 139/requested 186 and missing-session/missing-policy cases.
   Assert precise diagnostics, no false active coverage and no writes on failed
   prerequisites; retain the matching-session observation/ingestion tests.

Focused development commands, using the actual configured test tiers:

```sh
pnpm exec vitest run --config vitest.config.ts test/tmux.test.ts test/runLoop.test.ts
pnpm exec vitest run --config vitest.system.config.ts test/install.test.ts test/cli.test.ts
```

Before claiming item 3 fixed, verify an owner-authorized fresh, disposable Codex
launch under the installed version: shell environment, native hook observations,
and containment probe all target the new issue even when an old snapshot
contains 139. Verify two consecutive action submissions and a subsequent issue
launch, including receipt/session identity, without touching a shared running
server. Record the actual version/results; if this smoke check cannot be run,
report the limitation and do not substitute the launcher stub as proof.

For this plan-only action, validate headings, non-empty bodies, exact file scope
and bound action digest; do not run the product suite. For implementation,
the product hook owns `pnpm check:fast` (currently lint, typecheck, fast and
system tests); do not manually duplicate it immediately before commit.
The frozen coordinator check is `pnpm run check`, including build and e2e.
Report coordinator results as coordinator-owned, never as locally run checks.

## Alternatives Rejected

- More unconditional Enter/Ctrl-J/Ctrl-M presses or a much longer blind sleep:
  these can submit twice, interrupt work, or still report an unsent draft as sent.
- Removing `delivery-uncertain` holds or clearing reservations on timeout: that
  hides genuine partial sends and authorizes duplicate work after a crash.
- Replacing the whole TUI delivery mechanism with app-server RPC: much broader
  than this issue and introduces another authentication/session lifecycle.
- Restarting a global app-server on every issue, deleting shell snapshots, or
  modifying the owner's global Codex config: avoid collateral effects; isolate
  the managed launch instead and verify whether a fresh process fixes the fault.
- Guessing an issue from the checked-out branch or the newest runtime and
  rewriting lifecycle/containment records: masks the stale process and risks
  accepting events from the wrong issue/session.
- Editing generated start scripts or product git hooks directly: the launcher
  template is the single maintained source; runtime artifacts are not this plan.

## Risks and Mitigations

- **Duplicate or foreign input:** require a stable exact composer and unchanged
  authority before the sole CR fallback; current acceptance stops all later keys.
  Keep crash reservations and owner-released holds intact.
- **TUI drift/custom keymaps:** exercise real ANSI/wrapped pane fixtures and
  preserve explicit custom keys. Unknown layouts refuse safely rather than
  infer acceptance from a status word or tmux exit code alone.
- **False uncertainty from asynchronous paint:** use bounded observation before
  classifying a transient redraw, with no unbounded retries or repeated text.
- **Snapshot/child environment differs by CLI version:** pin the observed version
  in smoke evidence; test actual hook/tool identity after a fresh launch.
  Disabling snapshots may add shell startup latency, scoped to automated Codex.
- **Existing processes remain stale:** make the limitation and owner-controlled
  relaunch explicit. A matching tmux session variable or installed hook is not
  a verified child environment or successful containment measurement.
- **Scope creep:** no state schema, version bump, dependencies, unrelated cleanup
  or new product files. Additional necessary paths require a plan amendment.

## Conclusion

Fix the Codex send path rather than suppress its safety signals: mode-aware
typing, a real CR, bounded positive confirmation, and no duplicate text. Isolate
the issue's managed Codex shell context at launch, diagnose stale identity
accurately, and require fresh-process evidence before declaring the containment
symptom resolved. This action publishes only the plan, not a live restart or
product implementation.

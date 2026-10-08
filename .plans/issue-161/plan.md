# Issue 161: Interactive coord CLI operator UX

Make the foreground `coord` session readable and operable for an owner who does
not know internal terms (lifecycle, sentinel, pin, nudge-loop). Cover the twelve
issue points with the smallest display, help, logging, and control changes;
keep workflow gates and hold policy unchanged unless a control cannot work
without the existing `--reset-nudge-budget` rule.

## Exact File List to be changed or deleted

- `src/issueReport.ts` — wrap `renderIssueReport` with leading/trailing `----`;
  add a one-line good-vs-needs-attention cue; humanize hold/recovery lines
  (cause/reset, nudge-loop, pin, retry owner); include `--coord-root` (from
  `start.coordRoot`) on recovery `coord resume …` lines; map delivery
  `ordered`/`injected`/`accepted` to turn-related owner labels while keeping
  stored enum values unchanged; clarify Policy / Implementation pin / Final pin
  wording for owners.
- `src/interactive.ts` — empty CR redraws the prompt; unknown keys echo and
  print `unknown command '…'` plus verbose help; expand `help` to full-sentence
  control descriptions; add `n` (re-nudge) to the control set; for nudge-loop
  holds, interactive `r` confirms then releases with budget reset (same rule as
  CLI `--reset-nudge-budget`).
- `src/cli.ts` — wire new `InteractiveCommands` methods (`nudge` / budget-aware
  hold release); wrap interactive status with the same `----` framing if the
  report helper does not already; expand top-level `--help` user-facing
  “product” prose to “repository” (keep the `--product` flag name); document
  `/steer`, pins, and resume recovery in help where owners already look.
- `src/ownerControls.ts` — add a thin `requestOwnerNudge` (or equivalent) that
  re-arms one delivery/nudge attempt for outstanding actions without clearing
  agent work the way `restart-action` does; ensure interactive hold release can
  pass `resetBudget: true` for `nudge-loop`.
- `src/runLoop.ts` — friendlier `DEFERRAL_RATIONALE` / hold announcement text
  (actionable: problem or wait; what the owner can do); stdout progress when
  accepting `complete`, starting verification, and publishing/pushing; at
  `initializeEffects` (or first tick of a run), inspect each agent’s lifecycle
  hooks and print a visible warning when hooks are missing/untrusted/wrong
  issue; raise a visible warning when an agent still has no Stop/acceptance
  after N correlated send/observe cycles instead of waiting silently.
- `src/workspace.ts` — user-facing errors that say “product” → “repository”
  (and “onboarded repository”); keep `--product` as the flag name.
- `docs/coord-driver.md` — owner glossary/control docs aligned with the new
  status language, `n`, empty-CR/unknown-command behavior, recovery lines that
  include `--coord-root`, and repository wording in help prose.
- `test/issueReport.test.ts` — delimiters, cue, humanized holds/recovery with
  `--coord-root`, delivery label mapping.
- `test/interactive.test.ts` — empty CR, unknown key, verbose help, `n`,
  nudge-loop `r` with budget reset confirm.
- `test/cli.test.ts` — help/repository wording; interactive wiring for nudge /
  budget-aware release; recovery strings if asserted via CLI status.
- `test/runLoop.test.ts` — progress logs on complete/verify/publish paths;
  start-of-run hook preflight warning; “no Stop/acceptance after N” warning
  (extend existing fixtures; do not revive deprecated observability APIs).
- `test/doctor.test.ts` — only if start preflight reuses doctor findings and
  needs a narrow assertion; otherwise leave unchanged and assert via runLoop.

## Exact file list to be created

- `.plans/issue-161/plan.md` — this plan (coordination artifact only).

No new product modules: humanize helpers live next to `renderIssueReport` /
`holdRecoveryCommand` in `issueReport.ts` (or small private helpers in the same
file). Hook preflight reuses `inspectAgentLifecycleHooks` / doctor finding
shapes already in `src/agentHookSync.ts` and `src/doctor.ts`.

## Reuse and Scope

Reuse:

- `renderIssueReport`, `holdRecoveryCommand` (`src/issueReport.ts`) for all
  status/recovery wording and `--coord-root` on recovery commands.
- `startInteractiveSession`, `InteractiveCommands` (`src/interactive.ts`) for
  CR / unknown-key / help / `n` / confirm-on-release.
- `setOwnerPause` / `releaseHold` path (`src/ownerControls.ts`, `src/state.ts`)
  for nudge-loop budget reset; do not weaken `releaseHold`’s mutual-exclusion
  rules.
- `inspectAgentLifecycleHooks` (`src/agentHookSync.ts`) and, if convenient,
  `doctor` / `renderDoctorReport` / `DOCTOR_CODES` (`src/doctor.ts`) for start
  preflight — call from `initializeEffects` or `runIssue`, do not duplicate
  install inspection.
- `decideLifecycleNudge` / action-safety send accounting (`src/agentLifecycle.ts`,
  `src/runLoop.ts`) for re-nudge: re-arm a send, do not call `restart-action`
  (that clears local work and would destroy an uncommitted draft).
- `describeWorkflowStep` (`src/steps.ts`) already used in interactive status.
- Existing fixtures in `test/interactive.test.ts`, `test/issueReport.test.ts`,
  `test/cli.test.ts`, `test/runLoop.test.ts`.

Out of scope / not changing:

- Renaming the `--product` flag (help/errors say “repository”; flag stays).
- New “advance turn / complete turn” interactive command (issue point 5 —
  do not overcomplicate; owners use status + `n` / hold release / CLI resume).
- Agent-facing `action.md` language (`agentLanguage.ts` banned terms stay).
- Hold policy, send budget of 4, or requiring `--reset-nudge-budget` for
  nudge-loop (interactive `r` must still satisfy that rule via confirm).
- `githooks/` tree, version bumps, unrelated cleanup.

## Tests

Coordinator/product verification for implementation commits is `pnpm check:fast`
(hook-owned at commit). Focused cases to add or extend:

- `test/issueReport.test.ts` — report begins and ends with `----`; healthy vs
  needs-attention cue; hold lines explain nudge-loop / cause / reset / retry
  owner in plain language; recovery includes `--coord-root <start.coordRoot>`;
  delivery shown as turn-related labels (issued / typed into pane / accepted)
  not raw enum-only jargon.
- `test/interactive.test.ts` — `\r` alone redraws prompt; unknown character
  echoes and prints unknown-command + help; `?`/`h` show full-sentence help
  including `n` and `/steer`; `n` invokes the wired nudge command; releasing a
  `nudge-loop` hold via `r` confirms and calls budget reset.
- `test/cli.test.ts` — `--help` (and workspace error paths if asserted) say
  “repository” not “product” in owner prose; foreground session exposes nudge
  / budget-aware release.
- `test/runLoop.test.ts` — accepting complete / verification / publish emit
  owner-visible progress lines; missing lifecycle hooks at start warn once;
  prolonged missing Stop/acceptance warns instead of silent wait.

No new test files unless an existing suite cannot host a case without becoming
unreadable; prefer extending the four files above.

## Alternatives Rejected

- New `src/statusLanguage.ts` module — helpers fit in `issueReport.ts`; a new
  file is unjustified for string maps.
- Map interactive `n` to `restart-action` — clears agent work and would delete
  the uncommitted draft that motivated the control.
- Interactive “advance/complete turn” key (point 5) — issue says not to
  overcomplicate; status + re-nudge + hold release cover the stuck cases.
- Drop `--reset-nudge-budget` for interactive `r` — would bypass the intentional
  send-budget safety; confirm + resetBudget keeps the rule.
- Default omitting `--coord-root` by changing global CLI resolution only —
  recovery text must still print a pasteable command; include
  `start.coordRoot` on the recovery line (owners may also use `--product` from
  an onboarded worktree; document both, emit `--coord-root` from known start
  state).
- Rename `--product` flag to `--repository` — breaks existing scripts; prose
  change is enough.
- Revive deprecated `markObservabilityDegraded` for Stop-hook warnings —
  emit explicit owner warnings from runLoop/preflight instead.

## Risks and Mitigations

- Friendlier copy drifts from docs — update `docs/coord-driver.md` in the same
  change set; keep internal enum/field names in code and journals unchanged.
- Re-nudge could spam tmux sends — re-arm at most one nudge path per `n`
  invocation and still respect holds / dead panes; surface the same deferral
  rationale when a send is refused.
- Start hook preflight false positives on slow vendors — warn, do not block
  `run`; reuse install inspection codes owners already see from `coord doctor`.
- Progress logs add noise under `-v` — keep default lines few and phase-like
  (complete accepted, verification started/finished, push/PR); leave tick spam
  behind `--verbose`.
- Interactive confirm for budget reset may surprise muscle memory on `r` —
  only require confirm when `reason === "nudge-loop"`; other holds keep today’s
  one-shot release.

## Conclusion

Issue 161 is an owner-facing CLI clarity pass: status framed and labeled so
good vs needs-intervention is obvious, recovery commands pasteable with
`--coord-root`, interactive prompt livelier (CR, unknown keys, verbose help,
`n`, budget-safe hold release), start-time hook warnings, and progress lines for
long coordinator work — without new workflow gates, without renaming
`--product`, and without a speculative “advance turn” control.

# Issue 193: manual implementation plan

Work on `issue-193/codex`, based on `origin/main`, without coordinator actions,
ballots, signals, or completion markers.

## Exact File List to be changed or deleted

- `src/setupWorkspace.ts`: use Enter in the shared Codex onboarding defaults.
- `config.example.json`: show the same default.
- `src/tmux.ts`: normalize old Codex submit defaults to Enter; send literal text
  and real submit keys in one tmux command batch for Codex, Claude, and Cursor;
  remove Codex composer polling and fallback submits. Preserve AGY delivery.
- `src/agentLifecycle.ts`: retain valid Stop readiness despite background work,
  with session/turn checks and invalidation on new foreground activity.
- `src/runLoop.ts`: use Stop readiness without terminal idle confirmation;
  reconcile matching submission hooks and late delivery-uncertain holds.
- `test/tmux.test.ts`: replace obsolete polling/retry expectations with batch,
  literal-text, real-key, and pre-send guard coverage.
- `test/agentLifecycle.test.ts`: exercise Stop, background work, stale turns,
  and subsequent foreground activity.
- `test/agentEvent.test.ts`: cover vendor Stop normalization through readiness.
- `test/runLoop.test.ts`: cover immediate/late submission acknowledgment,
  unmatched hooks, preserved holds/budgets, and Stop-driven delivery.
- `test/onboard.test.ts`: assert generated Codex config contains Enter.
- `docs/readiness-policy.md` and `docs/coord-driver.md`: document the new
  delivery and hook precedence.

## Exact file list to be created

- `docs/issue-193-plan.md`: this owner-requested plan and file map, with final
  verification evidence. No new product files or dependencies.

## Reuse and Scope

Reuse `agentOwnerUiDefaults`, `resolveNudgeKeys`, `renderNudgeText`,
`injectionGate`, lifecycle action correlation, `markActionInjected`, durable
action safety and hold state, and the existing tmux/lifecycle/run-loop fixtures.
Keep pause, ownership, process, copy-mode, send-budget, and workflow-completion
checks. A successful tmux write remains injection, never confirmed submission.
AGY does not acquire a new prompt-submit-hook requirement.

## Tests

Run focused Vitest files as development proceeds. The installed commit hook
owns `pnpm check:fast`; run `pnpm build` and `pnpm test:e2e` for full acceptance.
Exercise the real Codex composer in an isolated tmux session if this execution
environment permits it; report any live-test restriction explicitly. Inspect
the staged diff, commit with `Codex: `, and push the branch to origin.

## Alternatives Rejected

Do not append the letters Enter to literal text or replace the key event with a
newline. Do not use pane paint or Working text as submission acknowledgment.
Do not retry a potentially submitted prompt just because a hook is delayed.

## Risks and Mitigations

Batch delivery removes intervention between text and submit: validate authority,
pane/process state, and any readiness proof immediately before the batch.
Keep key events separate from literal text within the batch. Late hooks must
match the current action, digest, session, and attempt before releasing only
the corresponding uncertainty hold. Stop must not let stale sessions or older
turns authorize delivery. Record background work as telemetry without letting
it veto a current Stop.

## Conclusion

Implement the issue and owner clarifications as a reviewable manual branch,
preserving AGY's functioning path and documenting actual verification results.

## Verification evidence

- `pnpm build`: passed.
- `pnpm test:e2e`: passed (2 tests).
- Focused transport, lifecycle, vendor-hook, and run-loop regression tests were
  run during development, including hook-before-transport-return and delayed
  acknowledgment cases. The commit hook runs the complete `pnpm check:fast`.
- Live Codex composer validation is **not verified**: installed CLI is
  `codex-cli 0.162.1`, but this execution environment rejects both existing tmux
  socket access and creation of a separate test socket (`Operation not
  permitted`). Before release, exercise an isolated live Codex composer with
  the exact batch, verify one complete intended prompt in `UserPromptSubmit`,
  and verify one submitted turn. Automated tmux-runner tests establish command
  construction, not real composer acceptance.

The working branch is in a temporary checkout because this session grants only
read access to the supplied workspace's `.git`. The temporary checkout retains
its installed Git hook scripts and configuration; no hooks are bypassed. Its
Node 26/pnpm 11 dependencies were installed offline from a copied local store
with the frozen lockfile.

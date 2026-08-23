# Issue 96: Fix coordination setup so worktree bit on AGENTS.md is not a problem

## Scope

Implement [issue #96](https://github.com/gwhizoftv/coordination/issues/96) from
`origin/main` at `509748020eeec09acbbb5fb333efdf6db4b945de`.

Each agent clone carries a managed protocol overlay in `AGENTS.md` with the
`skip-worktree` bit set (`src/agentsProtocol.ts`). That overlay hides protocol
text from `git status`, but it also blocks Git from switching branches while the
bit is set — a bare `git checkout issue-N/<agent>` fails. Agents that follow
older session-start habits (`git checkout main`, create the issue branch
themselves, or clear `skip-worktree` to “fix” status) stall before they can
publish evidence.

Commit `80d54a5` introduced `prepareAgentIssueBranches` and calls it from
`coord start` and `initializeEffects`, but the problem persists in two ways:

1. **Timing and coverage** — branch preparation must be guaranteed before any
   agent harness receives work, including resume and mid-issue recovery when a
   clone drifted off its issue branch. Today it runs only at start and at run-loop
   entry, not when individual actions are prepared.
2. **Agent-facing guidance** — only the R1.join task string mentions the
   prepared branch. Stale clone-local rules (for example `.cursor/rules/*.mdc`),
   launcher banners, and product templates still teach the old “checkout main /
   create branch” flow, so models with prior-session memory do the wrong thing on
   R2 and later steps.

This plan completes the coordinator-side guarantee and rewrites every agent-facing
surface so automated work never requires branch creation or clearing
`skip-worktree`.

## Exact File List to be changed or deleted

- `src/action.ts` — add a shared automated-work preamble to every rendered
  `action.md` (prepared branch, do not create/switch branches, do not clear
  `skip-worktree`).
- `src/steps.ts` — shorten the R1.join task to step-specific text only; move
  branch/skip-worktree wording into the shared preamble constant consumed by
  `renderAction`.
- `src/runLoop.ts` — call `prepareAgentIssueBranches` immediately before
  `writeAction` when preparing orders (so resume and per-step recovery re-check
  clones even if an agent switched away mid-issue).
- `scripts/lib/launcher.sh` — update the generated launcher banner: automated
  mode assumes coordination already checked out `issue-<n>/<agent>`; do not
  create the branch or clear `skip-worktree`.
- `templates/product/AGENTS.md` — add an **Automated branch preparation**
  subsection under branch scheme: coordination checks out `issue-<n>/<agent>`
  before publishing `action.md`; agents commit on that branch without creating
  it or touching index flags.
- `templates/product/AGENTS.protocol.md` — mirror the same rule in the
  clone-local protocol overlay agents read during automated actions.
- `scripts/setup_cursor.sh` — align generated `.cursor/rules/coordination.mdc`
  session-start text with launcher/AGENTS guidance (no “checkout main then ask
  for issue number” in automated mode).
- `docs/coord-driver.md` — document per-action branch re-preparation and the
  universal action preamble.
- `docs/setup-workspace.md` — note that agents must not create issue branches
  during automated runs.
- `docs/repo-map.md` — add invariant: coordination owns issue-branch checkout
  around the skip-worktree overlay.
- `package.json` — version `0.0.17`
- `config.product.example.json` — coordination stamp version `0.0.17`

## Exact file list to be created

- `src/automatedBranchGuidance.ts` — single exported constant with the shared
  agent-facing preamble text (keeps `action.ts`, tests, and templates aligned).
- `test/automatedBranchGuidance.test.ts` — assert preamble is non-empty and
  passes `findAgentLanguageViolations`.
- `test/action.test.ts` — extend coverage so every workflow step’s rendered
  action includes the preamble and never omits branch/skip-worktree guidance.
- `test/runLoop.test.ts` — assert preparing an action re-invokes branch
  preparation (mock/spy on `prepareAgentIssueBranches` or observe git state in
  fixture).
- `test/prepareAgentBranch.test.ts` — add case: when already on the issue branch
  but skip-worktree was cleared, `restoreProtocol` re-applies overlay and bit.

## Tests

- `pnpm check:fast` before every commit (lint, typecheck, fast tests including
  version-bump gate on non-`main` branches).
- Focused runs while developing:
  - `pnpm exec vitest run test/prepareAgentBranch.test.ts test/action.test.ts test/automatedBranchGuidance.test.ts test/runLoop.test.ts`
- Full coordinator gate before merge: `pnpm check`

## Alternatives Rejected

- **Tell agents to clear `skip-worktree` themselves** — forbidden by protocol;
  agents would dirty clones and break wipe/sync invariants.
- **Remove skip-worktree entirely** — reintroduces dirty `git status` from the
  protocol overlay and breaks wipe-issue checkout semantics tested in
  `test/wipeIssue.test.ts`.
- **Only update R1.join task text** — agents still fail on R2+ when stale rules
  or memory drive branch creation; issue explicitly calls out changed starting
  steps across the whole run.
- **Rely on git hooks to block bad checkouts** — hooks fail closed but produce
  confusing errors after the agent already wasted a turn; coordinator should
  prepare state before the harness starts.

## Risks and Mitigations

- **Agent-language violations** — preamble must avoid banned internal terms
  (`gate`, `join`, `R2.plan`, etc.). Mitigation: central constant +
  `test/agentLanguage.test.ts` / new guidance test.
- **Double branch prep on every tick** — `prepareAgentIssueBranches` is
  idempotent when already on branch; dirty-clone refusal remains fail-closed.
- **Existing clones with stale `.cursor/rules`** — template fixes apply on next
  `coord install` / setup script run; document in `docs/setup-workspace.md` that
  reinstall refreshes clone-local rules without clearing skip-worktree.
- **Resume while agent mid-commit** — dirty-clone guard already refuses; owner
  must commit/stash before resume (unchanged behavior, surfaced in error text).

## Conclusion

Ship a single shared automated-branch preamble, inject it into every
`action.md`, re-run `prepareAgentIssueBranches` before each action preparation,
and update product templates plus launcher/setup copy so agents never create
issue branches or clear `skip-worktree`. The existing lift/checkout/restore
machinery in `prepareAgentBranch.ts` stays; this issue finishes wiring and
documentation so agents and coordinators behave consistently from JOIN through
finalize.

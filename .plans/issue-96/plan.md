# Issue 96 implementation plan

The coordinator already owns automated issue-branch preparation: it lifts the
clone-local AGENTS.md overlay, checks out the agent's issue branch without
resetting existing work, restores the overlay and `skip-worktree`, and only then
launches or resumes the agent. The remaining defect is that the generated
vendor identities still order every agent to check out and pull the base branch
before deciding whether the session is automated. This plan preserves the
coordinator-owned implementation, adds end-to-end ordering coverage, and makes
every installed instruction surface unambiguous about the two startup modes.

## Exact File List to be changed or deleted

- `scripts/setup_codex.sh` — replace the unconditional base-branch checkout in
  the generated Codex identity with a decision-first checklist. An automated
  action means the issue branch is already prepared: verify it, but do not
  checkout/pull the base branch, create or recreate the issue branch, or change
  the AGENTS.md index bit. Only owner-driven manual work performs the explicit
  base-branch sync before creating or selecting a Codex scratch branch.
- `scripts/setup_claude.sh` — apply the same automated-versus-manual ordering to
  the generated Claude checklist, using Claude's branch names and retaining its
  existing identity and hook rules.
- `scripts/setup_cursor.sh` — apply the same ordering and prohibitions to the
  generated always-on Cursor rule.
- `scripts/setup_antigravity.sh` — apply the same ordering and prohibitions to
  both generated Antigravity identity copies without changing its terminal or
  permission guidance.
- `templates/product/AGENTS.protocol.md` — state the cross-vendor invariant in
  the installed automated-action protocol: coordination prepares the issue
  branch and restores `skip-worktree` before startup, so an action recipient
  must not create/switch that branch or clear the bit; a mismatch is an error to
  report rather than repair locally.
- `test/prepareAgentBranch.test.ts` — strengthen the branch-preparation cases so
  created, existing, and already-current issue branches all retain their commit
  and finish with the protocol overlay present and `skip-worktree` set, while a
  dirty clone still fails before any branch movement.
- `test/cli.test.ts` — add an initial-start integration assertion that the real
  agent clone is on the baseline-derived issue branch with its overlay and
  index bit restored when launch effects first run. Update the version assertion
  alongside the release bump.
- `test/runLoop.test.ts` — add the resume counterpart: branch repair completes
  before tmux session creation/repair can start an agent, and an existing issue
  branch is not reset.
- `test/install.test.ts` — assert an installed clone's protocol text includes
  the coordinator-owned startup rule, and update the emitted coordination
  version expectation.
- `package.json` — bump the pre-1.0 package version for the non-main ship gate.
- `config.product.example.json` — keep the example coordination stamp version
  synchronized with the package version.

No tracked file will be deleted.

## Exact file list to be created

- `test/setupInstructions.test.ts` — add a table-driven regression test over all
  four setup scripts. It will require the generated guidance to classify an
  automated action before any manual base-branch checkout instruction, say that
  the coordinator already prepared the issue branch, and forbid agent-side
  issue-branch creation and `skip-worktree` changes.

## Tests

1. Run `bash -n scripts/setup_codex.sh scripts/setup_claude.sh scripts/setup_cursor.sh scripts/setup_antigravity.sh` to validate every edited generator.
2. Run `pnpm exec vitest run --config vitest.config.ts test/setupInstructions.test.ts test/prepareAgentBranch.test.ts test/cli.test.ts test/runLoop.test.ts test/install.test.ts` for the focused instruction, install, initial-start, resume, and branch-preservation regressions.
3. Run `pnpm check:fast` before committing, as required by this repository.
4. Run `pnpm check` for the full build, lint, typecheck, fast-test, and end-to-end acceptance suite used by the coordinator.

## Alternatives Rejected

- Letting each agent clear `skip-worktree` and create its own issue branch is
  rejected because it recreates the unsafe sequence coordination already owns,
  can overwrite the managed overlay, and races the authoritative baseline.
- Keeping the unconditional base-branch checkout but adding a later warning is
  rejected because the destructive/conflicting checkout occurs before the
  warning can be followed.
- Moving all vendor identity generation into a new shared TypeScript subsystem
  is rejected for this focused fix: the four standalone setup scripts target
  different vendor files, and a broad migration would add deployment risk
  without improving branch-preparation ordering.
- Changing the product hook tree is rejected because hooks are enforcement, not
  the startup orchestrator, and repository policy forbids modifying them merely
  to satisfy checks.

## Risks and Mitigations

- **Mode ambiguity:** An agent could mistake manual work for an automated
  action. The revised wording makes the supplied coordinator action the mode
  discriminator and gives separate, ordered instructions for each case.
- **Instruction drift between vendors:** One generator could retain the old
  checkout-first sequence. The table-driven test applies the same invariant to
  all four sources, while the protocol template provides a common fallback.
- **False confidence from unit-only branch tests:** The helper can pass while a
  caller launches first. Initial-start and resume integration assertions observe
  clone state at the launch/tmux boundary.
- **Existing issue work loss:** Preparation must check out a local issue branch
  without rebasing or resetting it. Tests pin its preexisting commit and verify
  it remains the branch tip after preparation.
- **Previously generated local guidance remains stale:** The version bump and
  installer/setup rerun path make the updated templates deployable; the
  always-installed protocol overlay independently carries the same automated
  startup rule.

## Conclusion

Issue 96 will retain coordination as the sole owner of automated branch
preparation, prove that preparation and `skip-worktree` restoration precede
agent launch on both start and resume, and remove the checkout-first instruction
that currently invites agents to undo that state. Manual sessions keep an
explicit base-sync path, while automated sessions begin directly from the
prepared issue branch.

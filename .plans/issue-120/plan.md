# Issue 120: Leave agent clones base-ready after completion

Protocol version: 1.

The implementation will make worktree cleanup a coordinator-owned clone-readiness
operation. It may discard tracked, staged, and untracked work automatically only
when the clone is on the exact `issue-<N>/<agent>` branch for the issue whose
session is ending. It will never create a commit, stash, push, delete the issue
branch, or touch the product/owner worktree.

## Exact File List to be changed or deleted

- `src/prepareAgentBranch.ts` — extend the existing branch/protocol helper with
  an exported `makeAgentClonesBaseReady` operation and result types. The helper
  will derive each expected issue branch with `issueBranchFor`, skip absent or
  non-worktree roots, and perform a two-phase preflight across every usable
  clone before changing any worktree:
  1. capture the current branch and exactly one porcelain status result;
  2. treat only the already-supported managed-overlay-only `AGENTS.md` delta as
     coordinator state rather than agent work;
  3. reject dirty clones on a detached HEAD, the base branch, another issue's
     branch, or any other branch, naming the actual and expected branches and
     ending with the existing `Nothing has been changed` remediation; and
  4. only after every branch/status safety check passes, fetch `origin`, resolve
     `origin/<base>`, and reject a local base ref that is ahead or diverged
     before any destructive reset (unless the caller is the explicitly forced
     wipe path). This prevents `checkout -B` from silently orphaning owner
     commits on a clean but noncanonical local base branch.

  After every clone passes preflight, the helper will capture the protocol
  overlay, lift the `AGENTS.md` skip-worktree handling, conditionally run
  `git reset --hard HEAD` followed by `git clean -fd` only for status entries
  authorized by the finished-issue rule, and check out/reset the configured
  local base branch at the fetched `origin/<base>` tip. The existing
  `restoreProtocol` path will run in `finally`, so both the overlay and
  skip-worktree bit are reasserted even if reset or checkout fails. A final
  non-status assertion will verify `HEAD` names the base branch, its commit
  equals `origin/<base>`, and the protocol outcome is consistent with the
  captured overlay. Structured results and log lines will distinguish
  discarded paths, clean checkout-only clones, already-base clones, and
  missing/non-worktree skips. The helper's explicit discard policy will be
  `finished-issue-only` by default and `force-wipe` only for an owner-supplied
  wipe force flag, rather than a general boolean that another caller could
  accidentally enable.

- `src/cli.ts` — make `detachCompletedIssue` call
  `makeAgentClonesBaseReady` after it has confirmed `cursors.completed` and read
  the immutable issue number, original participating agent roots, branch
  template, and base branch from `start.json`. Resolve the installed protocol
  template from the stored config when available and otherwise let the helper
  use its captured/local-config fallback. Cleanup will run before automatic UI
  detach; a safety refusal therefore keeps the completed runtime and UI
  inspectable, returns a clear error, and can be retried with `coord N` or
  `coord run` after remediation. Successful and missing-clone outcomes proceed
  through the existing `detachIssue` path and add the cleaned/skipped counts to
  the completion log. Both `coord N` and `coord run` already call this one
  function, so no second completion hook or journal replay is introduced.

- `src/wipeIssue.ts` — replace the blanket non-force dirty-clone gate and the
  duplicated lift/fetch/checkout/clean block with the shared base-readiness
  helper before branch/ref deletion begins. A normal explicit wipe will now
  discard dirt only on that wipe's exact `issue-<N>/<agent>` branch; ambiguous
  dirt will still refuse before refs, runtime, mailbox, or UI are changed.
  `--force` will select the helper's visibly named `force-wipe` policy and
  preserve the command's existing explicit ability to discard other clone
  dirt. Dry-run will use `git ls-remote` to report the remote base it would
  fetch and will not update remote-tracking refs, reset, clean, checkout, or
  write protocol state. The later wipe phases will continue to delete only the
  already-owned issue refs/runtime and will populate `resetClones` from
  non-skipped readiness results. Product-worktree preservation and remote
  branch ownership logic remain unchanged.

- `test/prepareAgentBranch.test.ts` — add focused fixture coverage for the
  shared helper: staged/unstaged work plus an untracked evidence directory on
  the exact completed issue branch is removed and the clone lands clean on the
  fetched base without a new commit; an already-clean issue clone performs only
  the base checkout; a dirty wrong/other-issue branch throws before any clone
  changes; a missing path and a present non-worktree are logged/skipped; a
  clean local base that is ahead/diverged is refused rather than rewritten; and
  the protocol overlay/skip-worktree bit is restored on both success and a Git
  failure.

- `test/cli.test.ts` — extend the completed-run case with a real temporary
  origin and agent clone. Leave staged and untracked work on the matching issue
  branch, mark runtime complete, invoke both command entry shapes across the
  tests (`coord N` and `coord run`), and assert automatic teardown first leaves
  the clone on `main` at `origin/main`, removes the WIP, preserves the local and
  remote issue commits, creates no cleanup commit, and reports cleanup before
  the existing tmux/Terminal summary. Retain a missing-clone completion case to
  prove teardown is not blocked by a skipped participant.

- `test/wipeIssue.test.ts` — add a non-force wipe case whose dirty clone is on
  the exact issue/agent branch and is therefore reset/cleaned before existing
  ref/runtime removal. Keep and strengthen the current dirty-base/wrong-branch
  refusal so it proves the file, branch, refs, runtime, and mailbox remain
  unchanged without `--force`; keep the force case as the explicit override.

- `docs/coord-driver.md` — narrow the current “never writes agent clones” claim
  to the real invariant (the coordinator never authors, stashes, or pushes
  agent work), document the reset/clean/base-checkout/protocol-restore sequence
  performed after successful completion, its exact-issue-branch safety gate and
  audit logging, and the revised wipe behavior (matching issue-branch WIP no
  longer needs `--force`; ambiguous dirt still does).

No implementation file is deleted. `package.json`, `pnpm-lock.yaml`, generated
`dist/**`, hooks, runtime state, and the product worktree are not changed.

## Exact file list to be created

- `.plans/issue-120/plan.md` — this transient coordination plan artifact. No
  new source, test, documentation, configuration, or dependency file is
  required; the readiness operation belongs beside the existing branch helper.

## Tests

Run the focused suites while iterating:

```sh
pnpm exec vitest run --config vitest.config.ts \
  test/prepareAgentBranch.test.ts test/wipeIssue.test.ts test/cli.test.ts
```

The focused assertions will cover the acceptance matrix directly:

1. Dirty exact completed-issue branch: staged and tracked edits are reset,
   untracked files/directories are cleaned, the issue branch ref/commits remain,
   no commit is created, and `HEAD` is clean on the fetched base.
2. Clean clone: only base synchronization/checkout and protocol restoration
   occur; reset/clean are not reported as discards.
3. Dirty wrong, detached, base, or other-issue branch: the entire multi-clone
   preflight refuses and every worktree/ref remains byte-for-byte unchanged.
4. Missing directory or non-worktree: skip with an auditable result and allow
   the remaining clones and UI teardown to finish.
5. `AGENTS.md`: managed overlay handling neither creates false dirt nor leaves
   the bit clear after a success or exception.
6. Wipe integration: normal wipe accepts only exact-issue WIP, while ambiguous
   dirt still requires the explicit force path.

Before any implementation commit, run the repository's declared precommit
suite:

```sh
pnpm check:fast
```

Before publication/final acceptance, run the coordinator's full suite:

```sh
pnpm check
```

`pnpm check` includes the build, lint, source/test typechecks, fast tests, and
end-to-end suite. The build may refresh ignored local `dist/**` output but does
not add generated files to the implementation commit.

## Alternatives Rejected

- Ask agents to stash, reset, or print cleanup commands before `COORD-IDLE` —
  rejected because readiness is already a coordinator lifecycle responsibility
  and agent housekeeping is the failure mode this issue removes.
- Commit or stash unfinished work on the agent's behalf — rejected because it
  invents agent history, can trigger hooks/push expectations, and violates the
  issue's discard-only requirement. The helper exposes no commit, add, stash,
  or push operation.
- Run `git checkout -f`/`git clean -fd` for every dirty clone after completion —
  rejected because branch identity is the authorization boundary; doing this
  on a different issue, base, detached, or owner branch destroys ambiguous
  work.
- Reset a local base branch blindly with `checkout -B base origin/base` —
  rejected because a clean base can still contain unpushed commits. The plan
  fetches and proves the local base is absent, equal, or an ancestor of origin
  before moving it; otherwise it refuses unless the owner explicitly invoked
  forced wipe.
- Put completion cleanup in `CoordinatorRunLoop.runTick` — rejected because it
  mixes clone mutation into state transition/evidence logic and would miss the
  already-shared post-run teardown path used by `coord N` and `coord run`.
- Add a new cleanup subsystem/file — rejected in favor of extending
  `prepareAgentBranch.ts`, which already owns issue/base branch derivation,
  dirt classification, AGENTS protocol lifting/restoration, and readiness
  assertions.
- Leave `wipe-issue` on its separate blanket dirty gate — rejected because the
  same explicit issue number and branch template provide the identical safe
  authorization boundary; reusing the helper removes duplication and satisfies
  the preferred common-leftover-WIP behavior without weakening ambiguous-dirt
  refusal.

## Risks and Mitigations

- **Authorized cleanup permanently removes uncommitted files.** Require the
  terminal runtime to be completed (or an explicit wipe of the same issue),
  require exact issue/agent branch identity, preflight all clones before the
  first reset, and log the captured porcelain entries before discarding them.
- **One unsafe clone could otherwise allow earlier clones to be cleaned.** Use
  a global branch/status safety pass before fetching, then resolve and validate
  every base ref before resetting any worktree; abort the batch when any clone
  has ambiguous dirt or unsafe local base history.
- **A stale `origin/<base>` could leave the next issue on an old baseline.**
  Fetch origin and bind checkout plus the postcondition to the fetched remote
  tracking commit; a fetch/ref-resolution failure aborts rather than falling
  back silently to a stale local base.
- **Skip-worktree AGENTS.md can block checkout or become visible as false WIP.**
  Reuse capture/lift/restore helpers, preserve the exact managed-overlay dirt
  exception, restore in `finally`, and assert the overlay/bit outcome without a
  second status scan.
- **Reset succeeds but a later checkout fails.** The discarded work was already
  authorized, the issue branch commit/ref is retained, protocol restoration
  still runs in `finally`, the command fails loudly, and rerunning completion
  can finish the base checkout.
- **A live agent could race cleanup.** Run only after durable workflow
  completion, when actions are closed and agents report idle; do not run on
  pause, abandon, detach-only, or live resume paths. A safety failure leaves the
  UI available for inspection instead of continuing teardown.
- **Normal wipe might become as destructive as force.** The helper uses distinct
  policy values and the normal path authorizes only the exact issue branch;
  tests assert wrong-branch dirt changes nothing and still prints the force or
  manual-stash remediation.
- **Cleanup could accidentally delete published history or evidence on origin.**
  Reset/clean affect only the worktree/index/untracked files, checkout leaves
  the local issue ref intact, completion never pushes or deletes refs, and the
  existing separately authorized wipe logic remains the only remote-deletion
  path.

## Conclusion

Extend the existing branch-readiness module with one audited, protocol-aware
base-readiness helper. On successful workflow completion, the shared CLI
teardown path will discard WIP only from the exact finished issue branch, clean
untracked leftovers, synchronize the clone to `origin/<base>`, restore the
AGENTS overlay/skip-worktree bit, and then close UI. Reuse the same authorization
boundary at the start of `wipe-issue` so common same-issue leftovers no longer
need `--force`, while missing clones skip and ambiguous branch dirt still fails
closed without coordinator-created commits or pushes.

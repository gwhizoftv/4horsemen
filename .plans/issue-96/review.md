# Review of issue 96 plans

Reviewed the plans pinned by the action for Cursor
(`c322ff755f9ad9ba2587db71e02917807a9e9266`), Codex
(`8987f621e47515b123deea4be471487bf05a724d`), and Claude
(`3b9a0c2df8c47e2ae5f0a7230e38423aea58b37a`).

## Findings

### 1. Cursor plan — per-action branch preparation manipulates a live agent worktree

**Plan claim/section:** The Cursor plan's timing-and-coverage fix calls
`prepareAgentIssueBranches` immediately before each `writeAction`, including
later workflow actions, so a clone that drifted mid-issue is switched back.

**Rule:** Branch checkout and AGENTS.md overlay restoration must finish before
the harness starts; action publication to an already-running harness must not
change that harness's branch underneath it. Recovery must also remain local to
the affected clone and must not make one active agent's dirty work block orders
for peers.

**Concrete failure:** On a later action the harness is already alive. If its
clone drifted, the proposed call checks out another branch while that process is
running, invalidating its current file/index context. If the helper is called
with the roster, its all-clone dirty preflight can instead refuse while a peer
is editing and prevent an otherwise-ready agent's action from being published.

**Smallest correction:** Keep branch preparation at initial start and resume,
before tmux launch/repair, and test those two boundaries. Treat mid-run drift as
an explicit error to report rather than silently switching a live worktree.

### 2. Claude plan — the `bit-only` fallback declares a clone ready without its protocol

**Plan claim/section:** The Claude plan changes restore to return
`"bit-only"` when no install root can be resolved, sets skip-worktree anyway,
and accepts that result as a prepared clone.

**Rule:** A tracked AGENTS.md in an automated agent clone must have both the
managed protocol overlay and skip-worktree set before launch. The bit is only
the mechanism that hides the intentional overlay; it is not a substitute for
the overlay itself.

**Concrete failure:** After the lift/checkout sequence has restored the
committed product AGENTS.md, the fallback marks that file skip-worktree without
re-rendering the coordination protocol. Startup then succeeds and the agent
cannot see artifact formats, completion handling, or the prohibition on index
changes—the exact guidance this issue is meant to guarantee.

**Smallest correction:** Resolve the real install root supplied by the workspace
stamp and fail closed before launch if the overlay cannot be restored. A
postcondition must require overlay presence as well as the index bit; it must
not treat `"bit-only"` as success.

### 3. Claude plan — the release bump leaves the declared test suite red

**Plan claim/section:** The Claude plan changes `package.json` from `0.0.16` to
`0.0.17`, claims no edit to the install test is needed, and requires
`pnpm check:fast` and `pnpm check` to pass.

**Rule:** A mechanically complete version bump must update every repository
fixture and exact version assertion derived from the package version so the
named checks pass and example install stamps do not advertise a stale version.

**Concrete failure:** The current install test expects emitted coordination
version `0.0.16`; changing only the package makes that assertion receive
`0.0.17`, so `pnpm check:fast` fails. The example product configuration also
continues to stamp `0.0.16`, contradicting the shipped package.

**Smallest correction:** Include `test/install.test.ts` and
`config.product.example.json` in the changed-file map and update both to the
new version.

### 4. Cursor plan — existing tests are misclassified as files to create

**Plan claim/section:** The Cursor plan's “Exact file list to be created” lists
`test/action.test.ts`, `test/runLoop.test.ts`, and
`test/prepareAgentBranch.test.ts` as new files.

**Rule:** The required exact file map must distinguish existing files to modify
from genuinely new files so implementation preserves existing coverage and the
selected scope is mechanically executable.

**Concrete failure:** All three files already exist and contain substantial
test suites. Following the creation list literally either fails because the
targets exist or replaces those suites instead of extending them, discarding
unrelated regression coverage.

**Smallest correction:** Move those three paths into the changed-file section;
only the proposed guidance module and its dedicated new test belong in the
creation section.

## Conclusion

The Codex plan is the strongest base. It recognizes that the coordinator's
existing initial-start and resume ordering already satisfies the branch
preparation requirement, adds integration coverage at the actual launch
boundaries, and fixes the checkout-first vendor guidance without introducing
live per-action branch switching or a protocol-free success state. The Cursor
plan needs its per-action checkout removed and its file map corrected. The
Claude plan contains useful attention to restore postconditions, but its
`bit-only` success path violates the core overlay invariant and its incomplete
version map cannot pass the checks it names.

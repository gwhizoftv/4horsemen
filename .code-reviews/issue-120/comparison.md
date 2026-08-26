# Issue 120 implementation comparison

Bound implementation pins:

- claude: `d198c34682ddaafd3967d8c2ea94f9761ece9fae`
- cursor: `64a9e958421d067fcf5e23d399fd9471a18abe20`
- codex: `4b17f983a143f21f57bb1cace7d61e9d58cc1a1e`

All three ship the same architecture the selected plan named: one exported
`makeAgentClonesBaseReady` in `src/prepareAgentBranch.ts` reusing
`issueBranchFor`, `blockingDirtyPaths`, and `restoreProtocol`; the call wired
into `detachCompletedIssue` in `src/cli.ts` after `detachIssue`; the same
authorization boundary at the `src/wipeIssue.ts` dirty gate; docs updated. None
of them commits, stages, stashes, or pushes, and none deletes a ref during
cleanup. No implementation added a new source file.

Each pin passes its own focused suites. Extracted to isolated trees and run with
`vitest run --config vitest.config.ts test/prepareAgentBranch.test.ts
test/wipeIssue.test.ts`: claude 29 passed, cursor 24 passed, codex 23 passed.
`test/cli.test.ts` could not be evaluated in that harness — the extracted tree is
not a git repository, so 8 pre-existing CLI cases fail identically for all three
pins including claude's, which passes in a real clone. Those failures are an
artifact of the harness and are not attributed to anyone below.

The findings are the behavioral divergences, each reproduced by running the
three compiled helpers against the same fixture.

## Comparison

### 1. cursor and codex reset the local base branch and orphan commits origin does not have

`src/prepareAgentBranch.ts:362` (cursor, `checkout -B <base> <tip>`) and
`src/prepareAgentBranch.ts:421` (codex, `checkout --quiet -B <base>
origin/<base>`).

**Rule.** The issue's non-goals forbid silently discarding work on a *different*
branch. Only `issue-<N>/<agent>` for the finished issue is authorized for
discard; the base branch is not. `checkout -B` moves the local base ref, so it is
safe only when that ref is absent or already contained in `origin/<base>`.

**Failure.** An agent clone whose local `main` carries a commit that was never
pushed — an owner experiment, a leftover from an older coord build, a
hand-applied fix — loses it. Fixture: clone with one unpushed commit on `main`,
then dirty on `issue-9/claude`, then cleanup. Observed:

| pin | unpushed commit still reachable from `main` |
| --- | --- |
| claude `d198c34` | yes |
| cursor `64a9e958` | **no** |
| codex `4b17f983` | **no** |

After cleanup, `git cat-file -e main:owner-note.txt` fails on both peer pins: the
commit is reachable only from the reflog until it is gc'd. Nothing warns the
owner, and the summary line reports the clone as base-ready. codex's own bound
plan promised the guard that would have prevented this ("reject a local base ref
that is ahead or diverged before any destructive reset"); the implementation does
not carry it.

**Test.** In `test/prepareAgentBranch.test.ts`, seed the clone, commit a file on
the base branch without pushing, record `git rev-parse main`, prepare the issue
branch, dirty it, run the helper, then assert `git rev-parse main` is unchanged
and the file is still present. claude's pin covers this as "keeps a local base
branch that origin does not contain instead of resetting it"; on both peer pins
that assertion fails.

**Fix sketch.** Before `checkout -B`, compare: when `refs/heads/<base>` exists and
`git merge-base --is-ancestor <local base> <origin tip>` is false, `git checkout
<base>` without `-B`. The clone still ends clean on the base branch, which is
what acceptance asks for.

### 2. codex refuses all cleanup when `git fetch` fails, so an offline completion cleans nothing

`src/prepareAgentBranch.ts:396-407` (codex): a non-zero `git fetch --quiet
origin` and an unresolvable `origin/<base>` each produce
`action: "refused"` for that clone before any discard.

**Rule.** Acceptance requires that after a completed run each participating clone
is clean and on the base branch, and that the next `coord M` starts without an
owner reset in the common leftover-WIP case. Reaching origin is not a
precondition the issue places on that: the local base ref is a valid start-ready
state, and `coord start` re-resolves its own baseline from origin anyway
(`startPoint`, `src/prepareAgentBranch.ts:37-48`).

**Failure.** With the remote unreachable — network drop, VPN down, GitHub
outage, a bare origin that moved — the finished issue's leftover WIP survives.
Same fixture as above with the origin removed:

| pin | action | leftover WIP discarded | HEAD after cleanup |
| --- | --- | --- | --- |
| claude `d198c34` | `checked-out` | yes | `main` |
| cursor `64a9e958` | `checked-out` | yes | `main` |
| codex `4b17f983` | `refused` | **no** | `issue-9/claude` |

The clone is left dirty on the issue branch, so the next `coord M` refuses at
`src/prepareAgentBranch.ts:184` — the exact operator pain this issue exists to
remove, now triggered by a transient network failure rather than by agent
housekeeping. codex also fetches all refs (`git fetch --quiet origin`) rather
than just the base, which makes that failure both more likely and slower than
the issue's "one Git status + conditional reset/clean/checkout per agent".

**Test.** Remove the clone's origin remote (or delete the bare origin), run the
helper, and assert the clone ends clean on the base branch. claude's pin covers
this as "reports the local base when the origin base cannot be resolved" and
records `baseSynced: false` so the fallback is auditable rather than implied.

### 3. codex turns a previously working `wipe-issue` into a hard failure when origin is unreachable

`src/wipeIssue.ts:267-272` (codex): any readiness result with
`action: "refused"` throws `Cannot make agent clones base-ready for wipe-issue`,
and because that runs before the `try`/`finally` that owns `detachIssue`, the UI
teardown is skipped too.

**Rule.** The issue authorizes exactly one change to wipe, in the direction of
*fewer* refusals: leftover WIP on that issue's own agent branch should stop
requiring `--force`, and "today's refuse behavior" is to be kept only for
ambiguous dirt. Baseline wipe deliberately ignores the result of its base fetch
(`git(root, "fetch", "origin", base)` at baseline `src/wipeIssue.ts:259`) and
`git ls-remote` failures degrade to "remote already absent", so wipe works
offline.

**Failure.** `coord wipe-issue 3` on a **clean** clone sitting on
`issue-3/claude` with the origin unreachable. Run against each pin's compiled
`wipeIssue`, with the baseline `a98c04b3` as the control:

| pin | wipe outcome | clone HEAD after | local `issue-3/claude` deleted |
| --- | --- | --- | --- |
| baseline `a98c04b3` | succeeds | `main` | yes |
| claude `d198c34` | succeeds | `main` | yes |
| cursor `64a9e958` | succeeds | `main` | yes |
| codex `4b17f983` | **throws** | `issue-3/claude` | **no** |

Nothing was dirty and nothing was ambiguous; the owner asked to wipe an issue and
got an error naming a fetch failure, with runtime, mailbox, refs, and tmux
sessions all left in place. `--force` does not help: the same fetch gate runs
under `discardPolicy: "force-wipe"`.

**Test.** Extend `test/wipeIssue.test.ts` with the fixture above — clone clean on
`issue-3/claude`, `rmSync` the bare origin, wipe without `--force` — and assert it
resolves and the local issue ref is gone. It passes on the baseline and on the
other two pins.

### 4. cursor's completion summary counts clones it did not clean

`src/cli.ts:792` (cursor): `const cleaned = readiness.filter((row) => row.action
=== "checked-out").length;`.

**Rule.** The issue requires the driver to "log what was discarded vs skipped so
the owner can audit". A clone that was already clean and was only checked out
discarded nothing.

**Failure.** A three-agent issue that ends with every clone clean on its issue
branch prints `Issue 120 clone readiness: 3 cleaned, 0 already-base, 0 refused, 0
skipped.` The owner reads that as "three clones had leftover work discarded" when
nothing was discarded at all, and the count cannot be distinguished from the run
where three clones really were reset. `discardedPaths` is populated correctly on
the result — only the tally is wrong.

**Test.** Run the completion path with one clean clone on the issue branch and
assert the summary reports zero cleaned. claude's pin counts
`discardedPaths.length > 0` (`src/cli.ts:777`); codex counts the same way
(`src/cli.ts:784`).

### 5. claude's batch abort leaves eligible clones dirty when one clone is ambiguous

`src/prepareAgentBranch.ts:464-475` (claude): one plan classified `refuse` turns
every non-skipped clone into `refused` and nothing is mutated.

**Rule.** Acceptance asks that after a completed run **each** participating clone
be clean and on the base branch, refusing only where dirt is unauthorized.
Eligibility is a per-clone property, so one clone's ambiguity is not evidence
about another's.

**Failure.** Three-agent run where `claude` and `cursor` hold leftover WIP on
their own `issue-120/<agent>` branches and `codex` has an owner edit on `main`.
Two-clone fixture, one eligible and one ambiguous:

| pin | eligible clone cleaned | ambiguous clone untouched |
| --- | --- | --- |
| claude `d198c34` | **no** | yes |
| cursor `64a9e958` | yes | yes |
| codex `4b17f983` | yes | yes |

The owner must now reset three clones by hand instead of one. This is a
deliberate choice in claude's pin — it is what makes a caller's "Nothing has been
changed" literally true, and it is what both peer reviews asked for in R3 — but
on the completion path it is the wrong trade: the ambiguous clone blocks the next
`coord M` either way, so aborting only subtracts the cleanups that would have
succeeded. codex's split is the best answer of the three: `batchPolicy:
"continue"` for completion and `"refuse-all"` for wipe, where the all-or-nothing
promise actually appears in the error text.

**Fix sketch.** Keep the read-only preflight, but let the completion caller
proceed per clone and reserve the batch abort for the wipe caller, which is the
one whose refusal message claims nothing was changed.

### 6. Divergence with no defect: wipe integration shape

claude keeps the historical gate and pre-cleans in front of it
(`src/wipeIssue.ts:227-247`), so wipe's control flow and its refusal text are
untouched. cursor does its own ambiguity preflight before delegating
(`src/wipeIssue.ts:227-253`), reaching the same behavior by a different route.
codex replaces the gate and the whole per-clone reset loop with the shared helper
(`src/wipeIssue.ts:245-292`), which removes real duplication and is the tidiest
of the three — it is only findings 2 and 3 that make that consolidation
currently unsafe. All three preserve `--force` and leave `dryRun` non-mutating;
all three preserve the "Refusing wipe-issue: uncommitted changes in …  Nothing
has been changed." message for ambiguous dirt.

### Recommendation

claude `d198c34682ddaafd3967d8c2ea94f9761ece9fae` is the soundest base: it is the
only pin that does not orphan unpushed base-branch commits (finding 1), it keeps
cleanup working offline with the fallback recorded as `baseSynced: false`
(finding 2), it leaves `wipe-issue`'s behavior and refusal text unchanged
(finding 3), and its summary counts real discards (finding 4). It should take
codex's `batchPolicy` split before finalization to fix finding 5, which is the
one place a peer's behavior is clearly better than claude's. cursor
`64a9e958421d067fcf5e23d399fd9471a18abe20` needs findings 1 and 4; codex
`4b17f983a143f21f57bb1cace7d61e9d58cc1a1e` needs findings 1, 2, and 3, of which 3
is a regression against behavior that works at the baseline today.

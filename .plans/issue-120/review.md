# Issue 120 plan review

Bound inputs:

- cursor plan: `d049e7b79662a59e717ff97c7fbc8d0274f3bc22` at `.plans/issue-120/plan.md`
- claude plan: `6cf79d06be8623a8b264dd4345572e341a990bf0` at `.plans/issue-120/plan.md`
- codex plan: `bd3231172e002b5e74823fbfc68fe17ea090fc60` at `.plans/issue-120/plan.md`

All three converge on the same shape the issue asks for: one shared discard-only
"make clone base-ready" helper beside `prepareAgentIssueBranches`, called from
the completed-run tear-down and from the `wipe-issue` dirty gate, gated on
`HEAD === issue-<N>/<agent>`. The findings below are where a plan, followed as
written, produces a worse outcome than the code has today.

## Findings

### 1. codex — cleanup before UI detach, refusal raised as an error, strands the completed issue's UI

**Claim.** codex `src/cli.ts` bullet: "Cleanup will run before automatic UI
detach; a safety refusal therefore keeps the completed runtime and UI
inspectable, returns a clear error, and can be retried with `coord N` or
`coord run` after remediation."

**Rule.** The issue classifies ineligible dirt as "refuse and print a clear
remediation … and change nothing" — a refusal is an expected outcome of a
*successful* run, not a run failure. Completion tear-down must therefore still
tear down, and a completed issue must not start reporting a non-zero exit.

**Failure.** `detachCompletedIssue` (`src/cli.ts:753`) is called after
`makeRunLoop(paths).run()` from both `coord <issue>` (`src/cli.ts:981`) and
`coord run` (`src/cli.ts:1284`). Put cleanup before `detachIssue`
(`src/cli.ts:757`) and let a refusal throw, and this happens: issue 120
completes; the owner has an unrelated edit on `main` in one of three agent
clones (ineligible dirt, correctly refused); the throw propagates to the
`runCli` catch at `src/cli.ts:1502`, which prints `coord: …` and returns exit
`2` for an issue that finished successfully. `detachIssue` never runs, so the
issue's tmux session and every owner Terminal window stay open. Re-running
`coord 120` does not help: `run()` returns early on `cursors.completed`, control
reaches the same guard, and the same throw repeats. The UI can then only be
closed by hand or by `coord wipe-issue`, and the other two clones — both
eligible — are never cleaned.

**Correction.** Call the helper *after* `detachIssue` returns, and report
refusals as counted, logged outcomes on stdout rather than as a thrown error.

### 2. cursor and codex — aborting the whole readiness pass on one ambiguous clone re-creates the operator pain the issue exists to remove

**Claim.** cursor, Risks: "Partial batch mutation — run an all-clones safety
preflight before the first lift/reset; if any clone has ambiguous dirt, abort
the whole readiness pass with nothing changed". codex states the same rule twice
("perform a two-phase preflight across every usable clone before changing any
worktree"; "abort the batch when any clone has ambiguous dirt or unsafe local
base history"), and pins it in its own test 3: "the entire multi-clone preflight
refuses and every worktree/ref remains byte-for-byte unchanged."

**Rule.** The issue's goals are written per clone — "for each configured agent
clone: 1. If the clone is missing … skip … 3. If `HEAD` is on `issue-<N>/<agent>`
… and the worktree/index is dirty → discard" — and its acceptance requires
"**each** participating agent clone is clean and on the base branch", with
refusal scoped to the offending tree ("Dirt on another branch or another issue's
branch still refuses cleanup and leaves the tree unchanged"). Eligibility is a
per-clone property; one clone's ambiguity is not evidence about another's.

**Failure.** Three-agent consensus run of issue 120. The `claude` and `cursor`
clones each hold leftover R4 edits on their own `issue-120/<agent>` branches —
the canonical eligible case. The `codex` clone has an owner edit on `main`.
Under the batch rule the pass aborts, all three clones stay dirty, and the next
`coord 121` refuses at `src/prepareAgentBranch.ts:184` —
"Refusing to check out issue branches: uncommitted changes in …" — naming two
clones that were fully eligible for discard. That is exactly the post-#110
scenario the issue cites, unchanged, and the owner must still reset by hand.
The batch rule converts one ineligible clone into zero cleaned clones.

**Correction.** Refuse per clone, continue the loop, and return/print
`cleaned / checked-out / refused / skipped` counts with the refusal reason per
clone. No cross-clone preflight is needed: nothing in the sequence is shared
between clones.

### 3. codex — refusing an ahead/diverged local base regresses `wipe-issue` on clones that are clean

**Claim.** codex `src/prepareAgentBranch.ts` bullet, preflight step 4: "reject a
local base ref that is ahead or diverged before any destructive reset (unless
the caller is the explicitly forced wipe path)", and the matching Alternatives
entry rejecting `checkout -B base origin/base` outright. codex also routes
`wipe-issue`'s non-force path through that same helper ("replace the blanket
non-force dirty-clone gate and the duplicated lift/fetch/checkout/clean block
with the shared base-readiness helper").

**Rule.** The issue authorizes exactly one change to wipe, in the direction of
*fewer* refusals: run readiness cleanup "at the start of `wipe-issue` when dirty
only on that issue's agent branch, so `--force` is not required for the common
leftover-WIP case. Keep today's refuse behavior when dirt is ambiguous." Adding
a new refusal that fires on clones with no dirt at all is outside that grant.

**Failure.** `wipeIssue` today runs `gitOrThrow(root, "checkout", "-B", base,
"origin/" + base)` unconditionally for every existing clone
(`src/wipeIssue.ts:273`), and the non-force gate above it
(`src/wipeIssue.ts:226`) only inspects `cloneIsDirty`. So a clone that is
perfectly clean but whose local `main` carries one commit not on `origin/main`
— a leftover from an older coord build, an owner experiment, a test commit — is
silently re-pointed at `origin/main` today. Under the plan, `coord wipe-issue
120` now *fails* on that clean clone and tells the owner to re-run with
`--force`, which is strictly more destructive than the operation they asked for
and additionally discards dirt in every other clone. Compounded with finding 1,
the same workspace also refuses cleanup on every completed run, so nothing is
ever cleaned automatically.

**Correction.** Keep the ahead/diverged guard on the completion path only, where
no behavior exists to regress, and leave `wipe-issue`'s base checkout exactly as
it is; or scope the guard so it can decline to move the local base while still
letting the surrounding wipe/cleanup finish.

### 4. cursor — the helper's refusal contract is left as "throws or returns", and the two halves of the plan need opposite answers

**Claim.** cursor Tests case 3: "helper **throws or returns** a refused outcome
after a preflight that mutates nothing". cursor `src/cli.ts` bullet: "do not
fail the CLI exit code solely because one clone refused cleanup."

**Rule.** A plan is an implementation contract, and the caller branches on this
exact choice. Where a plan's own two sections require different behavior, one of
them will be implemented wrong.

**Failure.** An implementer reading Tests case 3 first implements the throw,
because that is the cheaper form and the test permits it. The `cli.ts` bullet
then cannot be honored except by wrapping the call in a `catch` that swallows
*every* error from the helper — including a genuine `git checkout` failure that
leaves a clone with the skip-worktree bit clear — or, if no wrapper is added, by
reproducing finding 1 verbatim: exit `2` and no `detachIssue` on a completed
issue. Either way the acceptance line "Next `coord M` can start without owner
manual stash/reset" fails for reasons the tests do not catch.

**Correction.** Name one form — a `refused` result value with a `reason` string —
and delete "throws" from the test case, so the CLI can count refusals without a
blanket `catch`.

### 5. cursor and codex — the plan artifact is listed as an implementation file to create

**Claim.** cursor, "Exact file list to be created": "`.plans/issue-120/plan.md`
— this plan (published as R2 evidence)". codex lists the same path with the note
"this transient coordination plan artifact".

**Rule.** That section is the implementation's file list; `.plans/` is
coordination evidence, published under its own action and removed at
finalization (cf. `7dde9d6` "Cursor: finalize issue 110 by removing coordination
evidence").

**Failure.** An implementer working the file list literally stages
`.plans/issue-120/plan.md` into the implementation commit, and the finalization
step then has to strip it back out — while codex's own "No implementation file
is deleted" paragraph and its `.plans` note already contradict the list entry it
sits under.

**Correction.** Write "None" with the justification for why no new source file
is needed; the plan artifact is already accounted for by the action that
published it.

### 6. claude (self) — "best effort" fetch can report a stale base as base-ready

**Claim.** claude plan, `src/prepareAgentBranch.ts` bullet step 4: "`git fetch
--quiet origin <base>` (best effort) and `git checkout -B <base>
origin/<base>`, falling back to local `<base>`".

**Rule.** A summary line that tells the owner a clone is base-ready must make
the commit it landed on auditable; the issue requires "Log what was discarded vs
skipped so the owner can audit."

**Failure.** With `origin` unreachable, the fetch fails silently, `origin/<base>`
resolves to a stale tracking ref, and the clone is checked out there and counted
as `checked-out`. The owner reads the completion summary as "clones synced to
origin" when local `main` is behind. The blast radius is bounded — the next
`coord M` re-resolves the baseline from origin in `startPoint`
(`src/prepareAgentBranch.ts:36-49`), so the next issue branch is still created at
the right commit — but the audit line is wrong. codex's "bind the checkout and
the postcondition to the fetched remote-tracking commit" is the better rule here.

**Correction.** Record the resolved tip in the result and log it
(`checked out main at <sha12>`), and flag the result when the fetch did not
succeed, so a stale base is visible rather than implied.

## Conclusion

All three plans satisfy the issue's core requirements: one shared helper in
`src/prepareAgentBranch.ts`, discard-only Git, `HEAD === issue-<N>/<agent>` as the
authorization boundary, `prepareAgentIssueBranches`'s live-resume refusal left
alone, no new subsystem, and the four acceptance test cases plus
`pnpm check:fast`.

Recommended starting plan: **claude** (`6cf79d06`). It is the only one that
places cleanup after `detachIssue` and treats a refusal as a counted, logged
outcome rather than an error, which is what findings 1 and 4 turn on, and it
refuses per clone rather than aborting the batch (finding 2). It should adopt
two things from **codex** (`bd323117`) before implementation: binding the
checkout and its postcondition to the *fetched* `origin/<base>` tip rather than a
best-effort fallback (finding 6), and codex's explicitly named discard policy
(`finished-issue-only` vs `force-wipe`) instead of a boolean a future caller
could flip by accident. **cursor** (`d049e7b7`) contributes the `docs/repo-map.md`
line — `prepareAgentBranch.ts` now owns end-of-session readiness, not only
start/resume checkout — and its explicit "do not fail the CLI exit code solely
because one clone refused cleanup" rule, which should be stated in whichever plan
is accepted.

codex (`bd323117`) should not be implemented as written: findings 1 and 3 are
behavior regressions against code that works today — a completed run that exits
`2` and leaves tmux and Terminal windows open, and a `wipe-issue` that refuses on
a clean clone and pushes the owner toward `--force`. Both are fixable by moving
the call after `detachIssue`, downgrading refusals to logged results, and leaving
`src/wipeIssue.ts:273` alone. cursor (`d049e7b7`) needs finding 4 resolved and
the batch abort in its Risks section replaced with per-clone refusal.

# Plan review — issue 95 (reviewer: claude)

Plans reviewed at their bound commits:

- cursor `50a6f7c0dc6941c61ae17aa1890015137b5d651f` at `.plans/issue-95/plan.md`
- codex `95ffc31408fb69bc596d2c863fd34df3977b1afa` at `.plans/issue-95/plan.md`
- claude `8eb124c6495be6c19cb12afd3531c225b86166f5` at `.plans/issue-95/plan.md`

All three plans agree on the substance the issue asks for: delete the live
`describe("version bump ship gate")` case from `test/versionBump.test.ts`, keep
`.github/workflows/version-bump.yml` and `pnpm check:version-bump` as the sole
gate, leave workspace `checks` alone, correct the four agent-facing surfaces,
and retire the `test:fast` rewriting wrapper. The findings below are about
places where a plan, followed literally, produces a commit that cannot land or
evidence that cannot prove the acceptance criteria.

Facts used below were measured in this clone at baseline
`4d65f30bd3c33edf83fc678b69f4cf3fa678f3a9`, not assumed.

## Findings

### 1. Both peer plans require an `AGENTS.md` edit but name no mechanism that can stage it (cursor and codex)

**Claim.** cursor, *Exact File List → Changed → `AGENTS.md`*: "Edit the tracked
file; do not clear `skip-worktree` or strip the clone-local protocol overlay,"
with the mitigation under *Risks* reading "edit only that sentence; do not clear
index flags." codex, *Exact File List → `AGENTS.md`*: "Preserve the clone-local
skip-worktree overlay and its index bit while updating the tracked
documentation," with the mitigation "Do not clear skip-worktree or replace the
working copy to stage the documentation edit."

**Rule.** `AGENTS.md` carries `skip-worktree` in every agent clone
(docs/repo-map.md:46 states it as an invariant; `git ls-files -v -- AGENTS.md`
prints `S` in this clone right now). Git refuses to take worktree content for a
`skip-worktree` path into the index. A plan that lists a file as changed must
name a route by which the change actually reaches a commit, because the
implementer is forbidden from clearing the bit to make an ordinary edit work.

**Concrete failure.** The implementer edits the sentence in the worktree
`AGENTS.md` and stages it. Two outcomes, both bad, both reproduced in a
throwaway repository:

- `git add AGENTS.md` exits **1** with "paths … matched paths that exist outside
  of your sparse-checkout definition, so will not be updated in the index," and
  the index still holds the old blob. The implementer is now stuck at exactly
  the point the plan gave no instruction for, and the obvious unblock —
  `git update-index --no-skip-worktree` — is the forbidden move.
- `git add -A` or `git commit -am` exits **0**, silently omitting the path. The
  commit lands green, the pre-commit hook passes, `git status` is clean, and
  `AGENTS.md` still tells every agent that `check:fast` requires
  `package.json` > `origin/main`. Acceptance criterion 4 is unmet and nothing in
  the run says so. This is the likely path, because the sequence that reaches
  it is the one an agent uses by habit.

Both mitigations state the prohibition ("do not clear the bit") without the
positive instruction, so neither prevents the silent case. codex's "inspect the
committed AGENTS blob separately from the clone-local overlay" is a check after
the fact, not a way to produce the commit; it would catch the silent failure
only if the implementer thinks to run it.

**Smallest correction.** Name the blob-level route in the file-list entry:
`git show HEAD:AGENTS.md` → edit into a scratch file → `git hash-object -w` →
`git update-index --cacheinfo 100644,<blob>,AGENTS.md` → **immediately**
`git update-index --skip-worktree -- AGENTS.md` → commit without `-a`. Rehearsed
in a throwaway repository: `--cacheinfo` does flip the flag to `H`, the re-set
restores `S`, the commit carries the edited content, the worktree overlay is
untouched, and `git status` ends clean. Add the postcondition
`git ls-files -v -- AGENTS.md` prints `S` before committing, and escalate rather
than improvise if it does not. (The claude plan carries this route under
*Risks and Mitigations*; either peer plan can adopt it verbatim.)

### 2. cursor's file map instructs the `0.0.18` → `0.0.19` bump inside this change set, then forbids it two clauses later

**Claim.** cursor, *Exact File List → Changed → `package.json`*: "(3) On the PR
branch **once before merge**, bump `"version"` from `0.0.18` to `0.0.19` so the
PR Action passes; do **not** bump on intermediate implement/revise commits after
the live ship-gate test is removed." The *Risks* section reinforces the first
half — "list the one-time `0.0.18` → `0.0.19` bump in this plan's file map" —
and the *Conclusion* repeats "Bump `package.json` once to `0.0.19` on the PR
branch before merge."

**Rule.** Acceptance criterion 1 is a statement about a branch state: `pnpm
check:fast` must pass **on an `issue-*` branch whose `package.json` equals
`origin/main`**. The implementation evidence is the only place that state is
observable, so the implement commit must leave the version where it is. A plan's
file list is read as the instruction for that commit, and it cannot both direct
and prohibit the same edit.

**Concrete failure.** `package.json` is `0.0.18` on this branch and
`origin/main:package.json` is also `0.0.18` (measured). An implementer reading
the file list top-down bumps to `0.0.19`. Now the branch is strictly ahead of
`origin/main`, so the **deleted** ship-gate case would have passed too — the
green `pnpm check:fast` proves nothing about whether the gate was removed. A
reviewer cannot distinguish "the live gate is gone" from "the live gate was
satisfied by the bump," and the one criterion this issue exists to establish
goes unproven. The failure is silent: every command is green.

**Smallest correction.** Strike clause (3) from the `package.json` file-list
entry and keep it only where cursor already has it right — as a separate
merge-preparation commit on the PR branch, outside the implement step. State in
the file list that `"version"` is **not** touched by this change, and that
leaving it equal to `origin/main` is the evidence for acceptance criterion 1.

### 3. cursor's softened version assertions are routed through the helper they are meant to check

**Claim.** cursor, *Exact File List → Changed → `test/cli.test.ts`*: "assert
`coord --version` / `-V` / `version` against the version read from repo-root
`package.json` at test time (same source `packageVersion` / CLI use)"; the
`test/install.test.ts` entry says "the same."

**Rule.** A test's expected value must come from a source independent of the
code under test. docs/repo-map.md:70-72 already records this exact defect in the
current wrapper — it "compares `package.json`'s version against itself, so a
real `coord --version` regression will not fail the suite" — and cursor's own
*Alternatives Rejected* cites that vacuity as a reason to delete the wrapper.
Replacing it with a differently-shaped tautology does not clear the objection.

**Concrete failure.** `runCli` prints `packageVersion(coordinatorSourceRoot)`
(src/cli.ts:777), and `packageVersion` (src/install.ts:107-110) ends
`return parsed.version ?? "0.0.0"`. Introduce any typo in that reader — a
mis-spelled key, a wrong `installRoot` — and it returns the `"0.0.0"` fallback.
If the test computes its expectation by calling `packageVersion`, both sides
return `"0.0.0"` and the test is green while `coord --version` prints `0.0.0`.
The same helper feeds the version stamped into the emitted config that
test/install.test.ts:166 asserts, so **both** softened assertions go green
together on a single regression, and `coord --version` — the command the driver
docs tell operators to use to confirm which build is installed — silently lies.

**Smallest correction.** Require the tests to read the manifest themselves:
`JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version`,
with `repoRoot` from `./support/workspaceFixture.js` (already imported by both
test files). Delete the parenthetical "(same source `packageVersion` / CLI use)"
so the independence is not optional. codex reaches the same place via a
`test/support/workspaceFixture.ts` export and states the independence
requirement explicitly under *Risks*; either shape works, the parenthetical does
not.

### 4. cursor removes the last automated coverage of the check it is promoting to sole gate

**Claim.** cursor, *Exact File List → Changed → `test/versionBump.test.ts`*:
delete the ship-gate block and "Drop the unused `checkVersionBump` import,"
combined with *Alternatives Rejected*: "Add a new fixture-based vitest suite
that calls `checkVersionBump` against a temp git repo: **deferred** — useful
later, not required for acceptance; CI/Action plus the standalone script remain
the enforcement path."

**Rule.** When a plan reduces two enforcement points to one, the survivor's
decision logic must keep automated coverage. Nothing else in `pnpm check` will
exercise it, and the gate's failure mode is silent success rather than a red
suite.

**Concrete failure.** After this change, `checkVersionBump` has zero callers
under vitest; its only consumer is src/checkVersionBump.ts behind the Action.
The function still owns three decisions — the base-branch exemption, the
dotted-triple rejection, and the strict ordering. Break the exemption
(src/versionBump.ts:83-88) so it matches more heads than intended, and
`enforce: false, ok: true` is returned for a PR head: `pnpm check:version-bump`
exits 0, the `version-bump` job goes green, and a PR merges into `main` without
advancing `0.0.N`. `pnpm check:fast`, `pnpm check`, and every focused vitest run
stay green throughout. The first signal is an operator reinstalling and finding
`coord --version` unchanged after a merge — the exact regression this repository
versions to prevent. cursor's B1 row covers this only as a manual run of
`pnpm check:version-bump` during implement, which tests the code as it exists at
that moment and nothing afterwards.

**Smallest correction.** Undefer the fixture: build a temp repo in
`test/versionBump.test.ts` with `main` at `0.0.1`, then assert
`checkVersionBump(tmp, { baseRef: "main", headRef: … })` returns
`enforce: true, ok: false` for an equal head version, `ok: true` for `0.0.2`,
and `enforce: false` for `headRef: "main"`. It needs no network and no
`origin/main`, which is what made the deleted case unsatisfiable. Keep the
`checkVersionBump` import rather than dropping it.

### 5. codex's hermetic fixture omits the one branch that can disable the gate silently

**Claim.** codex, *Exact File List → `test/versionBump.test.ts`*: replace the
live assertion with a fixture "proving that the dedicated check rejects an equal
branch version and accepts a strictly greater branch version." The *Risks*
section separately promises to "Preserve all comparison and base-branch bypass
behavior," but no test in the *Tests* section exercises the bypass.

**Rule.** Cover the decision whose wrong answer is invisible. A broken
comparison turns the gate red and is noticed immediately; a wrongly-taken
exemption turns it green and is noticed only after a bad merge ships.

**Concrete failure.** `checkVersionBump` returns `enforce: false, ok: true`
whenever `onBase` is true (src/versionBump.ts:83-92), where `onBase` compares
the resolved head against `baseBranch`, `baseRef`, and the literal `"main"`. In
the workflow, `actions/checkout@v4` on a `pull_request` event leaves a detached
HEAD, so the `symbolic-ref` probe fails and the head resolves to the literal
string `"HEAD"` via the `rev-parse --abbrev-ref` fallback (src/versionBump.ts:75-81).
Anyone "tidying" that fallback — treating an unresolvable head as the base
rather than as a feature branch — flips `onBase` to true for **every** PR. Both
of codex's fixture cases pass `headRef` explicitly and would stay green, so the
suite reports success while `pnpm check:version-bump` exits 0 on every pull
request and the merge gate is gone.

**Smallest correction.** Add a third case to the same fixture:
`checkVersionBump(tmp, { baseRef: "main", headRef: "main" })` returns
`enforce: false`, and assert `enforce: true` in the two feature-branch cases
rather than only checking `ok`. That pins which side of the branch each input
lands on.

### 6. codex's implementation sequence defines a commit boundary that cannot pass the declared precommit

**Claim.** codex, *Implementation Sequence*, step 1: "Make the version
expectations in the CLI and installer tests consume the manifest-derived test
value, then simplify the fast-test script. This first removes the companion-file
and self-modifying-worktree traps." Step 2 is where the live ship assertion is
replaced. The plan does not say whether the steps land as one commit or several.

**Rule.** Every commit boundary a plan defines must be able to pass the declared
`verify.precommit`, which in this repository is `pnpm check:fast` (AGENTS.md:124).
A sequence presented as ordered stages is read as a commit order.

**Concrete failure.** `package.json` is `0.0.18` and `origin/main` is `0.0.18`
(measured), so the live ship-gate case is red on this branch **right now**. An
implementer who finishes step 1 and commits runs `pnpm check:fast` and gets
"requires package.json to advance past origin/main" — from the very test step 2
was going to delete. The unblocks available at that moment are: bump the version
(the practice this issue removes, and the move that destroys the acceptance
criterion 1 evidence — see finding 2), skip the hook, or abandon the stated
order. The plan's own step 1 rationale, "this first removes the traps," is
inverted here: on this branch, step 1 alone is the trap.

**Smallest correction.** Either swap steps 1 and 2 so the live case is deleted
first, or state that steps 1–4 land in a single commit. Adding the measured fact
— head and base are both `0.0.18`, so `check:fast` is red until the deletion
lands — makes the ordering constraint self-evident to whoever implements it.

## Conclusion

The three plans converge on the same correct change set, so the choice between
them turns on the findings above rather than on approach.

codex's plan is the strongest of the two peers: it explicitly forbids the
mid-protocol version bump, treats the pre-bump `pnpm check:version-bump` failure
as an expected negative rather than a defect, and states the test-independence
requirement that finding 3 raises against cursor. It needs finding 5 (a
base-branch-bypass case in the fixture) and finding 6 (a stated commit
boundary); both are additions, not rework.

cursor's plan needs findings 2, 3, and 4 before it is safe to implement.
Findings 2 and 3 are the load-bearing ones: as written, the file list directs
the bump that erases the evidence for acceptance criterion 1, and the softened
assertions are routed through the helper they exist to check, reproducing the
vacuity that cursor's own *Alternatives Rejected* cites as grounds for deleting
the wrapper. Finding 4 leaves the surviving gate without automated coverage of
its decision logic; the deferred fixture is small and should be undeferred.

Finding 1 applies to both peers and is the one most likely to produce a
green-but-wrong result, because `git add -A` omits a `skip-worktree` path
silently and exits 0. Whichever plan is selected should carry the blob-level
route and the `git ls-files -v -- AGENTS.md` → `S` postcondition in the
`AGENTS.md` file-list entry, not merely the prohibition against clearing the
bit.

No finding here argues against the issue's direction: removing the live gate,
keeping the PR workflow as the sole enforcement point, and retiring the
`test:fast` wrapper in the same change set are right in all three plans.

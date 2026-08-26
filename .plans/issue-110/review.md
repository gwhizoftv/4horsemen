# Issue 110 plan review

Bound inputs (exact pins from the action):

- claude `493590055e2a1d670328f7bfdf8e0b7a587b42ac` `.plans/issue-110/plan.md`
- cursor `d7b899ec300f0337cb0aa51b9cb769b7f2a1c6b7` `.plans/issue-110/plan.md`
- codex `da91466d268ecc83745f04ef303b6d8c27bceb35` `.plans/issue-110/plan.md`

## Findings

### 1. Cursor — response path is outside the harness write grant, and the plan never updates the launcher

**Plan claim:** Cursor Design / Public action union and Exact File List put
`responsePath` at
`<coord-root>/issue-<n>/agents/<agent>/responses/<actionId>.json`
(`paths.ts`, `action.ts`, `runLoop.ts`) and do not list
`scripts/lib/launcher.sh` or any install/launcher grant change.

**Rule:** A ballot response path the agent is instructed to write must be
reachable under the harness's actual writable grant, or the Exact File List
must change that grant. Today `scripts/lib/launcher.sh` grants only
`<completesRoot>/issue-<n>/<agent>` (`--add-dir`), and `src/paths.ts`
documents that this mailbox is deliberately outside `coordRoot` so agents do
not hold a write grant on coordinator state.

**Concrete failure:** Following Cursor as written, sandboxed agents receive a
response action that names a path under `coordRoot/.../agents/.../responses/`.
The launcher never grants that directory. The agent cannot create the file,
never writes a valid `response <actionId>` marker pair, and the ballot gate
stalls on perpetual correction/reissue (or agents escape the sandbox ad hoc,
breaking the confinement model the rest of the plan assumes).

**Smallest correction:** Either (a) keep the issue-root response path and add
`scripts/lib/launcher.sh` (+ install tests) that grant exactly
`.../agents/<agent>/responses` (and never the issue root / peer dirs /
archive), as Codex does; or (b) place working responses under the existing
per-agent mailbox subtree as Claude does, and drop any claim that no launcher
change is required.

### 2. Cursor — Exact file lists are not exact for the new modules

**Plan claim:** Exact file list to be created allows
`src/ballotResponse.ts` / `src/ballotEvidence.ts` “or equivalently tight
modules under existing files if a new file is unnecessary” / “May live in
`mirror.ts` only if it stays small”, and says tests may instead be “clearly
named suites in the touched test files”.

**Rule:** The Exact File List / Exact file list to be created headings must
name the files an implementer will actually add or change. Optional
relocations are not an exact map; reviewers and the later comparison cannot
pin a layout the plan declined to choose.

**Concrete failure:** Two implementations of “the Cursor plan” can put ballot
IO in `action.ts`, publish assembly in `runLoop.ts` or `mirror.ts`, and bury
coverage inside `runLoop.test.ts` with no `ballotResponse`/`ballotEvidence`
files. Plan review, comparison, and “did we implement the selected plan?”
checks then disagree about missing files with no plan-level resolution.

**Smallest correction:** Pick one layout. Either commit to the four new paths
(`src/ballotResponse.ts`, `src/ballotEvidence.ts`, and their two test files)
or name the existing files that absorb each responsibility and delete the
“or equivalently” escape hatches.

### 3. Cursor — final PR body evidence tip is not on the file map

**Plan claim:** Reporting and cleanup / Conclusion require status, issue
report, and final PR body to name the evidence branch and tip. The Exact File
List changes `src/issueReport.ts` and `src/cli.ts` but never `src/githubIssue.ts`
(where finalization PR title/body are formatted after #112).

**Rule:** Every acceptance surface named by the issue and the plan must appear
in the Exact File List with a concrete edit. “PR body” is not satisfied by
status/report-only changes.

**Concrete failure:** An implementer updates `issueReport`/`status` only.
`publishAcceptedFinalization` keeps emitting a PR body without the evidence
branch/tip. The acceptance criterion “Status, issue report, and PR body
identify the evidence branch and tip” fails while the plan still looks
complete.

**Smallest correction:** Add `src/githubIssue.ts` (and `test/githubIssue.test.ts`)
to the changed list with the same evidence branch/tip + non-cryptographic
provenance note Codex/Claude already specify.

### 4. Claude — plans to edit skip-worktree `AGENTS.md` in this clone

**Plan claim:** Exact File List to be changed includes `AGENTS.md` (with
`templates/product/AGENTS.protocol.md` and `templates/product/AGENTS.md`) so
ballot actions are answered by response file + marker with no commit/push.

**Rule:** Coordination sets `skip-worktree` on clone-local `AGENTS.md`. Agents
must not clear that bit, strip the protocol overlay, or stage the worktree
copy. If the tracked preamble needs a wording change, escalate to the owner;
templates may still be updated.

**Concrete failure:** Implementing Claude’s file map requires changing
`AGENTS.md`. Staging it either clears skip-worktree (forbidden) or risks
committing the clone-local protocol overlay into the product branch. The PR
then either violates the coordination protocol or ships overlay text that was
never meant to be tracked.

**Smallest correction:** Remove root `AGENTS.md` from the changed list. Keep
the two `templates/product/` updates. Escalate any repository-specific
preamble edit to the owner (Cursor/Codex already do this).

### 5. Claude — plans an issue-branch `package.json` version bump

**Plan claim:** Exact File List changes `package.json` with a pre-1.0 advance
`0.0.23 → 0.0.24` “made once on the PR-ready commit”.

**Rule:** In this repository the `0.0.N` advance is performed by CI after merge
to `main` (#108 / `version-bump-on-merge`). Ordinary issue-branch commits and
plans must not list `package.json` solely to claim a version number.
`pnpm check:fast` / `pnpm check` do not require the manifest to be ahead of
`origin/main`.

**Concrete failure:** Following Claude adds a manual version commit to the
issue/PR branch. That races the post-merge bumper, can collide with concurrent
releases, and contradicts the documented “never plan a version bump on an
issue branch” rule other accepted plans already follow.

**Smallest correction:** Delete the `package.json` bump from the file map and
from any PR-ready checklist (as Cursor and Codex already state).

### 6. Claude — first evidence commit parent / tree recipe is internally inconsistent

**Plan claim:** Design says the evidence branch initializes from
`start.branchTemplate` + reserved agent and that the first commit descends from
the issue baseline. `src/mirror.ts` work says
`createEvidenceCommit` materializes a worktree “from `parentSha` (or an empty
tree for the first commit's parent when `parentSha` is the baseline)”.

**Rule:** The first evidence commit’s Git parent must be the issue
`baselineSha` (later commits parent at the last published evidence tip). The
plan’s commit-creation steps must not contradict that parent pointer with an
alternate “empty tree parent” recipe.

**Concrete failure:** An implementer reading the mirror bullet can create a
first evidence commit whose parent is the empty tree (or whose worktree is
unrelated to baseline) while another implementer parents at `baselineSha`.
History, FF checks against “expected parent = baseline”, and tests that assert
baseline descent then diverge; non-FF recovery logic keyed on the planned
parent becomes wrong for one of the two readings.

**Smallest correction:** Delete the empty-tree parent aside. Specify: first
commit `parent = baselineSha`, tree = baseline tree plus canonical ballot
paths (or an explicit documented sparse tree that still has `parent =
baselineSha`); every later commit `parent = prior evidence tip`.

### 7. Claude — wipe remediation names a non-existent CLI command

**Plan claim:** Risks say the format-4 error “names the exact `coord wipe
<issue>` remediation”; Tests say format 3 is rejected with the wipe/restart
message. (Elsewhere Claude correctly discusses `wipe-issue` and
`--delete-evidence`.)

**Rule:** Fail-closed remediation text and tests must name the real owner
command. The CLI command is `coord wipe-issue`, not `coord wipe`.

**Concrete failure:** Operators following the error string run a command that
does not exist, fail to clear incompatible runtime state, and cannot start the
issue under format 4. Tests that assert `coord wipe` in the message lock in the
wrong string.

**Smallest correction:** Use `coord wipe-issue <issue>` everywhere (message,
docs, tests), consistent with Codex and the current `src/cli.ts` surface.

### 8. Codex — treating full `wipe-issue` as the evidence-deletion switch underspecifies “retain by default”

**Plan claim:** Exact File List / step 9 say normal completion never deletes the
evidence branch, and “the destructive owner-invoked `coord wipe-issue`
operation may explicitly remove it alongside the issue's agent/final
branches”.

**Rule:** Issue acceptance: normal issue cleanup retains the evidence branch;
deletion requires an **explicit** owner action aimed at that retention policy.
`wipe-issue` today resets clones/runtime/agent and `*-final` branches. If
evidence deletion is folded into that default destructive path with no
separate opt-in, “retain after cleanup” and “explicit deletion” collapse into
one blunt hammer.

**Concrete failure:** An owner runs `coord wipe-issue` to clear a stuck runtime
(common remediation for format mismatches) and silently deletes the audit
branch the issue required to retain. Restoring ballots then depends on
accidental remote reflog survival, which is not an owner-controlled retention
policy.

**Smallest correction:** Keep Codex’s reserved-branch recognition, but make
evidence deletion opt-in (e.g. Claude’s `--delete-evidence` on `wipe-issue`,
default off), and test that default `wipe-issue` retains
`issue-<n>/coordinator-evidence` on origin.

## Conclusion

Codex is the strongest mechanical contract: strict Git-vs-response action
union, launcher grant pairing, distinct `AcceptedResponse` vs publication
outbox, exact-SHA retry, roster supersession, `githubIssue` PR evidence lines,
and template/`AGENTS.md` skip-worktree handling. It should be the starting
plan only after Finding 8 (evidence retention vs default wipe) is fixed.

Cursor matches the issue shape and keeps protocolVersion/format concerns
clear, but is not implementable as written for sandboxed agents (Finding 1),
leaves new-module layout non-exact (Finding 2), and omits the PR-body file
(Finding 3).

Claude’s mailbox response path and `--delete-evidence` retention instinct are
valuable, but the plan is blocked by forbidden `AGENTS.md` edits, a
disallowed version bump, a contradictory first-evidence-commit recipe, and a
wrong wipe command name (Findings 4–7).

Do not implement any of the three unchanged. Merge Codex’s file map and
publication machinery with Cursor/Claude’s clearer “default retain evidence”
wipe behavior, Cursor’s insistence on a fixed module layout once chosen, and
Claude’s (or Codex’s) launcher/mailbox grant story so the response path and
`--add-dir` surface agree.

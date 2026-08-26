# Issue 110 plan review — claude

Bound plans reviewed:

- claude — `493590055e2a1d670328f7bfdf8e0b7a587b42ac` at `.plans/issue-110/plan.md`
- cursor — `d7b899ec300f0337cb0aa51b9cb769b7f2a1c6b7` at `.plans/issue-110/plan.md`
- codex — `da91466d268ecc83745f04ef303b6d8c27bceb35` at `.plans/issue-110/plan.md`

All three plans agree on the substance the issue asks for: a strict Git/response
action union, an action-scoped private response holding only choice/disposition
plus rationale, coordinator-computed digests, an accepted-response record kept
distinct from `AcceptedSubmission`, a durable outbox that re-pushes one exact
commit SHA, fast-forward-only publication to a dedicated evidence branch, and a
publication barrier before any #109 derivation or advance. The findings below
are about where each plan's stated mechanism does not survive contact with code
that already exists in this repository.

The single largest divergence between the three is **where the agent writes its
response**, and that choice decides whether the ballot phase works at all.

## Findings

### 1. cursor `d7b899ec300f0337cb0aa51b9cb769b7f2a1c6b7`: the response path is outside every grant the agent has, and no plan item widens it

**Claim.** cursor's "Public action union" renders
`responsePath: <coord-root>/issue-<n>/agents/<agent>/responses/<actionId>.json`,
and its `src/paths.ts` entry adds confined helpers for
`agents/<agent>/responses/<actionId>.json` under the issue runtime. Its Exact
File List names no file under `scripts/`.

**Rule.** The agent's harness can only write inside the writable roots its
generated launcher grants. `scripts/lib/launcher.sh` builds exactly one such
root, and states the rule in its own comment at the point of construction:
"Grant this harness exactly one extra writable directory: the current issue's
own drop inside the completion mailbox. Not the coordinator runtime (which
holds cursors.json, the journal, and peers' orders) and not the whole mailbox
(which holds peers' receipts)." The generated body resolves that one root from
the clone-local `coord.completesRoot` key plus `COORD_ISSUE`, and passes it as a
single `--add-dir`. The clone records `coord.completesroot` and
`coord.workspaceconfig`; it records no coordinator-runtime key that a launcher
could use to derive an issue root.

**Failure.** Codex-vendor agents are launched as
`codex --ask-for-approval never --sandbox workspace-write "${coord_grant[@]}"`.
Under cursor's plan the ballot response must be written to a path inside the
coordinator runtime, which is not the clone and not the granted drop. The write
is refused by the sandbox, so the response never exists; because the agent is
also told to write the marker only after the response, no marker appears either.
The coordinator sees a missing completion marker, which is indistinguishable
from an agent that has not answered yet, so it keeps re-delivering the same
action. Every ballot gate stalls indefinitely with no owner question and no
outstanding-item text that can name the cause. The same failure hits `R5` and
every `R6` round.

**Smallest correction.** Put the response at
`<completesRoot>/issue-<n>/<agent>/responses/<actionId>.json`. That subtree is
already inside the one directory the launcher grants and the one directory
`createIssueRuntime` already creates per agent, so the plan needs no launcher
change, no new git config key, and no re-install. Confinement is inherited from
the existing `containedPath` / `assertNoSymlink` checks against
`paths.completesRoot`.

### 2. cursor `d7b899ec300f0337cb0aa51b9cb769b7f2a1c6b7`: `hash-object` / `mktree` plumbing cannot run through the mirror's runner, and fails silently rather than loudly

**Claim.** cursor's "Evidence branch and batch commit" says: "Build the commit in
the bare mirror via `hash-object` / `mktree` / `commit-tree` (or equivalent
plumbing already used by the mirror)." Its `src/mirror.ts` entry adds "plumbing
to create a commit in the bare mirror from a parent SHA + path/content map (no
worktree required for the happy path)".

**Rule.** `git hash-object --stdin` reads the blob body from standard input and
`git mktree` reads its tree listing from standard input. `runGitCommand` in
`src/mirror.ts` spawns every git invocation with
`stdio: ["ignore", "pipe", "pipe"]`, and `GitRunner` is typed
`(args, options?: { cwd?: string }) => Promise<CommandResult>` — there is no
`input`, `stdin`, or `env` channel. No plumbing of this shape "already used by
the mirror" exists: the mirror's only object-producing call today is
`materializeWorktree`.

**Failure.** With stdin at `/dev/null`, `git mktree` reads EOF immediately and
succeeds, printing the empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`.
`git commit-tree` then succeeds against that tree, `publishBranch` pushes it as
a normal fast-forward, and the batch is persisted with `status: published`. The
barrier is satisfied, `derive-plan-selection` runs, and the gate advances — with
an evidence commit that contains **zero ballot files**. The failure is silent:
every exit code is `0`, so no retry, no conflict, and no owner question fires,
and the only symptom is an audit branch whose commits have empty trees. A second
defect compounds it: `mktree` builds one flat tree level, while the canonical
paths (`.plans/issue-<n>/ballot-<agent>.json`,
`.code-reviews/issue-<n>/consensus-ballot-<agent>-round-<r>.json`) are two levels
deep and need recursive tree assembly that the plan does not budget for.

**Smallest correction.** Either add an explicit stdin/`env` channel to
`GitRunner` and `runGitCommand` as a named file-map item and test the tree
contents byte-for-byte, or build the commit in a coordinator-owned detached
worktree from the existing `materializeWorktree` / `removeWorktree` pair (which
gives an index, so `add` + `commit -c user.name -c user.email` needs no new
stdin path). Either way the plan must assert the created commit's tree lists
exactly the batch's paths, because an empty tree is currently a *passing* result.

### 3. codex `da91466d268ecc83745f04ef303b6d8c27bceb35`: widening the launcher grant into the coordinator runtime reverses a stated invariant and lands only on re-install

**Claim.** codex's `scripts/lib/launcher.sh` entry: "derive the current agent's
response directory from clone-local `coord.workspaceConfig` plus `COORD_ISSUE`,
and grant both that directory and the existing per-agent completion mailbox as
narrow `--add-dir` entries."

**Rule.** Two rules apply. First, `scripts/lib/launcher.sh` states the grant
invariant it is enforcing: the coordinator runtime is excluded *because* it holds
`cursors.json`, the journal, and peers' orders — and this issue independently
requires that pending peer responses never be disclosed. Second, the generated
launcher lives in the agent clone and is re-rendered only by `coord install` or
`githooks/post-merge`; the same comment records why there is no re-render at
`coord start` ("re-rendering the file at `coord start` would make the
coordinator write inside agent clones"). `coord doctor` only compares the
install-root HEAD against the recorded stamp commit and reports drift.

**Failure.** Two distinct failures follow. (a) The narrow grant is
`<coordRoot>/issue-<n>/agents/<agent>/responses`, whose parent holds that agent's
`action.md`. Granting a child directory does not by itself expose the parent, so
the plan is defensible — but it moves an agent-writable directory *inside* the
tree the product currently guarantees is agent-free, and codex's plan does not
name a test asserting that the sibling `action.md`, the archive directory, and
peer agent directories stay outside the grant for every vendor. (b) More
concretely: an operator who upgrades the install root but does not re-run
`coord install` keeps the previously generated one-grant launcher in every
clone. The first ballot action after the upgrade then fails exactly as in
finding 1 — a denied write, no marker, an indefinite stall — while
`coord doctor` reports only a generic stamp-commit mismatch that says nothing
about ballot responses.

**Smallest correction.** Either use the already-granted mailbox subtree (no
launcher change, no re-install dependency), or add a start-time assertion that
the clone's generated launcher contains the response grant and fail
`coord start` with the exact `coord install` remediation when it does not.
`test/install.test.ts` coverage alone tests the template, not the clones a live
workspace actually runs.

### 4. cursor `d7b899ec300f0337cb0aa51b9cb769b7f2a1c6b7`: canonical ballots gain required fields while keeping `protocolVersion: 1`

**Claim.** cursor's "Runtime format" says "Artifact `protocolVersion` for
published ballots remains **1**", and its `src/protocol.ts` entry says "extend
published plan/comparison/consensus ballot schemas with `actionId` +
`responseSha256` (keep `protocolVersion: 1`)".

**Rule.** The issue's canonical-ballot block specifies `"protocolVersion": 2`,
and the existing ballot schemas are `.strict()` with `protocolVersion:
z.literal(1)`. A version literal exists so that two incompatible shapes are
distinguishable by inspection.

**Failure.** After this change, two mutually incompatible `.strict()` shapes both
claim version 1: the agent-authored ballot that exists on every issue branch
already merged into `main`, and the coordinator-authored ballot with required
`actionId` and `responseSha256`. Any consumer that reads a ballot blob without
knowing which branch it came from — a later audit tool, a cross-issue check, or
a `test/protocol.test.ts` fixture carried forward — cannot discriminate them, and
a strict parse of an old ballot against the new schema fails with a missing-field
error rather than a version error, so the diagnostic points at the wrong thing.

**Smallest correction.** Take `protocolVersion: 2` for the three canonical ballot
artifacts as the issue specifies, and leave the four Git artifacts at 1.

### 5. cursor `d7b899ec300f0337cb0aa51b9cb769b7f2a1c6b7`: evidence-branch retention is already the default, so the planned work is a no-op while the real gap (reporting) is unnamed

**Claim.** cursor's cleanup entry: "default cleanup retains
`issue-<n>/coordinator-evidence`; ... do not silently `push :branch` the evidence
ref during ordinary wipe unless the owner opts in."

**Rule.** A plan item must name work the implementation actually has to do; an
item that restates existing behavior consumes a file-map slot without producing a
test that would catch a regression.

**Failure.** `src/wipeIssue.ts` already keeps the branch: `rosterByBranch` is
keyed by rendered agent branches and `finalBranches` by `<branch>-final`, so for
`issue-N/coordinator-evidence` the guard `if (agent === undefined && !isFinal)`
takes the keep path before any delete. Implementing cursor's item changes
nothing, and the only observable defect goes unaddressed — the keep is logged as
`keeping origin/issue-N/coordinator-evidence (not a clone or publication
branch)`, which tells the owner the branch was an unrecognized leftover rather
than retained ballot evidence. An owner reading that line cannot distinguish
deliberate retention from an accident, which is precisely the distinction the
issue's retention requirement exists to make.

**Smallest correction.** Replace the retention item with a reporting item: give
the evidence branch its own recognized keep reason in `src/wipeIssue.ts`, and
assert the message in `test/wipeIssue.test.ts`. codex's plan is closer here — it
makes deletion an explicit `coord wipe-issue` behavior that reports itself — and
`coord run` teardown is `detachCompletedIssue`, which only kills tmux sessions
and never wipes, so codex's "normal completion never deletes it" is accurate.

### 6. codex `da91466d268ecc83745f04ef303b6d8c27bceb35`: the publication barrier is specified as a gate but never as a trigger

**Claim.** codex's `src/machine.ts` entry: "Once the active denominator is
complete, require a published batch matching the current roster/round/input set
before tallying, escalating, asking for revision, deriving a decision, or
advancing." Its `src/runLoop.ts` entry: "Freeze complete response sets into
publication outboxes, retry the persisted commit SHA, and invoke #109 derivation/
routing only after origin publication." Neither entry names what causes the
freeze to happen, and the plan adds no `MachineDecision` variant.

**Rule.** `decide()` is the only thing that tells `runTick` a denominator has
closed, and `runTick` acts only on non-`wait` decisions: it computes
`decide({ start, cursors }).filter((decision) => decision.type !== "wait")` and
`break`s when the filtered list is empty.

**Failure.** Under the reading where `machine.decide` returns
`{ type: "wait" }` while the batch is unpublished — which is what "require a
published batch ... before tallying" describes — the filter drops it, the
progress loop breaks, and the tick ends having done nothing. The next tick
repeats it. The batch is never created, so it can never become published, so the
wait never clears: the issue deadlocks permanently after the last agent responds,
with every response accepted, no owner question raised, and `coord status`
showing a step that is silently finished. The alternative reading (runLoop
freezes the batch from its own tick code, outside `decide`) works, but the plan
does not say which, and one of the two readings is a hang.

**Smallest correction.** Name the trigger explicitly: add a
`publish-ballot-batch` decision emitted by `decide()` when the denominator is
complete and no `published` batch matches the current roster/round/input set, and
state that `runTick` applies it before the derive/advance decisions.

### 7. claude `493590055e2a1d670328f7bfdf8e0b7a587b42ac`: my own plan lists a `package.json` version bump, which this repository forbids on an issue branch

**Claim.** My Exact File List ends with "`package.json` — single pre-1.0 advance
0.0.23 → 0.0.24, made once on the PR-ready commit".

**Rule.** `.github/workflows/version-bump-on-merge.yml` performs the advance on
`main` after merge, and its header comment states the rule directly: "issue
branches sit at main's version for the whole run, and plans must not list
package.json for a bump." `AGENTS.md` says the same: neither `pnpm check:fast`
nor `pnpm check` requires the version to be ahead.

**Failure.** An implementation that follows my plan commits a version advance on
`issue-110/<agent>`. When the merge workflow then runs `node dist/bumpVersion.js`
on `main`, the number the branch already claimed is consumed twice or skipped, and
the workflow's own comment explains why that matters: a skipped release number
leaves `main` at a version some clone has already installed.

**Correction.** Drop the `package.json` line from my file map. Both peer plans
declined the bump correctly; cursor and codex are right and I am wrong on this
point.

## Conclusion

The blocking defects are cursor's response-path placement (finding 1) and its
`mktree`-based commit construction (finding 2). The first stalls every ballot
gate; the second advances gates on evidence commits with empty trees while
reporting success, which is worse than a stall because it destroys the audit
guarantee the issue exists to create. Finding 4 should also be corrected before
implementation.

codex's plan is the most complete of the three on state, acceptance ordering,
supersession, and canonical-byte determinism, and it is the only one that
recognized the launcher grant at all. Its two gaps are the launcher-widening
dependency (finding 3) and the unnamed publication trigger (finding 6); the
first is avoidable outright by moving the response into the already-granted
mailbox subtree, and the second is a one-line addition to the decision union.

My own plan needs finding 7 applied.

The recommended combination is codex's state model, acceptance pipeline, and
supersession handling, with the mailbox response path from my plan (which
removes findings 1 and 3 together), an explicit `publish-ballot-batch` decision,
worktree-based commit construction rather than `mktree`, `protocolVersion: 2`
canonical ballots, and no `package.json` change.

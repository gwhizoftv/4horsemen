# Issue 96 plan review

Bound plans reviewed:

- cursor `c322ff755f9ad9ba2587db71e02917807a9e9266` at `.plans/issue-96/plan.md`
- codex `8987f621e47515b123deea4be471487bf05a724d` at `.plans/issue-96/plan.md`
- claude `3b9a0c2df8c47e2ae5f0a7230e38423aea58b37a` at `.plans/issue-96/plan.md`

Every claim below was checked against the repository at
`509748020eeec09acbbb5fb333efdf6db4b945de` plus the three bound commits. Line
numbers are from that tree.

## Findings

### 1. cursor — re-preparing branches before every `writeAction` terminates the coordinator loop

**Claim.** cursor, *Exact File List to be changed or deleted*, `src/runLoop.ts`:
"call `prepareAgentIssueBranches` immediately before `writeAction` when
preparing orders (so resume and per-step recovery re-check clones even if an
agent switched away mid-issue)."

**Rule.** An operation invoked on every tick must be safe in the state the
system is normally in on a tick, and must not be able to abort the run loop.
`prepareAgentIssueBranches` is a pre-launch operation: it refuses when *any*
clone in the roster has *any* uncommitted change
(`src/prepareAgentBranch.ts:57-66`, over a bare `git status --porcelain`,
`src/gitExec.ts:71-72`), and it moves `HEAD` with `git checkout`
(`src/prepareAgentBranch.ts:88`, `:98`).

**Failure.** An agent that is executing an action has uncommitted files in its
clone — that is what "working" looks like between the action being written and
the artifact being committed. On the next tick the coordinator calls
`prepareAgentIssueBranches`, the dirty gate throws
`Refusing to check out issue branches: uncommitted changes in <clone>`, `runTick`
rethrows anything that is not a `StateConflictError`
(`src/runLoop.ts:1290-1293`), and `run()` does not catch it
(`src/runLoop.ts:1305-1311`). The coordinator process exits and the issue
stalls, mid-flight, on the ordinary case. Two of the three `writeAction` call
sites make it worse: `src/runLoop.ts:548` and `src/runLoop.ts:921` are inside
`this.mutate(...)` callbacks, so a multi-process git operation that can throw
would run inside the state-mutation critical section, and `:921` is the reissue
path taken *after* a failed verification — precisely when the clone is dirtiest.
Even when the clone happens to be clean, the checkout and the
`git checkout HEAD -- AGENTS.md` inside `liftCloneAgentsProtocol`
(`src/agentsProtocol.ts:41-46`) would run under a live agent's feet.

**The premise is also wrong.** cursor's *Scope* item 1 asserts preparation "runs
only at start and at run-loop entry, not when individual actions are prepared,"
implying a launch the preparation does not cover. There is no such launch. Agent
CLIs start at exactly two places: `startEffects` → `tmux.startSession`
(`src/cli.ts:566`), reached only after `prepareAgentIssueBranches` at
`src/cli.ts:707`; and `tmux.ensureSession` (`src/runLoop.ts:479`) — including its
dead-pane `respawn-pane` recovery (`src/tmux.ts:657-667`) — reached only after
`prepareAgentIssueBranches` at `src/runLoop.ts:466`. Mid-issue respawn is
already behind preparation.

**Smallest correction.** Drop this change. If mid-issue drift detection is
wanted, make it a read-only check at the top of `runTick` (compare
`git rev-parse --abbrev-ref HEAD` to the computed branch) that records an
outstanding item, never a checkout and never a throw.

### 2. codex — the plan's central premise about the restore half is false, and its own tests cannot detect that

**Claim.** codex, opening paragraph: "The coordinator already owns automated
issue-branch preparation: it lifts the clone-local AGENTS.md overlay, checks out
the agent's issue branch without resetting existing work, **restores the overlay
and `skip-worktree`**, and only then launches or resumes the agent. The
remaining defect is that the generated vendor identities still order every agent
to check out and pull the base branch..."

**Rule.** A plan that declares half of a mechanism already correct must be right
about it, because everything downstream — the file list, the tests, the risk
list — is sized against that judgement.

**Failure.** The restore is not guaranteed. `prepareAgentIssueBranches` lifts the
bit unconditionally (`src/prepareAgentBranch.ts:85`) and then calls
`restoreProtocol` (`src/prepareAgentBranch.ts:33-38`), which resolves the install
root as `installRoot ?? localConfigGet(clone, INSTALL_ROOT_KEY)` and **returns
silently when that is `null`**. A vendored install deliberately records
`installRoot: null` — `src/install.ts:372` writes it, and `src/doctor.ts:188`
excuses the missing key, with the reason documented at
`src/setupWorkspace.ts:508-515`. So in every vendored workspace the lift happens,
the restore does not, and the agent is launched onto the right branch with the
bit cleared and no protocol block in `AGENTS.md` — issue 96 item 1, unfixed. The
same silent skip hits the resume path even in non-vendored workspaces:
`src/runLoop.ts:458-465` resolves the root as
`readConfig(start.configPath).coordination?.installRoot ?? null` inside a
`try/catch` that swallows any read error to `null`, where `coord start` has a
`?? coordinatorSourceRoot` fallback (`src/cli.ts:713`) and resume has none.
Second-order: once the bit is cleared, `AGENTS.md` is visibly modified, so the
*next* run's dirty gate (`src/prepareAgentBranch.ts:57-66`) throws and neither
`coord start` nor `coord <issue>` can proceed.

codex's planned coverage cannot see any of this. Its `test/prepareAgentBranch.test.ts`
work is described as asserting that created, existing, and already-current
branches "finish with the protocol overlay present and `skip-worktree` set" — but
the fixture in that file passes `installRoot: repoRoot` on every call
(`test/prepareAgentBranch.test.ts:61, 79, 100, 118`), which is the one input under
which `restoreProtocol` never takes the silent-return branch. The strengthened
tests go green while the defect ships.

**Smallest correction.** Add to codex's file list: `src/prepareAgentBranch.ts` —
`restoreProtocol` must re-set the bit unconditionally (call the skip-worktree
helper even when no install root resolves), and the lift/checkout must sit in
`try { … } finally { restore }`. Add the test case that omits `installRoot` and
unsets `coord.installRoot`, then asserts `git ls-files -v -- AGENTS.md` starts
with `S`.

### 3. cursor — three files that already exist are listed under "Exact file list to be created"

**Claim.** cursor, *Exact file list to be created*, lists `test/action.test.ts`,
`test/runLoop.test.ts`, and `test/prepareAgentBranch.test.ts`.

**Rule.** The created list is the implementer's authority for which paths do not
yet exist. A path on it is written, not edited.

**Failure.** All three exist today and carry the coverage this issue depends on —
`test/prepareAgentBranch.test.ts` is the only test of the lift/checkout/restore
sequence at the heart of issue 96, and `test/agentLanguage.test.ts:169-199`
depends on `renderAction` behaviour that `test/action.test.ts` also pins. An
implementer following the list literally creates them, destroying the existing
suites; the loss is invisible because the replacements are green. cursor's own
prose confirms the intent is additive ("add case", "extend coverage"), so this
is a list error rather than a design choice — but the list is what the
implementer follows.

**Smallest correction.** Move those three paths into *Exact File List to be
changed*, leaving only `src/automatedBranchGuidance.ts` and
`test/automatedBranchGuidance.test.ts` as created (both verified absent).

### 4. codex — the focused test command in the plan fails today, before any of the plan's changes

**Claim.** codex, *Tests* step 2:
`pnpm exec vitest run --config vitest.config.ts test/setupInstructions.test.ts test/prepareAgentBranch.test.ts test/cli.test.ts test/runLoop.test.ts test/install.test.ts`.

**Rule.** `AGENTS.md`, *Checks that actually run*: "In plans, name real
commands." A named command must actually pass on the tree it is named for.

**Failure.** `test/cli.test.ts:100` asserts `toBe("0.0.14")` while `package.json`
is at `0.0.16`. The assertion is only satisfied because the `test:fast` script
rewrites that literal to the live version for the duration of the run and
restores it in a `finally` (`package.json`, `scripts.test:fast`); the deliberate
divergence is recorded in `be82d90`. Invoking `vitest` directly bypasses that
wrapper. Run on the current tree:

```
FAIL  test/cli.test.ts > CLI version > prints package.json version
AssertionError: expected '0.0.16' to be '0.0.14'
Test Files  1 failed (1)
```

codex's plan also bumps `package.json` to `0.0.17`, which widens the gap. The
implementer's first focused run fails on an unrelated assertion before any of
the five real regressions execute, and the natural response — hand-editing the
literal — reverses the workaround `be82d90` established.

**Smallest correction.** Drop `test/cli.test.ts` from the focused command and
reach it through `pnpm test:fast`, which is the only invocation that handles the
literal. (cursor's focused command omits `test/cli.test.ts` and is unaffected;
so does claude's, which names only `pnpm check:fast` and `pnpm check`.)

### 5. codex — the planned `coord start` ordering assertion cannot observe launch

**Claim.** codex, *Exact File List*, `test/cli.test.ts`: "add an initial-start
integration assertion that the real agent clone is on the baseline-derived issue
branch with its overlay and index bit restored **when launch effects first
run**"; and *Risks*, "False confidence from unit-only branch tests: The helper
can pass while a caller launches first. Initial-start and resume integration
assertions observe clone state at the launch/tmux boundary."

**Rule.** A test that claims to pin an ordering must be able to fail when the
order is reversed.

**Failure.** `startEffects` is replaced by a no-op whenever `makeRunLoop` is
injected — `src/cli.ts:616-620`:
`dependencies.makeRunLoop === undefined ? defaultStartEffects : async () => ({ cleanup: async () => undefined })`
— and every `start` test in `test/cli.test.ts` injects `makeRunLoop`
(`:184, :225, :312, :344, :363, :442, :463`, …). There is no launch boundary in
that file to observe. The assertion collapses to "preparation ran by the time
`runCli` returned," which `test/prepareAgentBranch.test.ts` already proves more
directly, and it would pass unchanged if `startEffects` were moved *before*
`prepareAgentIssueBranches` — the exact regression it is written to catch. The
risk codex names is therefore not mitigated by the test codex plans.

**Smallest correction.** `CliDependencies` already exposes a `startEffects` hook
(`src/cli.ts:81`). Inject a spy that records
`git rev-parse --abbrev-ref HEAD` and `git ls-files -v -- AGENTS.md` for the
clone *at the moment it is called*, and assert on the recorded values. That
fails if launch moves ahead of preparation. codex's resume counterpart in
`test/runLoop.test.ts` needs no such change: `dependencies.tmux` is already
injectable, so an `ensureSession` stub can observe clone state at the real
boundary.

### 6. cursor — editing `scripts/lib/launcher.sh` moves the canonical install digest, and the banner reaches no running agent

**Claim.** cursor, *Exact File List*, `scripts/lib/launcher.sh`: "update the
generated launcher banner"; *Risks and Mitigations* does not mention install
drift or re-install.

**Rule.** A file that feeds `canonicalSourceDigest` is part of the installed
contract, and a plan that edits one must say what re-install it forces.

**Failure.** `scripts/lib/launcher.sh` is one of the seven inputs to
`canonicalSourceDigest` (`src/hookSync.ts:159-172`, path resolved at `:138`),
and it is also in `VENDOR_LIB_FILES` (`src/hookSync.ts:31`), which vendored
clones byte-compare. Changing it makes the recorded manifest digest differ from
the on-disk digest, so `detectDrift` returns `install-modified`
(`src/hookSync.ts:439-442`) and `coord doctor` reports, for every workspace
installed against the old bytes, "The canonical hook sources in the install root
differ from the bytes this workspace was installed against, with no new commit"
(`src/doctor.ts:286-293`); vendored clones additionally report `modified` or
`stale-vendor` (`src/hookSync.ts:426-437`). The finding persists until each
workspace re-runs `coord install`. Separately, the banner text is baked into each
clone's launcher script at install time (`src/install.ts:192`,
`src/setupWorkspace.ts:448`), so the new wording reaches zero already-installed
clones — including the ones this issue exists to fix — until that same
re-install. The plan leans on the banner as an agent-facing surface without
stating that dependency.

**Smallest correction.** Either drop the banner edit (the `action.md` preamble
and the protocol overlay already cover the message, and the overlay is
re-rendered on every branch preparation rather than only at install), or add
"re-run `coord install` in every workspace" to the plan's risk list and note that
the banner is install-time-only.

### 7. claude (this agent's own plan) — leaves the checkout-first session-start checklist in place

**Claim.** claude, *Exact File List*, changes `src/agentsProtocol.ts`,
`src/prepareAgentBranch.ts`, `src/runLoop.ts`, `src/steps.ts`, `src/doctor.ts`,
`templates/product/AGENTS.protocol.md`, three test files, and `package.json`.
`scripts/setup_claude.sh`, `scripts/setup_codex.sh`, `scripts/setup_cursor.sh`,
and `scripts/setup_antigravity.sh` appear nowhere in it.

**Rule.** Issue 96 item 2 is "make sure the agent knows it doesn't need to create
the branch, so it doesn't try," and the issue explicitly warns that agents "may
try to do the wrong thing" out of prior-session habit. The instruction an agent
reads *first* governs its first command, so any surface that tells it to move
off the prepared branch must change.

**Failure.** Step 1 of the generated session-start checklist in every vendor
identity is `git checkout $SHARED_BRANCH && git pull $REMOTE_NAME $SHARED_BRANCH`,
and step 2 is "determine whether the coordinator supplied an automated issue
action or the owner supplied a manual chat task"
(`scripts/setup_claude.sh:49-53`; the same line at `scripts/setup_cursor.sh:62`,
`scripts/setup_codex.sh:75`, `scripts/setup_antigravity.sh:62`). The agent is
therefore instructed to leave the prepared branch **before** it is told to check
whether it is in automated mode. Both outcomes are the reported bug: if
`AGENTS.md` is identical on both branches the checkout silently succeeds and the
agent is now on the shared branch with the overlay still applied; if it differs,
git refuses over the skip-worktree file — the refusal
`test/prepareAgentBranch.test.ts:53` already asserts — and the agent's next
instinct is to clear the bit, which the protocol forbids. Hardening the
coordinator's restore, as claude's plan does, does not stop either path.

**Smallest correction.** Add the four `scripts/setup_*.sh` generators to claude's
changed-file list and invert the checklist order: classify the session first,
and gate the base-branch checkout behind the manual branch only. This is the one
substantive thing codex's plan has that claude's does not; cursor's plan reaches
only `scripts/setup_cursor.sh` and leaves the other three vendors on the
checkout-first sequence.

### 8. cursor and codex — new agent-facing prose is added without naming the gate that scans it

**Claim.** cursor adds a preamble to every rendered `action.md`
(`src/action.ts`, `src/automatedBranchGuidance.ts`) and to
`templates/product/AGENTS.md` and `templates/product/AGENTS.protocol.md`; codex
adds a cross-vendor invariant paragraph to
`templates/product/AGENTS.protocol.md`. Neither lists `test/agentLanguage.test.ts`,
and codex's plan does not mention the constraint at all.

**Rule.** All three of those surfaces are already under an automated
banned-vocabulary invariant, so the implementer must know the constraint before
choosing the words.

**Failure.** `test/agentLanguage.test.ts:170-175` renders every step's action and
requires `findAgentLanguageViolations(body)` to be empty; `:284-289` requires the
same of `renderAgentsProtocolBlock(repoRoot)` and
`templates/product/AGENTS.md`. The banned patterns
(`src/agentLanguage.ts:47-58`) include `\bjoin(ed|ing)?\b`, `\bgates?\b`, and
`\bphases?\b` — all three are natural words for this paragraph ("before the
agent joins the issue", "at the start of each phase"). An implementer who writes
the obvious sentence fails the entire existing suite and, lacking the pointer,
will read the failure as unrelated. cursor partially covers this: its *Risks*
section names `findAgentLanguageViolations` and proposes a guidance test — that
new test is redundant with `test/agentLanguage.test.ts:170`, which already scans
the rendered actions the preamble lands in, but the awareness is there. codex has
neither the mention nor the coverage.

**Smallest correction.** Both plans should name `src/agentLanguage.ts` as a
constraint and state that the new prose must avoid "join", "gate", and "phase";
no new test file is needed, because the existing invariant already covers both
surfaces.

## Conclusion

The three plans split the problem cleanly and each is missing the other's half.

codex is the only plan that identifies what most directly causes the reported
symptom: the generated session-start checklists tell every agent to
`git checkout` the shared branch as step 1, before step 2 decides whether the
session is even automated (finding 7). That is the change issue 96 item 2 needs,
across all four vendors. But codex declares the coordinator side already correct
and it is not — the restore silently no-ops in vendored workspaces and on the
resume path, and codex's own planned tests are structurally unable to see it
(finding 2) — and two of its named checks do not do what it says: the focused
command fails today on an unrelated assertion (finding 4) and the `coord start`
ordering assertion cannot observe launch (finding 5).

cursor covers the most agent-facing surfaces and is the only plan that flags the
banned-vocabulary invariant, but its one coordinator-side change is actively
dangerous: re-preparing branches before every `writeAction` throws on any dirty
clone and takes the run loop down with it, on the ordinary tick (finding 1),
against a premise that does not hold (there is no uncovered launch site). Its
created-file list would destroy three existing test files (finding 3), and its
launcher edit moves the canonical install digest without saying so (finding 6).

claude's plan is correct about the coordinator-side defect and mechanical about
fixing it — unconditional restore in a `finally`, a bit-only fallback when no
install root resolves, resume getting the same install-root resolution as start,
a ready-state assertion before either caller launches, and a healing path for
clones already wrecked — but it stops at the boundary of the clone and never
touches the instruction that sends the agent off the branch in the first place
(finding 7).

The plan worth implementing is claude's coordinator-side mechanics plus codex's
four-vendor checklist inversion, with cursor's language-invariant awareness
carried over. Concretely: take claude's file list, add the four
`scripts/setup_*.sh` generators with the classify-before-checkout ordering, name
`src/agentLanguage.ts` as a constraint on the new prose, and adopt codex's
`startEffects`-spy correction (finding 5) so the ordering guarantee is actually
pinned by a test that can fail. Reject cursor's per-action re-preparation
outright; keep its `action.md` preamble, which claude's plan reaches by the same
route through `buildOrder`.

# Issue 124 plan review — Claude

Bound plans reviewed, all at `.plans/issue-124/plan.md`: cursor
`b173b8e4ed9946dcccf92dbc1cf50d053dba899a`, antigravity
`ae1b42852d773191ea721e56a684ff9a63262b07`, claude
`3ac5aad5d214caea6298696a855d71a1b03d05bb`, codex
`e2de333f19160e93fa0ce9d9972eaf0cfdde64bb`.

Findings 10 and 11 are against my own bound plan
`3ac5aad5d214caea6298696a855d71a1b03d05bb`; they are held to the same standard
as the rest and are, on the evidence below, among the more consequential
defects here.

All four plans converge on the same architecture — an untracked, `COORD_ISSUE`-gated
`.coord/bin/git` on the launcher's `PATH`, plus coordinator-side materialization
into `issue-<n>/inputs/<hash>/` and `issue-<n>/worktrees/<agent>-<sha8>/`. The
findings below are about places where a plan, followed as written, produces a
failing or unimplementable result.

Findings 1, 2, 3, and 10 were confirmed by running the affected code, not by
inspection. Reproduction details are given with each.

## Findings

### 1. Gating the block on the subcommand alone breaks the declared pre-commit suite (cursor, antigravity, codex)

**Claim.** All three wrappers decide from `COORD_ISSUE` plus the subcommand and
nothing else. Cursor: "implements … the `COORD_ISSUE` gate, block rules from the
issue spec". Antigravity: "`blocks git status and git diff when COORD_ISSUE is
active`". Codex: "it rejects status/diff with exit 2".

**Rule that must hold.** `AGENTS.md` makes `pnpm check:fast` the live
`verify.precommit`, and every one of these plans names it as the command to run
before each commit. The launcher exports the wrapper's `PATH` before `exec`, so
it is inherited by the harness and by every process the harness spawns —
`pnpm`, `vitest`, and each `spawnSync("git", …)` those tests make. A wrapper
that refuses a subcommand refuses it for the product's own test suite too.

**Concrete failure.** This repository's fast suite shells out to `git status
--porcelain` with `status` as `argv[0]` in three places —
`src/gitExec.ts:72` (`hasUncommittedChanges`), `src/prepareAgentBranch.ts:136`,
`src/setupWorkspace.ts:587` — and `test/support/workspaceFixture.ts:43` does the
same directly. I built the wrapper exactly as the issue sketch and these three
plans specify it, put it on `PATH` with `COORD_ISSUE=124`, and ran two files of
the fast suite:

```
Test Files  2 failed (2)
     Tests  12 failed | 16 passed (28)
Error: Command failed: git status --porcelain
coord: git status blocked during automated issue 124.
 ❯ test/support/workspaceFixture.ts:43:3
```

Nine failures in `test/prepareAgentBranch.test.ts`, three in
`test/wipeIssue.test.ts`. So the R4 implementer following any of these plans
cannot run the suite the same plan requires before committing, and cannot
commit — the wrapper blocks the check that the hook demands. Note this is not
hypothetical for the agent that lands Part A: it lands the wrapper into its own
clone's install path and then has to verify it.

**Smallest correction.** Refuse only when the invocation actually targets the
clone coordination owns; delegate when the repository is redirected (`-C`,
`--git-dir`, `--work-tree`, `GIT_DIR`, `GIT_WORK_TREE`) or when `$PWD` is
outside the clone root embedded at install. Fixture repositories live under
`$TMPDIR`, so this is exactly the line between "agent re-deriving state
coordination owns" and "a product's tooling doing its job". Adding that one
`case "$PWD/" in "$COORD_CLONE"/*)` guard to the same wrapper and re-running the
same files plus `test/pinValidation.test.ts`:

```
Test Files  3 passed (3)
     Tests  31 passed (31)
```

with `git status --porcelain` still exiting 2 when run from the clone root.

### 2. Parsing global options before the subcommand adds further suite failures (codex)

**Claim.** Codex, Reuse and Scope: the wrapper "recognizes Git global options
before the subcommand"; Tests item 1 asserts that automated `git -C . diff`
"exit 2".

**Rule that must hold.** Same as finding 1 — `pnpm check:fast` must pass under
the wrapper.

**Concrete failure.** `src/pinValidation.ts:79` runs every pin inspection as
`spawnSync("git", ["-C", root, ...args])`, so the diff at line 196 arrives as
`git -C <root> diff --no-ext-diff --name-status -z --find-renames …`. Codex's
option-parsing rule resolves the subcommand to `diff` and refuses it, where the
naive `$1` wrappers happen to let it through. Running the same suite with a
wrapper built to codex's specification:

```
FAIL  test/pinValidation.test.ts > phase pin validation > allows only current-issue coordination commits after a pin
FAIL  test/pinValidation.test.ts > phase pin validation > rejects post-pin product and cross-issue changes
Test Files  1 failed | 1 passed (2)
     Tests  2 failed | 5 passed (7)
```

These two failures are additional to finding 1's twelve. Codex is right that a
wrapper reading only `$1` is defeated by `git --no-pager diff`; the option
parsing is the correct half. It is the missing repository-scope check that turns
correctness into breakage, which is why the two must ship together.

**Smallest correction.** Keep the option scan, and treat `-C`, `--git-dir`,
`--work-tree`, `--namespace`, `GIT_DIR`, and `GIT_WORK_TREE` as delegate
signals rather than as options to skip past.

### 3. A grant file read at launcher startup cannot carry per-action paths (cursor)

**Claim.** Cursor, Changed list: `scripts/lib/launcher.sh` "resolve read grants
from coordinator-written grant file(s)"; `src/paths.ts` adds
`agents/<agent>/read-grants.json`; `src/runLoop.ts` writes it inside
`prepareAction`. Its own risk row concedes "Stale read grants if harness stays
up across actions" and mitigates with "writing `read-grants.json` on every
`prepareAction` and documenting that launcher reads grants at process start".

**Rule that must hold.** The launcher runs once per pane: `src/tmux.ts:704`
(`new-window`) and `src/tmux.ts:771` (`respawn-pane`) are the only invocations.
Every subsequent action is delivered by `tmux.nudge` typing into the pane that
is already running. Whatever `--add-dir` the launcher computed at startup is
fixed for the life of the harness.

**Concrete failure.** At `coord start` the issue is at R1.join, which binds no
inputs, so no packet directory exists and `read-grants.json` names nothing. The
harness launches with no input grant. At R3.review the coordinator writes
`inputs/<hash>/` and rewrites `read-grants.json`, but nothing re-reads it —
`nudge` does not re-exec the launcher. Codex is sandboxed with `--sandbox
workspace-write` and Cursor with `--sandbox enabled`
(`scripts/lib/launcher.sh`, `launcher_command`), so for those two vendors the
paths that `action.md` now names are unreadable. Meanwhile cursor's own wrapper
has begun refusing peer `git show` for exactly those artifacts. The agent has
neither the file nor the fallback, and the mitigation offered — "the nudge path
already re-injects full `action.md` with paths" — re-delivers the path text,
which is not what is missing.

**Smallest correction.** Grant the two stable per-issue parents,
`issue-<n>/inputs/` and `issue-<n>/worktrees/`, created in `createIssueRuntime`
before any harness starts, and let `action.md` name the exact immutable children.
Codex's plan reaches this conclusion explicitly and states the reasoning; that
paragraph is the one to adopt.

### 4. `src/wipeIssue.ts` is absent from both file lists, so a stated mitigation cannot be implemented (antigravity)

**Claim.** Antigravity, Risks item 2: "Stale worktrees are pruned when
superseded or when `coord wipe` / issue teardown runs via `git worktree remove`
and `git worktree prune`." Neither `src/wipeIssue.ts` nor
`test/wipeIssue.test.ts` appears in the changed list or the created list.

**Rule that must hold.** The selected plan's file map becomes
`order.approvedPaths`, and `src/evidence.ts:316-319` rejects an implementation
whose changed paths fall outside it: `implementation changes paths outside the
approved file map`. A path not listed cannot be touched at R4.

**Concrete failure.** `src/wipeIssue.ts:433` removes the issue runtime with
`rmSync(paths.issueRoot, { recursive: true, force: true })`. With the new
`issue-<n>/worktrees/*` under that root, wipe deletes the working trees while
the bare mirror keeps their registrations. The next `coord wipe` or any mirror
`worktree add` reusing a path then operates against stale metadata, and
`git --git-dir <mirror> worktree list` reports trees that do not exist. The
implementer cannot fix this without an out-of-map change that the R4 evidence
check rejects.

**Smallest correction.** Add `src/wipeIssue.ts` and `test/wipeIssue.test.ts` to
the changed list. The call belongs beside the existing `pruneIssueRefs(…,
paths.mirror, …)` at `src/wipeIssue.ts:413`, which already runs `git` against
the mirror.

### 5. `src/hookSync.ts` is authorized for change with no stated purpose (antigravity)

**Claim.** Antigravity's changed list is bare paths, and `src/hookSync.ts` is
one of them. Neither the Reuse and Scope section nor the Tests section mentions
it; no test covers it.

**Rule that must hold.** This action requires the plan to justify what it
changes and stay within the issue, and — because the file map becomes the
approved path set — every listed path widens what R4 may modify. `AGENTS.md`
separately forbids modifying the product `githooks/` tree as the way to satisfy
checks, and `src/hookSync.ts` is precisely the module that installs those hook
bodies.

**Concrete failure.** At R5 a reviewer comparing implementations finds a
`src/hookSync.ts` diff and has no plan text to judge it against: it is inside
the approved map, so evidence verification passes, and it is unexplained, so
scope review cannot say whether it is the issue's work or a hook edit made to
get a check to pass. The distinction the protocol exists to enforce becomes
unreviewable.

**Smallest correction.** Drop `src/hookSync.ts`, or give it one clause naming
what it must do. `githooks/post-merge` — already listed — is the file that
regenerates the wrapper; `hookSync.ts` appears to be reachable only if the
wrapper is delivered as a hook body, which no part of the plan proposes.

### 6. The wrapper is given no input that could tell it whether the current action has a bound-files section (codex)

**Claim.** Codex, Reuse and Scope: the wrapper "permits only an exact forty-hex
`<sha>:<path>` show fallback while the current action lacks `## Bound input
files`; rejects all show reconnaissance once that section exists." Tests item 1
asserts "the exact pinned-show fallback works only before a bound-file section".

**Rule that must hold.** The wrapper is a static file generated at install and
regenerated by `githooks/post-merge`. The plan states its inputs exactly: "the
generated wrapper embeds the one absolute real-Git path resolved at install,
recognizes Git global options before the subcommand, short-circuits on
`COORD_GIT_DELEGATE=1`" and is "gated only by `COORD_ISSUE=^[1-9][0-9]*$`".
A rule can only be conditioned on state the program can read.

**Concrete failure.** None of `REAL_GIT`, `COORD_ISSUE`, `COORD_GIT_DELEGATE`,
or argv distinguishes an action that has `## Bound input files` from one that
does not. The implementer must choose a constant: always allow the pinned form —
in which case the second half of the claim is unimplemented and the test cannot
be written — or always reject it, which removes the missing-packet escalation
fallback the same plan promises in its `AGENTS.protocol.md` change and in its
Risks section ("Treat missing blobs/worktree failures as action-preparation
errors"). Either way, the plan's own Tests item 1 is unsatisfiable as written.

**Smallest correction.** Name the missing input. The wrapper can derive
`<coordRoot>/issue-$COORD_ISSUE/agents/<agent>/action.md` from
`coord.workspaceConfig` and `consensus.agentId`, but the flat-vs-nested
topology walk in `scripts/lib/launcher.sh` is not trivial and must be specified
if it is to be reimplemented in a second script. Otherwise drop the condition
and keep the `<sha>:<path>` allowance unconditional, as cursor's plan does.

### 7. An `agentLanguage.ts` ban on git-read prose fails on text the same plan adds (cursor)

**Claim.** Cursor, Changed list: `src/agentLanguage.ts` — "ban prose that tells
agents to run `git status` / `git diff` / `git show` for peer coordination
artifacts when materialized paths exist."

**Rule that must hold.** `src/agentLanguage.ts:74-78` applies its banned-term
list to `AGENT_FACING_PROSE_FILES`, which includes
`templates/product/AGENTS.protocol.md`. The module's own docstring
(`src/agentLanguage.ts:14-17`) states it is a test-time invariant, so a match is
a test failure, not a runtime warning.

**Concrete failure.** `templates/product/AGENTS.protocol.md:27` already reads
"replace the file to “fix” git status", and cursor's own protocol change adds
sentences that "forbid `git status`, `git diff`, and undisciplined `git show`
during automated issues" — text that necessarily contains those literals. A ban
pattern over that file matches both, and `test/agentLanguage.test.ts` fails on
the plan's own output. The condition "when materialized paths exist" is not
expressible in a static prose scan at all.

**Smallest correction.** Drop `src/agentLanguage.ts` from the plan. Its
documented purpose is keeping coordinator-internal vocabulary (step ids, gate
ids, evidence ids) out of agent-facing surfaces; the wrapper and the vendor
policy files are the enforcement layer for git usage.

### 8. A version bump is planned for an ordinary issue-branch commit (cursor)

**Claim.** Cursor's changed list includes `package.json` — "bump `0.0.27` →
`0.0.28` for the PR version gate", `config.product.example.json` — "bump
installed coordination `version` to `0.0.28`", and `test/cli.test.ts` — "update
version assertion to `0.0.28` if present". The Conclusion repeats it.

**Rule that must hold.** `AGENTS.md`, "Checks that actually run": "Neither suite
requires `package.json` to be ahead of `origin/main`: the pre-1.0 `0.0.N` advance
is checked only on the PR into `main`, so do not plan a version bump for
ordinary commits on an issue branch."

**Concrete failure.** The three files enter `order.approvedPaths`, so the R4
implementer is directed to change them, and does. Neither `pnpm check:fast` nor
the coordinator's `pnpm check` verifies the advance, so the churn buys nothing
at the step where it is spent; and at R5 every comparison of implementation pins
carries a version diff that is noise against the issue. The `if present` hedge
on the `test/cli.test.ts` row also leaves a listed path whose change is
conditional on something the plan did not check.

**Smallest correction.** Remove all three rows.

### 9. A file is listed as changed with "no change to mirror API" as its body (cursor)

**Claim.** Cursor's changed list: "`test/mirror.test.ts` — no change to mirror
API; optional reuse only."

**Rule that must hold.** The changed-file list is not documentation; it becomes
the approved path set enforced at `src/evidence.ts:316`. A path listed there is
an authorization.

**Concrete failure.** The plan authorizes edits to `test/mirror.test.ts` while
saying it expects none, so an implementation that rewrites that file passes the
approved-path check and a reviewer has no plan text to measure the diff against.
The same applies to `test/paths.test.ts` and `test/cli.test.ts`, whose rows are
also conditional.

**Smallest correction.** Delete the row. A file the plan expects not to change
does not belong in the list of files it may change.

### 10. Enforcing read-only with `0o500` directories breaks the cleanup both plans depend on (claude, codex)

**Claim.** Claude `3ac5aad5d214caea6298696a855d71a1b03d05bb`, "Materialized
layout": "Files are written `0o400` and packet directories `0o500` after the last
write, so the grant below cannot mutate them," and Risks: "Files are `0o400` and
packet/worktree directories `0o500` after write, so the filesystem refuses
mutation regardless of the sandbox grant. `removeWorktree` runs before any prune
so the coordinator can still clean up." Codex reaches the same design: "completed
packet files/directories become read-only and are never rewritten" and
"make their coordinator-produced children read-only".

**Rule that must hold.** On POSIX, unlinking an entry requires write *and*
execute permission on the containing directory, not on the entry. Both plans
also require that the coordinator can later delete what it wrote:
`BareMirror.removeWorktree` (`src/mirror.ts:184`) shells out to `git worktree
remove --force`, and `src/wipeIssue.ts:433` removes the whole issue runtime with
`rmSync(paths.issueRoot, { recursive: true, force: true })`.

**Concrete failure.** Both operations fail against a `0o500` directory. I
materialized a detached worktree from a bare mirror, applied the mode the claude
plan specifies, and ran the removal that plan's own mitigation relies on:

```
$ chmod 500 wt-500
$ git --git-dir=mirror.git worktree remove --force wt-500
error: failed to delete '.../wt-500': Permission denied
worktree remove exit=255
```

`BareMirror.removeWorktree` passes `allowFailure = true` (`src/mirror.ts:185`),
so this failure is swallowed: `pruneSupersededWorktrees` reports success while
the tree and its registration both survive, and the wipe-time `git worktree
prune` the claude plan adds does not collect it either, because the directory
still exists and the registration therefore still looks live. Both the
stale-registration mitigation and the disk-growth mitigation fail silently.

The packet case is worse, and it hits codex as well as claude. `rmSync` with
`force: true` does not override directory permissions:

```
$ chmod 400 packet/a.md; chmod 500 packet
$ node -e 'rmSync(dir,{recursive:true,force:true})'
rmSync FAILED: ENOTEMPTY, Directory not empty: .../packet
```

So `src/wipeIssue.ts:433` throws, and `coord wipe` aborts partway with the
entire issue runtime — `cursors.json`, the journal, every agent directory —
still on disk, for an issue the operator asked to remove.

**Smallest correction.** Keep directories at `0o700` and make only the files
`0o400`; the directory mode is what blocks deletion, and file modes alone stop
an agent rewriting materialized content in place. The real containment argument
in both plans is not the mode bits anyway — it is that the two granted roots
hold nothing but copies of artifacts already bound into that agent's action, and
no coordinator authority file is ever placed under them.

### 11. New path helpers ship with no test file listed, and one delegation assertion tests the wrong thing (claude)

**Claim.** Claude `3ac5aad5d214caea6298696a855d71a1b03d05bb` changes
`src/paths.ts` to add `issueInputsRoot` and `issueWorktreesRoot`,
`inputPacketPath(paths, hash)` "validates `^[0-9a-f]{64}$`",
`inputWorktreePath(paths, agent, sha)`, and two new `createIssueRuntime` roots.
Neither `test/paths.test.ts` nor any paths case appears in its file lists or its
Tests section. Separately, its test 2 asserts that `git fetch --help` "exit `0`"
as evidence that the wrapper delegates.

**Rule that must hold.** The plan's file list becomes `order.approvedPaths`, and
`src/evidence.ts:316-319` rejects an implementation whose changed paths fall
outside it. A test file the plan does not list cannot be added at R4.
`test/paths.test.ts` already exists and is where this module's containment and
validation invariants live.

**Concrete failure.** The two new helpers are the only new code in the plan that
can construct an out-of-root write target, and they are the plan's sole defence
against a malformed hash or agent id reaching `containedPath`. They ship with no
direct coverage, and the implementer cannot add any: writing
`test/paths.test.ts` is an out-of-map change that the R4 evidence check refuses,
so the gap survives to R5 with nothing in the plan authorising its repair. The
second half is smaller but real: `git fetch --help` does not exercise git's
fetch plumbing at all — it renders a man page through `man` and a pager. It
returns 0 here, but on a machine without `man`, or with a pager that wants a
TTY, the assertion fails or blocks for a reason that has nothing to do with
whether the wrapper delegated.

**Smallest correction.** Add `test/paths.test.ts` to the changed list with one
containment case per helper. Assert delegation with a command that actually runs
git plumbing and needs no network, such as `git rev-list --count HEAD`.

## Scope, reuse, new files, and test focus

Checked against this action's requirements, across all four bound plans:

- **Reuse claims hold up.** I verified the named helpers exist:
  `computeInputSetHash` at `src/evidence.ts:40` (already used by
  `src/orderScaffold.ts:29`) as cursor and codex cite; `atomicWriteJson` at
  `src/state.ts:709` as codex cites; `applyManagedBlock` at
  `src/productIgnore.ts:112` as antigravity cites; `BareMirror.readBlob`,
  `materializeWorktree`, and `removeWorktree` at `src/mirror.ts:158,179,184`,
  which all three cite correctly. Antigravity's `DoctorFindingClass` is really
  `DoctorClass` (`src/doctor.ts:38`) and it attributes `BoundInput` /
  `ChangeScopeEntry` to `src/state.ts` as well as `src/steps.ts`; both are
  naming slips with no consequence for the work.
- **New-file justification.** Codex adds exactly one source module and no test
  file, and justifies both choices. Cursor and antigravity each add four files.
  The second wrapper template (`scripts/lib/git-wrapper.sh`) is the weaker half
  of that: `scripts/lib/launcher.sh` exists precisely because two copies of one
  template drifted within a day (its header says so), and adding a second file
  beside it re-opens the question of which one `githooks/post-merge` sources.
  Codex's choice to emit the wrapper from the existing library is better
  supported by the repository's own history.
- **Test focus.** The action asks for the fewest focused tests and for extending
  an existing file where one exists. `test/install.test.ts:566-624` already
  executes the real generated launchers against stub harnesses with `/bin/bash`
  and asserts exact argv — that is the natural home for wrapper-behaviour tests,
  and both `test/gitWrapper.test.ts` (cursor, antigravity) duplicate that
  fixture work rather than extend it. Codex extends six existing suites and adds
  none, which matches the instruction.
- **Staying within the issue.** Codex and antigravity stay inside it. Cursor
  reaches furthest outside: the version bump (finding 8), `src/agentLanguage.ts`
  (finding 7), and four setup scripts plus two docs files where the issue names
  two setup scripts and no docs requirement.
- **Claude's own plan on these axes.** It stays inside the issue and plans no
  version bump. It adds one source module and no new test file, extending
  `test/install.test.ts`, `test/runLoop.test.ts`, `test/action.test.ts`, and
  `test/wipeIssue.test.ts` — the same discipline as codex. Its one weak reuse
  claim is in Alternatives Rejected, where it rejects `computeDerivedInputSetHash`
  (`src/runLoop.ts:326`) without noticing that `computeInputSetHash`
  (`src/evidence.ts:40`) is the function cursor and codex correctly cite and is
  the better fit for a packet directory name; the rejection is sound but argued
  against the wrong function. Its gap is coverage, not scope — see finding 11.
- **Mechanical completeness.** Antigravity's changed list is bare paths with no
  per-path statement of the change, which is what let findings 4 and 5 through —
  a missing file and an unexplained one are both invisible in a list of
  filenames. Codex and cursor both annotate each path.

## Conclusion

Every bound plan has the right architecture, and three of the four share finding
1: as specified, the wrapper blocks `git status` for the product's own test
suite, and the implementer cannot run the `pnpm check:fast` the same plan
requires before committing. Twelve fast-suite tests fail today under a wrapper
built to that specification; adding a repository-scope guard takes the same
three files to 31 passed while still refusing the agent's own `git status` in
the clone. That guard is the single change cursor, antigravity, and codex all
need, and codex needs it most because its otherwise-correct global-option
parsing extends the breakage to `test/pinValidation.test.ts`.

Finding 10 cuts the other way and is the reason no plan here is ready as
written. Claude's plan and codex's plan both propose `0o500` directories as the
read-only mechanism, and that mode silently defeats
`BareMirror.removeWorktree` and hard-fails `wipeIssue`'s `rmSync` with
`ENOTEMPTY` — so `coord wipe` aborts leaving the whole issue runtime on disk.
The claude plan is the one that avoids finding 1 and then walks into finding 10;
that is not a better trade, it is a different one, and both defects have to be
fixed before either plan is safe to implement.

Ranked as they stand: **codex** is strongest overall — alone in reasoning
correctly about grant timing against a persistent harness (finding 3), one
justified module, no new test file, and its show-condition gap (finding 6) is a
condition to drop rather than a mechanism to invent; it needs findings 1, 2, and
10 fixed. **Claude** is next: it is the only plan that identifies and verifies
the suite-breakage in finding 1 and proposes the guard that resolves it, but it
carries finding 10 in full and leaves its new path helpers untested (finding
11). **Antigravity** is sound in approach but under-specified as a file map;
findings 4 and 5 are both artifacts of listing paths without saying what happens
to them, and the missing `src/wipeIssue.ts` makes one of its own mitigations
unimplementable at R4. **Cursor** is the most thorough on Part A's shell details
and is the only plan whose `git show` fallback stays unconditional and
implementable, but findings 3, 7, 8, and 9 mean four of its listed changes
either cannot work as described or should not be made.

The merge worth making: codex's grant model and single-template discipline,
claude's repository-scope guard in the wrapper and its verification of what the
block actually costs, cursor's unconditional pinned-show fallback, antigravity's
doctor check for a missing or non-executable wrapper — and file-mode enforcement
dropped from all of them in favour of `0o400` files under `0o700` directories.

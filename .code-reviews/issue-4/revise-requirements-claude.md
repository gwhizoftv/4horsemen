# Consolidated revision requirements — `issue-4/claude`

**Author:** Claude

**Target implementation:** `72db53ab67d2ac788ea682302e6492e98c531d88`
(`d2e5226` on the same branch adds review documents only)

**Baseline:** `origin/main` at `a67338341d720160e7e30e8af2ea043d740564d4`

**Verdict:** retain Claude as the revision base, conditional on the blocking and
required fixes below. Three peers independently reached the same base
recommendation while requiring changes; the defects are numerous but shallow,
and they land against the largest regression suite of the four branches (168
focused tests plus the four-agent canary, green on the target commit).

## Sources and audit method

This document reconciles every issue-4 review that names the Claude branch:

- Claude self-review and background reviewer pass (this session, 14 findings);
- Codex, `.code-reviews/issue-4/review-claude.md` on `origin/issue-4/codex`
  (12 P1, 5 P2);
- Cursor, `.code-reviews/issue-4/review-claude.md` and
  `.code-reviews/issue-4/review-requirements.md` on `origin/issue-4/cursor`
  (3 findings, R1–R11);
- Antigravity, `.code-reviews/review-claude.md` on `origin/issue-4/antigravity`
  (1 finding);
- ports identified by reading `origin/issue-4/codex` and `origin/issue-4/cursor`
  directly, where a peer implements an issue requirement this branch does not.

Every requirement below was checked against the target source; line references
are from the target tree. Where reviewers disagreed with each other or with the
code, the code was run. Items peers asked for that are **already satisfied** or
**not applicable** are recorded in their own section rather than silently
dropped — a requirements document that quietly omits a peer's request is not
reviewable.

Corroboration is marked per requirement: **C**laude, **X** Codex, **U** Cursor,
**A** Antigravity.

## Acceptance gate

| ID | Requirement | Class | Corroboration |
| --- | --- | --- | --- |
| R1 | Wired agent clone with unset `consensus.agentId` must fail closed | **Blocking** | C X U A |
| R2 | Hooks that lost the execute bit must be diagnosed and repaired | **Blocking** | U |
| R3 | Doctor must verify hooks against the canonical source, not the clone-local manifest | **Blocking** | X |
| R4 | The stamp must attest the bytes agents actually execute | **Blocking** | X |
| R5 | Each clone's `coord.installRoot` / `coord.cliEntry` must match the stamp | **Blocking** | X |
| R6 | "Nothing to propose" must never be recorded as an explicit empty `verify` | **Blocking** | C U |
| R7 | Uninstall must not delete owner-authored workspace material | **Blocking** | C |
| R8 | Manifest-driven deletion must be confined to known hook paths | **Blocking** | X |
| R9 | Uninstall must decide every refusal before mutating anything | **Blocking** | C X |
| R10 | `--wipe-runtime` must not destroy other products' runtime state | **Blocking** | C U |
| R11 | A pre-existing agent-clone hook must be preserved and restored | **Blocking** | C X |
| R12 | `--write-product --vendor` must be additive to tracked product hooks | **Blocking** | X |
| R13 | The stamp must refresh every option-dependent field on reinstall | Required | C X |
| R14 | An adopted clone must be verified as a clone of this product | Required | C X |
| R15 | Agent ids must be validated before they derive a path | Required | C X |
| R16 | The workspace config must be built and validated before clone effects | Required | X |
| R17 | `bootstrapped` must mean coordination created the checkout | Required | X |
| R18 | The managed ignore block must not rewrite bytes outside itself | Required | C |
| R19 | An unterminated managed block must refuse, not truncate | Required | C |
| R20 | Uninstall must reverse the `AGENTS.md` the install wrote | Required | C |
| R21 | Doctor must report, not throw, on a clone that is not a repository | Required | C |
| R22 | Doctor must classify a schema-invalid config as `startCompatibility` | Required | X |
| R23 | A missing clone must not be reported under the `identity` class | Required | C |
| R24 | `argv[0]` must be resolved as executable, relative to the clone | Required | C X U |
| R25 | Installer git must run with the driver's hermetic environment | Required | X |
| R26 | `--dry-run` must write nothing into a clone | Required | C X |
| R27 | A no-op reinstall must not rewrite the hook manifest | Required | X |
| R28 | Reinstall must sync an existing clone or refuse with remediation | Required | U |
| R29 | `--write-product --vendor` must not arm a human clone | Required | U |
| R30 | The pre-push gates must have regressions | Required | C U |
| R31 | Tests that encode fail-open behaviour must be reversed | Required | C X U |

`pnpm check:fast` must stay green throughout; `pnpm check` before the revision
is offered for review.

---

## Blocking

### R1 — Fail closed when hooks are installed but identity is gone

**Defective code:** `githooks/lib/identity.sh:47-50` (unset `agentId` sets
`CONSENSUS_AGENT_CLONE=false`); the early return in each body at
`githooks/pre-commit:12`, `pre-push:12`, `commit-msg:11`, `post-commit:11`,
`post-merge:11`; `test/hookSync.test.ts` asserts the ungated commit succeeds.

**Rule:** Under revised Option C the hooks exist only in agent clones, so their
presence — together with the install wiring (`coord.installRoot`,
`coord.cliEntry`, `coord.workspaceConfig`, the hook manifest) — is the signal
that this is an agent clone. A missing or malformed `consensus.agentId` there
must block. Human clones are protected by never receiving the hooks, not by a
runtime pass-through.

**Failure:** `git config --local --unset consensus.agentId` in a fully installed
clone makes every hook `exit 0` before the branch-ownership, commit-prefix, and
declared-`verify` checks run. The agent commits and pushes completely ungated,
and nothing reports it. This is the strongest-corroborated finding on the
branch: all four reviewers raised it independently, and it contradicts the
conclusion of this branch's own §2a analysis, which stated that under this
placement "unset identity there remains a hard error".

**Required change:** Keep the pass-through only where it can be proven that no
coordination wiring exists. When any wiring is present, treat missing or
malformed identity as fail-closed with the existing remediation text. Reverse
the test that currently asserts the pass-through.

**Regression:**

```ts
it("blocks when agentId is unset but the coordination wiring remains", () => {
  const { clone } = installed();
  stageWork(clone);
  git(clone, "config", "--local", "--unset", "consensus.agentId");
  expect(tryGit(clone, "commit", "-m", "ungated").exitCode).not.toBe(0);
  expect(tryGit(clone, "push", "origin", "issue-1/claude").exitCode).not.toBe(0);
});
```

### R2 — Diagnose and repair hooks that lost the execute bit

**Defective code:** `src/hookSync.ts:118-128` skips `chmodSync` whenever the
bytes already match; `src/hookSync.ts:188-225` compares digests only.

**Rule:** A hook that exists must be a hook git runs. Git silently ignores a
non-executable file in `.git/hooks`, so the mode is part of what "installed"
means and must be both diagnosed and repaired.

**Failure:** `chmod 0644 .git/hooks/pre-commit` disables the hook with no
output; a reinstall classifies it unchanged and never restores the bit; and
`coord doctor` reports `ok` because the digest still matches. Every gate is off
while all three tools report health.

**Required change:** Always assert the mode on write; give `inspectCloneHooks`
a distinct non-`ok` kind for it; surface it under the `hooks` doctor class;
repair on reinstall.

**Regression:** `chmod 0o644` a hook, assert `inspectCloneHooks` is not `ok`,
assert doctor exits non-zero, reinstall, assert the mode bit is back.

### R3 — Verify hooks against the canonical source, not the clone's manifest

**Defective code:** `src/hookSync.ts:205` iterates `manifest.files` and trusts
its digests; `src/doctor.ts` consumes the result as authority.

**Rule:** The clone-local manifest is agent-writable, so it is evidence to be
checked, not the authority. Doctor must independently prove the complete
expected hook set matches the canonical install (or the recorded vendor source).

**Failure:** An agent replaces `pre-commit` with `exit 0` and updates the
matching digest in `coord-hooks.json`; `inspectCloneHooks` returns `ok` and
doctor exits 0. The tool built to detect ungated agents certifies one.

**Required change:** Recompute the expected contents from
`plannedHookContents` for the recorded mode and compare against those, treating
the manifest as a claim about mode and provenance only. Any file present in the
hooks directory under a managed name that is not expected is itself a finding.

**Regression:** Rewrite a hook body *and* its manifest digest; require a `hooks`
finding and a non-zero exit.

### R4 — Attest the bytes agents actually execute

**Defective code:** `src/hookSync.ts:250` stamps `HEAD` only.

**Rule:** The install stamp must identify the canonical hook and CLI bytes that
agent clones will execute, so a shim install must either refuse a dirty install
checkout or record and verify content digests of the bodies it points at.

**Failure:** An uncommitted edit changing `githooks/pre-commit` to `exit 0`
leaves `HEAD` unchanged. Doctor compares the clone shim and the commit, finds
both correct, and reports healthy, while every clone on that install executes
the modified body.

**Required change:** Record digests of `githooks/**` and the CLI entry in the
stamp and verify them in doctor, or refuse to install from a checkout with
uncommitted changes under `githooks/`. Prefer the digests: refusing blocks the
ordinary development loop this repository uses on itself.

### R5 — Cross-check each clone's install paths against the stamp

**Defective code:** `src/doctor.ts:167` checks presence of `coord.installRoot`
and `coord.cliEntry`, never their values.

**Rule:** In shim mode a clone's `coord.installRoot` and `coord.cliEntry` must
equal the stamped paths, not merely be set.

**Failure:** Redirect one clone's `coord.installRoot` to an older checkout:
doctor reports healthy because the stamped root exists and the shim bytes match,
while that clone executes a different hook implementation than the workspace
believes it runs.

**Regression:** Redirect both keys after install; require an `installRoot` or
`installDrift` finding.

### R6 — Never record "nothing to propose" as an explicit opt-out

**Defective code:** `src/setupWorkspace.ts:145-156` (Node) and `160-173` (Make)
always return a `verify` object; `buildWorkspaceConfig` writes it through.

**Rule:** A missing top-level `verify` must stay missing so the hooks fail
closed. Only an operator-authored `"verify": { "precommit": [], "prepush": [] }`
may allow commits with no local checks. The distinction between "undeclared" and
"declared empty" is the central contract of issue 4 and must survive
`coord install`.

**Failure:** A `package.json` whose only script is `test`, or a `Makefile` with a
`test` target but no `check`, yields `verify: { precommit: [], prepush: [] }`.
The installer has converted an unanswered question into consent, and every agent
clone for that product commits with no local checks. Both peers that shipped an
installer have a version of this bug — Codex's fires on *every* default install
— which makes it the defect most likely to be reintroduced.

**Required change:** Omit `verify` from the proposal when both phases would be
empty; never coerce `undefined` to an empty object at install time.

**Regression:**

```ts
it("omits verify when no precommit or prepush command was recognized", () => {
  const root = mkdtempSync(join(tmpdir(), "coord-propose-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "echo ok" } }));
  expect(proposeProjectPolicy(root).verify).toBeUndefined();
});
```

### R7 — Do not delete owner-authored workspace material on uninstall

**Defective code:** `src/install.ts:413` removes
`<coord-root>/workspaces/<project>/` recursively and unconditionally.

**Rule:** An operation documented as "conservative by default: clear the wiring
coordination added, and nothing else" must not delete files it did not create.

**Failure:** `docs/setup-workspace.md` instructs the owner to place
`<coord-root>/workspaces/<project>/.plans/issue-<n>/plan.md` in that directory —
it lives there precisely because `digestPaths` are config-relative and the
runtime is the owner-controlled home for automation inputs. An operator
re-wiring a broken install loses every hand-authored plan for the project, with
no flag and no warning. Verified against the target commit.

**Required change:** Delete `config.json` and coordination-created entries only,
or gate directory removal behind an explicit flag.

**Regression:** Write a `.plans/issue-7/plan.md` beside the emitted config, run
the default uninstall, assert the file survives.

### R8 — Confine manifest-driven deletion to known hook paths

**Defective code:** `src/hookSync.ts:163-171` joins arbitrary `manifest.files`
keys onto the hooks directory with no containment check.

**Rule:** An agent-writable manifest must be schema-validated and may name only
the fixed managed hook and lib paths beneath `.git/hooks`.

**Failure:** An agent edits its own `coord-hooks.json` to add
`"../../../victim": "<digest of that file>"`. The owner later runs
`coord uninstall`, the digest matches, and a file outside the hooks directory is
deleted with owner privileges.

**Required change:** Validate the manifest against a schema whose keys are
restricted to `HOOK_NAMES` and `VENDOR_LIB_FILES`, and resolve every path
through `containedPath` against the hooks directory before touching it.

**Regression:** Inject an escaping key; require uninstall to refuse without
deleting the target.

### R9 — Decide every uninstall refusal before mutating anything

**Defective code:** `src/install.ts:401` checks dirtiness inside the deletion
loop, after the unwiring loop at `:366-385` has already run.

**Rule:** A precondition that aborts a destructive batch must be evaluated
across the whole batch before the first mutation.

**Failure:** With `[claude, codex]` and uncommitted work in codex, all clones are
already unwired, `myserver-claude` is deleted, then the loop throws — leaving a
half-destroyed workspace and an error recommending `--force`, which on re-run
discards the dirty work. Verified against the target commit.

**Required change:** Hoist dirty-clone and ownership refusals into a preflight
over every clone; mutate only once all of them pass.

**Regression:** Dirty one of two clones, request `--delete-clones` without
`--force`, assert every clone and all wiring are byte-for-byte unchanged.

### R10 — Scope `--wipe-runtime` to the product being uninstalled

**Defective code:** `src/install.ts:418` calls `rmSync(coordRoot, …)`.

**Rule:** A destructive option invoked while uninstalling one product must not
destroy state belonging to another.

**Failure:** Retiring product A removes every other product's
`workspaces/<project>/`, the shared `mirror.git`, and every `issue-N/` directory
holding cursors and journals for runs still in flight — with no dirty check and
no `--force`, unlike `--delete-clones`.

**Required change:** Restrict the wipe to this project's workspace and issue
runtimes; require `--force` when any other workspace exists under the root.

### R11 — Preserve and restore a pre-existing agent-clone hook

**Defective code:** `src/hookSync.ts:118-128` overwrites any differing hook with
no record of the previous bytes.

**Rule:** Issue 4 requires additive merge in an agent clone that already has
hooks — wrap or chain, never clobber. Adding coordination gates does not
authorize removing the product's own.

**Failure:** A clone carrying a husky or product `pre-commit` loses it on
install, and uninstall cannot restore it because nothing was recorded. Codex is
the only branch that implements this requirement
(`src/hookSync.ts:63-97` on `origin/issue-4/codex`, renaming to
`<hook>.coord-original` and restoring on uninstall); port that approach.

**Regression:** Seed a sentinel `pre-commit`, install, assert the sentinel still
runs, uninstall, assert it is restored.

### R12 — Keep opt-in product vendoring additive

**Defective code:** `src/hookSync.ts:227-247` copies over any existing
`githooks/<name>` whose bytes differ.

**Rule:** Even `--write-product --vendor` is additive and must never replace a
tracked product hook wholesale.

**Failure:** A product maintaining its own tracked `githooks/pre-commit` has it
silently destroyed by an opt-in vendor install.

**Required change:** Chain or refuse; never overwrite. Same mechanism as R11.

---

## Required

### R13 — Refresh every option-dependent stamp field on reinstall

**Defective code:** `src/install.ts:271` reuses the previous stamp when
`commit`, `version`, and `installRoot` are unchanged — a set that excludes every
field recording what the run did.

**Rule:** A prior stamp may be reused only when every stamped property is
unchanged. `wroteProductIgnore`, `vendored`, `bootstrapped`, `productRoot`, and
`cloneRoot` all describe this invocation.

**Failure:** Install with defaults, then re-run with `--write-product` at the
same commit: the managed block is written but the stamp keeps
`wroteProductIgnore: false`, so uninstall logs "not written by coordination" and
orphans it in the product's tracked tree permanently. Switching to `--vendor`
leaves `vendored: false`; a changed `--clone-root` leaves the old paths, aiming
uninstall's cleanup at the wrong tree. Verified against the target commit.

**Required change:** Reuse only the timestamp, and only when every other field
compares equal.

**Regression:** Install, reinstall with `--write-product`, uninstall, assert the
product `.gitignore` no longer contains the managed block.

### R14 — Verify an adopted clone belongs to this product

**Defective code:** `src/setupWorkspace.ts:285` accepts any existing directory.

**Rule:** A reused agent path must be a git worktree whose `origin` matches the
configured product remote. Preserving in-flight work does not permit wiring an
arbitrary repository.

**Failure:** A typo'd `--clone-root`, or an unrelated checkout named
`<project>-<agent>`, receives this product's identity, policy, launcher, and
hooks, and can then publish evidence to the wrong origin. When the directory is
not a repository at all, `writeCloneExclude` *fabricates* a `.git/info/exclude`
before `configureCloneIdentity` finally throws, leaving debris. Verified: a
plain directory holding one unrelated file came back as
`[ '.git', 'UNRELATED.txt', 'start-claude.sh' ]`.

**Required change:** Require a worktree whose origin matches; refuse before any
write.

### R15 — Validate agent ids before deriving paths

**Defective code:** `src/install.ts:120` rejects only an empty list; ids reach
`agentIdSchema` at step 6.

**Rule:** Every operator-supplied identifier interpolated into a path must pass
the coordinator's schema, the uniqueness check, and the launcher-support check
before it participates in any effect.

**Failure:** `--agents ../../escaped` performs a real `git clone` at
`<clone-root>/escaped`, then aborts on the launcher lookup with no workspace
config written — so `coord uninstall` cannot find or remove the stray
repository. Deeper traversal escapes the clone root entirely. Verified.

**Regression:** Traversal, duplicate, and unsupported ids each fail with zero
paths created.

### R16 — Build and validate the config before clone effects

**Defective code:** `src/install.ts:259` builds the config after the clone loop
at `:161-217`.

**Rule:** Every knowable declaration, schema, and launcher failure belongs to
preflight.

**Failure:** For a product with no inferable finalization checks — a case this
branch already tests — install throws "Cannot infer finalization checks" only
after leaving a fully wired agent clone behind and no workspace config to
uninstall it with.

**Required change:** Build and validate the config first; perform clone effects
only after it parses.

### R17 — `bootstrapped` must mean coordination created the checkout

**Defective code:** `src/install.ts:255` stamps `bootstrapped: options.bootstrap`.

**Rule:** `bootstrapped` authorizes recursive deletion of the install checkout,
so it may be true only when coordination created and owns it.

**Failure:** `--bootstrap-coordination` merely runs `pnpm install` and
`pnpm build` in the pre-existing checkout the CLI is running from, yet stamps it
as owned. A later `uninstall --delete-coordination` can recursively delete an
independently installed source repository.

**Required change:** Record creation, not command execution; refuse
`--delete-coordination` without it.

### R18 — The managed block must not rewrite bytes outside itself

**Defective code:** `src/productIgnore.ts:59`, whose `normalize` runs
`replace(/\n{3,}/g, "\n\n")` over the whole file.

**Rule:** A managed-block writer may add or remove only its own delimited
region; every byte outside it survives unchanged.

**Failure:** A product `.gitignore` that separates sections with two blank lines
comes back with one, so install→uninstall is not an identity and the operator
sees a diff in a tracked file coordination was never asked to touch. Verified.

**Regression:**

```ts
it("returns unrelated lines byte-for-byte", () => {
  const original = "# group one\nbuild/\n\n\n# group two\ndist/\n";
  expect(removeManagedBlock(applyManagedBlock(original, ["/start-*.sh"]).content).content)
    .toBe(original);
});
```

### R19 — An unterminated managed block must refuse, not truncate

**Defective code:** `src/productIgnore.ts:47-50` returns `after: ""` when the end
marker is absent.

**Rule:** When a managed region's terminator is missing, the writer must refuse;
it may not assume the remainder of a file it does not own is its own.

**Failure:** A human who edited their `.git/info/exclude` and removed the end
marker loses every line below it on the next install or uninstall. Verified.

**Required change:** Return an error state and have callers report remediation.

### R20 — Uninstall must reverse the `AGENTS.md` the install wrote

**Defective code:** `src/install.ts:311` writes it and records nothing.

**Rule:** Uninstall must be able to reverse every tracked file the install
created.

**Failure:** After `--write-product` then uninstall, the product keeps a tracked
coordination file forever. The existing "never strip a human `AGENTS.md`" rule is
satisfied by a `wroteAgentsMd` stamp field, exactly as `wroteProductIgnore` does
for the ignore block.

### R21 — Doctor must report, not throw, on a clone that is not a repository

**Defective code:** `src/doctor.ts:166` → `readHookManifest` → `gitDir` →
`gitOrThrow`; the same path again at `:185`.

**Rule:** A diagnostic tool must classify the broken states it exists to
diagnose.

**Failure:** Delete `<clone>/.git` and run `coord doctor`: the CLI catches the
raw git error and exits 2 with `coord: git rev-parse --absolute-git-dir failed`,
producing no findings and none of the class-specific codes. Verified.

### R22 — Classify a schema-invalid config as `startCompatibility`

**Defective code:** `src/doctor.ts:309` calls `readConfig` before any report
exists.

**Rule:** The `startCompatibility` class must cover any workspace config that
`coord start` would reject, including malformed JSON and schema failures.

**Failure:** Removing a required field yields generic exit 2 instead of the
documented code 15 and its remediation.

### R23 — A missing clone must not be reported under `identity`

**Defective code:** `src/doctor.ts:134`.

**Rule:** Exit codes an operator scripts against must partition the failures they
name.

**Failure:** A missing clone returns 14, documented as "`consensus.agentId`
missing, malformed, or crossed", so a script branching on 14 attempts an
identity repair on a directory that does not exist.

### R24 — Resolve `argv[0]` as executable, relative to the clone

**Defective code:** `src/hookPolicy.ts:74`.

**Rule:** Doctor must preflight a declared command the same way the hook will
spawn it — with `cwd` at the clone, and requiring an executable file.

**Failure:** A declared `["./scripts/check.sh"]` makes doctor, run from
coord-root, report code 16 for a command the hooks execute fine; conversely a
non-executable file of the right name earlier on `PATH` passes doctor and then
fails the first hook with a spawn error.

### R25 — Run installer git with the driver's hermetic environment

**Defective code:** `src/gitExec.ts:11` spawns git with the inherited
environment; the mirror and run loop already scrub theirs.

**Rule:** Owner-side git subprocesses must clear ambient repository and config
redirectors.

**Failure:** An inherited `GIT_DIR`, `GIT_WORK_TREE`, or `GIT_CONFIG_*` redirects
`requireWorktree`, remote discovery, and local-config writes away from the
supplied paths, defeating containment and wiring the wrong repository.

### R26 — `--dry-run` must write nothing into a clone

**Defective code:** `src/setupWorkspace.ts:318` renders the launcher to
`<clone>/.start-<agent>.sh.coord-tmp` before the dry-run gate.

**Rule:** A dry run touches nothing, as the documentation states.

**Failure:** The staging file is created and deleted during `--dry-run`; if the
process dies in between, the leftover is not matched by the managed exclude
(`/start-*.sh` does not match a leading-dot name), so it makes the clone dirty
and blocks `uninstall --delete-clones`.

**Required change:** Render outside the worktree, or skip rendering when
`dryRun`.

### R27 — A no-op reinstall must not rewrite the manifest

**Defective code:** `src/hookSync.ts:136` regenerates `writtenAt` and the
manifest is rewritten even when every hook is classified unchanged.

**Rule:** A second identical install reporting an empty change list must not
mutate a managed file.

**Failure:** The manifest bytes change while the API reports `changes: []`,
which makes the idempotence guarantee unverifiable from the filesystem.

### R28 — Reinstall must sync an existing clone or refuse

**Defective code:** `src/setupWorkspace.ts:278-292` leaves an existing clone
entirely untouched.

**Rule:** The issue's step 2 is "create/sync", and it applies on reinstall, not
only on first clone. Codex implements the fetch/fast-forward path; the deliberate
choice here not to reset a clone is correct and must not be given up.

**Failure:** An agent clone that predates the baseline recorded by `coord start`
stays behind indefinitely, and the operator has no signal.

**Required change:** Fetch and fast-forward when the clone is clean and on the
shared branch; refuse with remediation when dirty or diverged. Never reset.

### R29 — `--write-product --vendor` must not arm a human clone

**Rule:** Copying identity-fail-closed bodies into a product's tracked
`githooks/` recreates the §2a loaded gun: any human who sets `core.hooksPath`
gets a blocked repository. R1 makes those bodies stricter, which makes this
worse.

**Required change:** Choose and enforce one policy — refuse the combination,
require an explicit acknowledgement flag, or keep vendor bodies agent-clone-only
— and document it in `docs/setup-workspace.md`.

**Regression:** After an opt-in vendor install, a human clone with
`core.hooksPath=githooks` and no coordination identity must still commit.

### R30 — Regressions for the pre-push gates

**Defective coverage:** nothing covers `githooks/pre-push:58`.

**Rule:** The properties a security-relevant hook enforces must be asserted,
especially when its failure mode is silent.

**Failure:** No test covers pushing `main` or `issue-N/final`, pushing a peer's
branch, force-pushing, or deleting a remote branch. All four live in a `while
read` loop over stdin, and `coord_scope` spawns a child inheriting stdin before
that loop; if any future child drains it, the loop body never runs, `status`
stays `0`, and every gate is skipped while the push succeeds. All four were
confirmed to hold today, which is why they should be pinned. Reading the ref list
into a variable before any subprocess runs removes the hazard.

### R31 — Reverse the tests that encode fail-open behaviour

- `test/hookSync.test.ts`: the assertion that an unset `consensus.agentId`
  permits an ungated commit must become the R1 block assertion.
- Add the R6 proposer test, the R2 execute-bit tests, and the R11 hook-chaining
  round trip.
- Keep `test/support/workspaceFixture.ts` as the single harness; do not fork
  per-test git setups.

---

## Already satisfied, or not applicable

Recorded so the peer requests are answerable rather than dropped.

| Peer request | Status |
| --- | --- |
| Cursor R4 — empty `workflowCritical*` must not silence a non-empty `verify.prepush` | **Already satisfied.** `githooks/pre-push` tracks `scope_declared`; when nothing is declared, `is_workflow_critical` returns 0 for every path, so every push is in scope. Covered by `test/verify-config.test.ts` ("renders nothing when no narrowing was declared, so the hook gates everything"). Add the end-to-end push assertion under R30. |
| Cursor R7 — exclusive `mktemp` for a pre-push stdin spool | **Not applicable.** This branch's `templates/hooks/shim.sh` does not spool stdin; it `exec`s the body, which reads stdin directly. The defect is Codex's. Must stay true if R30's stdin-buffering change is made — buffer in a shell variable, not a file. |
| Cursor R9 — non-Node fixture blocks on failing declared `verify.precommit` | **Already satisfied.** `test/hookSync.test.ts` installs a Go fixture and asserts the commit is blocked by a declared failing argv. |
| Cursor R10 — doctor exit taxonomy | **Partially satisfied.** Nine classes exist and are tested; R2, R21, R22, R23 extend it. |
| Cursor R8 / `src/uninstall.ts` extraction | **Behaviour required, file optional.** R7–R10, R13, R20 carry the behaviour. Do not extract for style alone. |
| Codex "journal shows which tier" | **Already satisfied.** `src/runLoop.ts` records `tier: "checks"` on `final-check` events, asserted in `test/runLoop.test.ts`. |

## File map for revisions

| Path | Requirements |
| --- | --- |
| `githooks/lib/identity.sh` | R1 |
| `githooks/pre-commit`, `pre-push`, `commit-msg`, `post-commit`, `post-merge` | R1; `pre-push` also R30 |
| `src/hookSync.ts` | R2, R3, R4, R8, R11, R12, R27 |
| `src/doctor.ts` | R2, R3, R5, R21, R22, R23 |
| `src/install.ts` | R7, R9, R10, R13, R15, R16, R17, R20, R26 |
| `src/setupWorkspace.ts` | R6, R14, R26, R28 |
| `src/productIgnore.ts` | R18, R19 |
| `src/hookPolicy.ts` | R24 |
| `src/gitExec.ts` | R25 |
| `src/state.ts` | R8 (manifest schema), R13 (stamp fields) |
| `templates/hooks/shim.sh` | R29 if the vendor policy changes the shim |
| `docs/setup-workspace.md` | R6, R7, R10, R28, R29 |
| `config.product.example.json` | R6 — show omitted vs explicitly empty `verify` |
| `test/hookSync.test.ts` | R1, R2, R3, R11, R31 |
| `test/install.test.ts` | R7, R9, R10, R13, R14, R15, R16, R26, R28 |
| `test/doctor.test.ts` | R2, R3, R5, R21, R22, R23 |
| `test/verify-config.test.ts` | R6, R24 |
| `test/support/workspaceFixture.ts` | shared helpers for the new regressions |

**Do not add:** a product-tracked `githooks/` by default; any `consensus-ai`
naming; any hook body that branches on `package.json`, a lockfile, or a script
name.

## Out of scope for this revision

- Four-agent E2E of the install path on a non-Node product.
- Auto-starting `coord run` from install.
- Package-manager distribution of coordination.
- Any change to issue-1 driver semantics not named above.

## Done when

Every blocking and required item has a regression that fails on `72db53a` and
passes on the revision; `pnpm check` is green; a default `coord install` still
leaves the product's `git status` empty; and a fresh human clone of an onboarded
product still commits and pushes with no coordination hooks, no Node
requirement, and no coordination message.

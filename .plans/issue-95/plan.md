# Plan — issue 95: move the package version ship gate to PR/merge only

The `0.0.N` advance is enforced in two places today. The PR gate
(`.github/workflows/version-bump.yml` → `pnpm check:version-bump`) is the one the
owner wants. The live assertion inside the fast suite — `describe("version bump
ship gate")` in `test/versionBump.test.ts`, which calls
`checkVersionBump(process.cwd(), …)` against `origin/main` — is the one that
makes ordinary protocol commits unsatisfiable, because a bump drags in companion
files (`test/cli.test.ts`, `test/install.test.ts`) that a plan's approved path
set usually omits.

This plan removes the live assertion, keeps the PR gate as the sole enforcement
point, and also removes the workaround that grew around the collision: the
`test:fast` wrapper in `package.json` that rewrites version assertions in two
test files for the duration of every run. docs/repo-map.md already prescribes
that removal "as soon as an issue's approved paths include `test/cli.test.ts`" —
this issue is that moment, and leaving the wrapper in place would preserve the
companion-file trap the issue exists to close.

Measured facts this plan rests on (verified in this clone at baseline
`4d65f30bd3c33edf83fc678b69f4cf3fa678f3a9`):

- `package.json` version is `0.0.18`; `origin/main:package.json` version is also
  `0.0.18`. `pnpm check:fast` on this branch therefore **fails today** on the
  ship-gate case. The first edit below is what makes the rest of this issue's
  own work committable.
- `check:version-bump` is referenced only by `package.json` and
  `.github/workflows/version-bump.yml`. It is **not** in the workspace `checks`
  list (config.example.json declares `install` and `check` only), so issue item 3
  is a verification, not an edit.
- No test snapshots this repository's tracked `AGENTS.md`; test/agentLanguage.test.ts
  reads templates/product/AGENTS.md, which this plan does not touch.
- `AGENTS.md` carries `skip-worktree` in every agent clone (`git ls-files -v --
  AGENTS.md` → `S`). Editing the worktree file stages nothing. The mechanism for
  changing it without clearing the bit is spelled out under Risks below and was
  rehearsed in a throwaway repository before this plan was written.

## Exact File List to be changed or deleted

Paths written in backticks are the approved set. Paths named without backticks
in this plan (config.example.json, src/checkVersionBump.ts,
templates/product/AGENTS.md, README.md) are deliberately outside it: they are
inspected, confirmed correct as-is, and must not be modified.

1. **`test/versionBump.test.ts`** — delete the entire
   `describe("version bump ship gate")` block (the only caller of
   `checkVersionBump` under vitest). Keep both existing `parseDotVersion` /
   `isStrictlyGreater` cases unchanged. Add a hermetic
   `describe("version bump gate decision")` that drives `checkVersionBump`
   against a temporary git repository built inside the test (see Tests), so the
   gate logic keeps real coverage without consulting `origin/main` or the branch
   the suite happens to run on. The `checkVersionBump` import stays.

2. **`package.json`** — replace the `test:fast` node one-liner with
   `"test:fast": "vitest run --config vitest.config.ts"`. No other script
   changes. **The `version` field is not touched** (`0.0.18` stays); leaving it
   equal to `origin/main` is the acceptance condition being demonstrated.

3. **`test/cli.test.ts`** — line 100, `expect(lines.join("").trim()).toBe("0.0.14")`
   becomes a comparison against the version read from `package.json` at runtime
   under `repoRoot` (already imported from `./support/workspaceFixture.js`), read
   with `readFileSync`/`JSON.parse` in the test itself rather than through
   `packageVersion` from src/install.ts — importing the production reader would
   compare that function to itself and assert nothing about the CLI.

4. **`test/install.test.ts`** — line 166,
   `expect(config.coordination?.version).toBe("0.0.16")` becomes the same
   runtime read of `repoRoot`'s `package.json` (already imported from
   `./support/workspaceFixture.js`), asserting that the emitted config carries
   the driver's own version rather than a frozen literal.

5. **`.github/workflows/version-bump.yml`** — header comment only. Drop the line
   "Also enforced locally by `test/versionBump.test.ts` inside pnpm check:fast /
   precommit," which becomes false, and state that this workflow is the sole
   enforcement point. Trigger, steps, and `COORD_VERSION_BASE_REF` wiring are
   unchanged — the gate must keep failing merges that do not advance.

6. **`AGENTS.md`** — the tracked paragraph at lines 124–128 (above the
   `<!-- coordination protocol — coord install -->` marker; the managed overlay
   below it is not edited). Delete the sentence "On non-`main` branches that
   suite also requires `package.json` version to be strictly greater than
   `origin/main` (pre-1.0 ship gate)." and replace it with a sentence stating
   that the `0.0.N` advance is required on the PR into `main` and is checked
   there, not by `check:fast`. Wording must avoid coordinator-internal
   vocabulary (step, gate, and evidence ids) so `findAgentLanguageViolations`
   stays clean if this text is ever re-scanned.

7. **`docs/coord-driver.md`** — lines 133–138, the "That bump is mechanical"
   sentence. Rewrite so the enforcement point is the `version-bump` GitHub Action
   on PRs into `main`; remove the claim that `pnpm check:fast` (precommit) fails
   on a non-`main` branch. Keep the surrounding `coord --version` guidance and
   the "concurrent PRs must claim distinct next versions" sentence, which is
   still true.

8. **`docs/repo-map.md`** — two edits. (a) Lines 62–64: delete the paragraph
   asserting the fast suite checks `package.json` against `origin/main`, and
   state instead that the advance is a PR requirement. (b) Lines 66–88: delete
   the whole "`test:fast` is currently wrapped — remove the wrapper when you can"
   section, as that section instructs, since the wrapper is gone.

9. **`src/cli.ts`** — line 219 help text, `bump on every ship` →
   `bump before merging to main`. No behavior change; no test asserts this
   string.

10. **`src/versionBump.ts`** — line 121, the failure `detail` suffix
    `bump 0.0.N on every ship` → wording that names merging into `main`, and the
    doc comment above `checkVersionBump` (lines 63–65) to match. This is the
    message a blocked PR prints, so it must point at the surviving rule. The
    exported function signature and all decision logic are unchanged.

11. **`src/install.ts`** — line 106 doc comment, same "on every ship" → "before
    merging to main" correction. Comment only.

## Exact file list to be created

None. Every change is an edit or deletion inside files that already exist, and
no new module, workflow, or fixture is required: the hermetic gate test lives
beside the unit tests it joins in `test/versionBump.test.ts`, and adding a
`test/support/` helper for a single test file would spread the change without
removing a line from it.

## Tests

Command names below are the ones this repository actually defines in
`package.json`; none are guessed from `githooks/`.

1. **`pnpm check:fast`** (lint, typecheck, `test:fast`) run on this
   `issue-95/claude` branch with `package.json` version left at `0.0.18` —
   identical to `origin/main`. It must pass. Before the change it fails on
   "requires package.json to advance past origin/main"; that transition is
   acceptance criterion 1 and is the primary evidence for this issue.

2. **`pnpm check`** (build + `check:fast` + e2e). Must pass, confirming the
   coordinator's hermetic gate no longer carries the ship gate (issue item 3)
   and that removing the `test:fast` wrapper did not disturb the e2e suite.

3. **New hermetic cases in `test/versionBump.test.ts`.** Build a temp repo with
   `git init`, commit `package.json` at `0.0.1` on `main`, branch to
   `issue-fixture`, then drive `checkVersionBump(tmp, { baseRef: "main", headRef:
   … })`:
   - head `package.json` `0.0.1`, headRef `issue-fixture` → `enforce: true`,
     `ok: false` (a non-advancing branch is still rejected — acceptance
     criterion 2, proved without invoking the network or `origin/main`).
   - head `package.json` `0.0.2`, headRef `issue-fixture` → `enforce: true`,
     `ok: true`.
   - headRef `main` → `enforce: false`, `ok: true` (base branch exempt).
   These replace the deleted live case with coverage that cannot depend on which
   branch the suite runs on, which is precisely what made the old case
   unsatisfiable.

4. **Existing unit cases retained.** The `parseDotVersion` and
   `isStrictlyGreater` cases in `test/versionBump.test.ts` are not modified —
   acceptance criterion 5.

5. **`pnpm check:version-bump` still fails a non-advance.** Run it on this
   branch (version equal to `origin/main`): it must exit non-zero and print the
   updated detail message. Then run it with `COORD_VERSION_BASE_REF` pointed at a
   ref whose version is lower to confirm the success path. This is the CLI half
   of acceptance criterion 2 and must be recorded in the implementation evidence,
   because it is the only remaining live check — a regression here silently
   removes the gate rather than turning a suite red.

6. **`test/cli.test.ts` and `test/install.test.ts` under plain `vitest run`.**
   With the wrapper removed, both must pass against the real, unrewritten files —
   confirming the runtime reads work and that no rewriting shim is still needed.
   Separately confirm `git status --porcelain` is clean after a full
   `pnpm check:fast`, since the old wrapper could leave those files dirty.

7. **PR-gate behavior (observational, no new test).**
   `.github/workflows/version-bump.yml` runs on `pull_request` → `main` and is
   untouched except for a comment, so its behavior is preserved by construction;
   the PR for this issue must show the `version-bump` check running. Note that
   this PR will need a version advance to `0.0.19` in a commit on the PR branch
   before merge — that is the rule this issue keeps, and it must be a separate,
   deliberate commit, not part of the implement step.

## Alternatives Rejected

- **Guard the live case with an env var** (skip unless `COORD_ENFORCE_VERSION_BUMP=1`).
  Rejected: it leaves a suite whose result depends on ambient environment, and
  every agent clone would still inherit whatever the default happened to be. The
  PR workflow already sets `COORD_VERSION_BASE_REF` explicitly; a second,
  invisible toggle is a worse contract than deleting the case.

- **Move the live case into the e2e suite** (`pnpm test:e2e`, the declared
  prepush for workflow-critical paths). Rejected: `pnpm check` — the coordinator's
  gate — includes `test:e2e`, so the ship gate would still block implement,
  compare, and revise commits mid-issue. That is exactly what issue item 3
  forbids.

- **Keep the ship gate and fix only the companion-file trap** (make the version
  assertions runtime reads, leave the live case in place). Rejected: it repairs
  the symptom seen on issue 92 while leaving the rule the owner rejected —
  agents would still have to bump `package.json` on every intermittent commit and
  still have to guess a free `0.0.N` under concurrent issues.

- **Keep the `test:fast` wrapper and change only the ship gate.** Rejected: the
  wrapper's own documented failure modes stay — it makes the `coord --version`
  assertion vacuous by comparing `package.json` to itself, it means `pnpm check`
  no longer observes the tree as committed even though that command is the
  coordinator's final gate, and an interrupted run leaves tracked test files
  dirty. Its stated removal condition is met here.

- **Automate the bump in finalize.** Explicitly out of scope per the issue; the
  bump stays a normal commit on the PR branch.

- **Delete `checkVersionBump` and inline the comparison in the workflow.**
  Rejected: it would drop the `enforce: false` base-branch exemption and the
  dotted-triple validation, and acceptance criterion 5 requires the compare
  helpers to survive.

## Risks and Mitigations

- **`AGENTS.md` is `skip-worktree`; a normal edit stages nothing and clearing the
  bit is forbidden.** Confirmed in this clone (`git ls-files -v -- AGENTS.md` →
  `S`) and stated as an invariant in docs/repo-map.md. Mitigation — stage the new
  blob without touching the worktree file, then restore the bit in the same
  breath: `git show HEAD:AGENTS.md` → edit into a scratch file →
  `git hash-object -w` → `git update-index --cacheinfo 100644,<blob>,AGENTS.md`
  → **immediately** `git update-index --skip-worktree -- AGENTS.md` → commit.
  Rehearsed in a throwaway repository: `--cacheinfo` does flip the flag to `H`,
  the re-set restores `S`, the commit carries the edited content, the overlay in
  the worktree is untouched, and `git status` ends clean. The implementer must
  verify `git ls-files -v -- AGENTS.md` prints `S` before committing, and must
  escalate rather than improvise if it does not. Never `git add AGENTS.md`,
  never `git commit -a`, never `--no-skip-worktree` as a repair.

- **This branch cannot pass `check:fast` until the first edit lands.**
  `package.json` is `0.0.18` on both sides, so the ship-gate case is red right
  now. Mitigation: make edit 1 (`test/versionBump.test.ts`) before running any
  verification, and keep edits 1–4 in a single commit — an intermediate state
  with the wrapper removed but the literals still hardcoded, or the literals
  fixed but the gate case still live, is red either way.

- **Removing the wrapper could expose a hidden dependency on rewritten files.**
  The wrapper patched exactly two assertions (`test/cli.test.ts`,
  `test/install.test.ts`); both are replaced by runtime reads in this plan.
  Mitigation: `pnpm check` (not just `check:fast`) must pass, and
  `git status --porcelain` must be empty afterward.

- **The runtime version reads could become vacuous.** Comparing
  `coord --version` output to `package.json` is only meaningful if the test reads
  the file itself rather than calling the same production helper the CLI uses.
  Mitigation: the file-list entries for edits 3 and 4 require a direct
  `readFileSync`/`JSON.parse` of `repoRoot`'s `package.json`; a review that finds
  `packageVersion` imported into either test should reject the implementation.

- **Silently losing the merge gate.** Every other change in this plan weakens a
  check; if `.github/workflows/version-bump.yml` or
  `check:version-bump` were also broken, nothing would notice until an
  un-advanced version reached `main`. Mitigation: the workflow change is
  comment-only, src/checkVersionBump.ts is untouched, and Tests item 5 requires
  running `pnpm check:version-bump` and observing a non-zero exit on this
  branch.

- **Docs drifting apart.** Four agent-facing surfaces state the old rule
  (`AGENTS.md`, `docs/coord-driver.md`, `docs/repo-map.md`, `src/cli.ts` help).
  Missing one leaves agents planning a bump per commit — the behavior this issue
  removes. Mitigation: after the edits,
  `grep -rn "on every ship" src docs AGENTS.md` and
  `grep -rn "strictly greater" AGENTS.md docs` must return only text that refers
  to the PR into `main`.

- **The PR for this issue still needs `0.0.19`.** Removing the local gate makes
  it easy to forget. Mitigation: the workflow will block the merge, which is the
  intended safety net; the bump goes in its own commit on the PR branch before
  merge, never inside the implement step.

## Conclusion

Delete the live ship-gate case from `test/versionBump.test.ts` and replace it
with hermetic cases that exercise `checkVersionBump` against a temporary
repository; leave `.github/workflows/version-bump.yml` and
`pnpm check:version-bump` as the single enforcement point; correct the four
agent-facing surfaces that still claim precommit enforcement; and, because the
approved paths now include `test/cli.test.ts`, retire the `test:fast` rewriting
wrapper by making both hardcoded version assertions read `package.json` at
runtime. Together these satisfy all five acceptance criteria: `check:fast` goes
green on a branch whose version equals `origin/main`, `check:version-bump` and
the PR workflow still block a non-advancing merge, the docs stop instructing a
per-commit bump, and the compare helpers keep their unit tests. Nothing here
touches approved-path extraction, pre-1.0 `0.0.N` versioning, or finalize.

# Issue 95: Move package version ship gate to PR/merge only

## Problem

Pre-1.0 coordination requires `package.json` to advance (`0.0.N`) so merges are
visible after reinstall. That rule is enforced in **two** places today:

1. **Local / mid-protocol:** `test/versionBump.test.ts` (“version bump ship
   gate”) runs inside `pnpm test:fast` → `pnpm check:fast` (agent precommit) and
   therefore also inside the coordinator’s hermetic `pnpm check`.
2. **PR into `main`:** `.github/workflows/version-bump.yml` runs
   `pnpm check:version-bump`.

Because (1) fires on every non-`main` product commit, agents must bump during
ordinary protocol work. That collides with approved file maps: plans list
`` `package.json` `` but often omit companion tests that hardcode the old
version (`test/cli.test.ts`, sometimes `test/install.test.ts`). Updating those
tests is required for `check:fast` to pass, but evidence validation rejects
paths outside `approvedPaths`. Result: an unsatisfiable implement action (seen
on issue 92).

## Goal

Enforce the version advance **only at PR/merge into `main`**. Mid-protocol
commits and coordinator `checks` must not require a newer `package.json` than
`origin/main`.

## Exact File List to be changed or deleted

### Changed

- `test/versionBump.test.ts` — delete the entire `describe("version bump ship
  gate", …)` block that calls `checkVersionBump(process.cwd(), …)` against
  `origin/main` (or `COORD_VERSION_BASE_REF`). Keep the
  `describe("version bump compare", …)` cases for `parseDotVersion` /
  `isStrictlyGreater`. Drop the unused `checkVersionBump` import.
- `.github/workflows/version-bump.yml` — keep the `pull_request` → `main` job and
  `pnpm run check:version-bump` step unchanged. Rewrite the header comment so it
  no longer claims enforcement via `test/versionBump.test.ts` /
  `pnpm check:fast` / precommit; state that this Action (plus the standalone
  `check:version-bump` script) is the sole ship gate.
- `AGENTS.md` — in the “Checks that actually run” paragraph, remove the sentence
  that `pnpm check:fast` on non-`main` branches requires `package.json` version
  strictly greater than `origin/main`. Leave the rest of the precommit /
  coordinator `checks` wording intact. (Edit the tracked file; do not clear
  `skip-worktree` or strip the clone-local protocol overlay.)
- `docs/coord-driver.md` — in “Starting and running”, replace the claim that
  `pnpm check:fast` (precommit) fails when version is not ahead of `origin/main`
  with: pre-1.0 still uses `0.0.N`; the bump is required on **PRs into `main`**
  (GitHub Action `version-bump` / `pnpm check:version-bump`), not on mid-protocol
  precommit. Keep the note that concurrent PRs must claim distinct next versions.
- `docs/repo-map.md` — remove the paragraph that says the fast suite asserts
  version ahead of `origin/main` via `test/versionBump.test.ts`. Update the
  `test:fast` wrapper subsection: after the companion-test softens below land,
  restore documentation to plain `vitest run` (delete the “currently wrapped”
  warning and the collision rationale that assumed a mid-protocol ship gate).
- `src/cli.ts` — in the help / usage text, change “bump on every ship” to
  “bump before merge to main” (or equivalent) so CLI copy matches the PR-only
  gate.
- `src/install.ts` — update the `packageVersion` doc comment from “bump 0.0.N on
  every ship” to “bump 0.0.N before merge to main”.
- `src/versionBump.ts` — keep `checkVersionBump` for the standalone CLI/Action.
  Update the function doc comment and the failure `detail` string so they say
  the advance is required for merge to `main` / PR base, not “on every ship”.
  Do not change compare semantics.
- `test/cli.test.ts` — stop hardcoding `"0.0.14"`; assert `coord --version` /
  `-V` / `version` against the version read from repo-root `package.json` at
  test time (same source `packageVersion` / CLI use).
- `test/install.test.ts` — stop hardcoding `"0.0.16"` for
  `config.coordination?.version`; assert against the version read from
  repo-root `package.json` at test time.
- `package.json` — (1) restore `"test:fast"` to plain
  `vitest run --config vitest.config.ts` (remove the node one-liner that
  rewrites hardcoded version assertions). (2) Do **not** add
  `check:version-bump` to `"check"` or `"check:fast"`. (3) On the PR branch
  **once before merge**, bump `"version"` from `0.0.18` to `0.0.19` so the
  PR Action passes; do **not** bump on intermediate implement/revise commits
  after the live ship-gate test is removed.

### Deleted

- None (ship-gate coverage is removed from the vitest file by editing
  `test/versionBump.test.ts`, not by deleting the file).

## Exact file list to be created

- None. Reuse `src/versionBump.ts`, `src/checkVersionBump.ts`, and the existing
  GitHub Action; no new module is required.

## Tests

Named commands (do not invent from hooks alone):

- Focused: `pnpm exec vitest run test/versionBump.test.ts test/cli.test.ts test/install.test.ts`
- Pre-commit gate: `pnpm check:fast` (lint, typecheck, fast tests; no Vite build)
- Standalone ship gate (must remain): `pnpm check:version-bump`
- Coordinator acceptance before PR: `pnpm check` (build + check:fast + e2e) —
  must **not** invoke `check:version-bump`

Required coverage mapped to acceptance:

| Case | Assertion |
| --- | --- |
| A1 | On an `issue-*` branch whose `package.json` version equals `origin/main`, `pnpm check:fast` passes version-related tests (no live ship-gate failure in vitest). |
| A2 | `parseDotVersion` / `isStrictlyGreater` unit cases in `test/versionBump.test.ts` still pass. |
| B1 | With HEAD version ≤ base ref version on a non-base branch, `pnpm check:version-bump` exits non-zero. |
| B2 | `.github/workflows/version-bump.yml` still runs `pnpm run check:version-bump` on `pull_request` → `main` (workflow file review; no CI dry-run required in-protocol). |
| C1 | `AGENTS.md` and `docs/coord-driver.md` no longer instruct agents to bump for every non-main `check:fast`. |
| C2 | `test/cli.test.ts` / `test/install.test.ts` track `package.json` without the `test:fast` rewrite wrapper; `"test:fast"` is plain vitest. |
| C3 | `package.json` scripts `"check"` / `"check:fast"` do not call `check:version-bump`. |

## Alternatives Rejected

- **Keep the live vitest ship gate and teach plans to always list companion tests:**
  rejected — still forces agents to pick a free `0.0.N` mid-protocol and still
  collides with incomplete file maps; owner expectation is bump at ship/merge.
- **Move the ship gate into workspace `config.checks` / coordinator hermetic
  `pnpm check`:** rejected — that would keep blocking implement/compare/revise
  commits; the issue forbids wiring version-bump into workspace `checks`.
- **Remove `pnpm check:version-bump` and the GitHub Action entirely:** rejected —
  pre-1.0 still needs a visible advance on merge; only the mid-protocol
  enforcement moves.
- **Auto-bump in finalize:** rejected (out of scope) — bump remains a normal
  commit on the PR branch before merge.
- **Change `approvedPaths` / plan file-map extraction:** rejected (out of scope).
- **Leave hardcoded version strings and keep the `test:fast` rewrite wrapper:**
  rejected for this PR — the issue recommends softening those tests in the same
  change set; keeping the wrapper preserves dirty-tree and vacuous-assertion
  hazards documented in `docs/repo-map.md`.
- **Add a new fixture-based vitest suite that calls `checkVersionBump` against a
  temp git repo:** deferred — useful later, not required for acceptance; CI/Action
  plus the standalone script remain the enforcement path.

## Risks and Mitigations

- **PR merges without a bump:** after removing the precommit gate, agents may
  forget to bump before opening/merging the PR. Mitigation: keep the GitHub
  Action red until `0.0.N` advances; document PR-only bump in `AGENTS.md` /
  `docs/coord-driver.md` / CLI help; list the one-time `0.0.18` → `0.0.19` bump
  in this plan’s file map.
- **Concurrent PRs racing the same next version:** unchanged risk. Mitigation:
  keep the existing “concurrent PRs must claim distinct next versions” guidance
  in `docs/coord-driver.md`.
- **`skip-worktree` on `AGENTS.md`:** local overlay must not be stripped when
  editing the tracked ship-gate sentence. Mitigation: edit only that sentence;
  do not clear index flags; if the clone looks wrong, escalate per protocol.
- **Stale agent habits:** plans for other issues may still list a ritual
  mid-protocol bump. Mitigation: docs/help text stop requiring it; evidence no
  longer fails solely because version equals `origin/main` during implement.
- **Wrapper removal leaves a failing hardcoded assertion if softens are missed:**
  mitigation — change `test/cli.test.ts` and `test/install.test.ts` in the same
  commit as restoring plain `test:fast`; verify with focused vitest before
  `check:fast`.

## Conclusion

Issue 95 removes the mid-protocol version ship gate from `pnpm check:fast` /
vitest while keeping `pnpm check:version-bump` and
`.github/workflows/version-bump.yml` as the sole merge gate into `main`. Agent
docs and CLI copy stop telling agents to bump on every non-main commit.
Hardcoded version expectations in `test/cli.test.ts` and `test/install.test.ts`
are softened and the `test:fast` rewrite wrapper is deleted so a late PR bump
does not require editing omitted companion files. Bump `package.json` once to
`0.0.19` on the PR branch before merge; do not bump on intermediate protocol
commits after the live ship-gate test is gone. Verify with focused vitest,
`pnpm check:fast`, standalone `pnpm check:version-bump`, and full `pnpm check`
(without wiring version-bump into `checks`).

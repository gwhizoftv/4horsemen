# Issue 95 plan review (cursor)

Bound plans reviewed:

- cursor `50a6f7c0dc6941c61ae17aa1890015137b5d651f`
- claude `8eb124c6495be6c19cb12afd3531c225b86166f5`
- codex `95ffc31408fb69bc596d2c863fd34df3977b1afa`

## Findings

### Cursor — late `0.0.19` bump is inside the implement Exact File List

**Claim:** Exact File List / `package.json` item (3) tells the implementer to bump
`"version"` from `0.0.18` to `0.0.19` “on the PR branch once before merge,” in the
same approved-path bullet as restoring `test:fast`, while Tests A1 requires
`pnpm check:fast` to pass with version equal to `origin/main`.

**Rule:** Mid-protocol implement/revise commits must not be required to advance
`package.json`; the issue’s primary acceptance proof is that `check:fast` is
green when the version still equals `origin/main`. Merge preparation is a later,
deliberate PR-branch commit (issue out-of-scope: no auto-bump in finalize).

**Failure:** An implementer completing the listed `package.json` work in the
implement pin advances to `0.0.19` before review/revise finish. The implement
evidence never records A1 (equal-to-main), and this issue itself reintroduces
mid-protocol version selection / concurrent-PR guessing the issue exists to
stop.

**Correction:** Keep `` `package.json` `` only for restoring plain `test:fast`
(and the “do not wire `check:version-bump` into `check`/`check:fast`” constraint).
Document the `0.0.19` advance as merge preparation outside the implement step,
as Claude and Codex do.

### Cursor — `AGENTS.md` edit with no staging path under `skip-worktree`

**Claim:** Exact File List says to edit tracked `AGENTS.md` (remove the
non-main `check:fast` ship-gate sentence) and “do not clear `skip-worktree`,”
but gives no mechanism that actually puts a new blob in the index.

**Rule:** `docs/repo-map.md` states `AGENTS.md` is `skip-worktree` in every agent
clone: editing the worktree stages nothing, and clearing the bit is forbidden.
`AGENTS.md` / protocol also forbid clearing the bit to “fix” git status.

**Failure:** Following the plan with ordinary `git add AGENTS.md` /
`git commit -a` leaves the documentation change out of the published commit
(add refuses the sparse/skip-worktree path; status stays clean) while the
implementer believes the agent-facing rule was updated — or the agent clears
`skip-worktree` to force the edit, violating protocol.

**Correction:** Adopt Claude’s index-only staging sequence (`git show HEAD:AGENTS.md`
→ edit scratch → `git hash-object -w` → `git update-index --cacheinfo` →
immediately `git update-index --skip-worktree -- AGENTS.md`, verify `S` before
commit), or an equivalent that never clears the bit and never `git add`s the
worktree overlay.

### Cursor — live ship-gate deletion without hermetic `checkVersionBump` coverage

**Claim:** Alternatives Rejected defers “fixture-based vitest … `checkVersionBump`”
as not required; Exact File List only keeps `parseDotVersion` /
`isStrictlyGreater` cases after deleting the live `origin/main` describe.

**Rule:** After removing the live suite assertion, regressions in
`checkVersionBump` decision logic (`ok`/`enforce` for equal vs greater vs base
branch) must still be detectable in `pnpm check:fast` / `pnpm check`, not only
when someone remembers a manual negative `pnpm check:version-bump` run.

**Failure:** A later edit that breaks equal-version rejection or the base-branch
exemption still leaves `check:fast` green; the sole remaining gate is the
comment-preserved workflow plus an optional CLI invocation. That is how the merge
gate can be lost silently — the risk Claude/Codex mitigate with hermetic temp-git
cases.

**Correction:** Replace the deleted live case with hermetic temp-repo tests of
`checkVersionBump` (equal → not ok; greater → ok; on base → `enforce: false`), as
in the Claude and Codex plans; keep running `pnpm check:version-bump` as the
live negative acceptance check on this branch.

### Codex — `AGENTS.md` update asserted without an index-safe procedure

**Claim:** Exact File List / `AGENTS.md` says to update tracked documentation and
“preserve the clone-local skip-worktree overlay and its index bit,” without
naming how the new tracked blob enters the commit.

**Rule:** Same as above: worktree edits to `AGENTS.md` do not stage; clearing
`skip-worktree` is forbidden (`docs/repo-map.md`).

**Failure:** Implement publishes every other file-map path and still ships the
old precommit ship-gate sentence in the committed `AGENTS.md` blob, so agents
keep planning mid-protocol bumps (acceptance C1 fails on the published tree).

**Correction:** Spell the same cacheinfo (or equivalent) sequence Claude gives,
and require `git ls-files -v -- AGENTS.md` → `S` immediately before commit.

### Claude — false premise that `repoRoot` is already imported in `test/cli.test.ts`

**Claim:** Exact File List item 3 says the CLI version assertion becomes a
runtime read of `package.json` “under `repoRoot` (already imported from
`./support/workspaceFixture.js`).”

**Rule:** Plan claims about current source must match the bound baseline so the
file map is mechanically executable without discovering missing imports at
typecheck time.

**Failure:** At baseline, `test/cli.test.ts` imports
`ensureBuilt, makeProduct, writeDeclaration, type ProductFixture` from
`./support/workspaceFixture.js` and does **not** import `repoRoot`. An
implementer who trusts the plan writes `repoRoot` usages without extending the
import; `pnpm check:fast` fails on the unresolved binding, or they invent a
second path to the manifest and diverge from the install-test approach.

**Correction:** Explicitly add `repoRoot` to that import (or resolve the manifest
via `fileURLToPath` / a small shared helper as Codex’s
`` `test/support/workspaceFixture.ts` `` export), matching what
`test/install.test.ts` already does.

## Conclusion

All three plans remove the live vitest ship gate, keep
`.github/workflows/version-bump.yml` / `pnpm check:version-bump` as the sole
merge enforcement, restore plain `test:fast`, soften hardcoded version
assertions, and rewrite agent/docs/CLI copy away from per-commit bumps. Claude
is the most mechanically complete (measured A1 precondition, hermetic
`checkVersionBump` cases, explicit `AGENTS.md` staging under `skip-worktree`,
negative CLI gate check) but must fix the false `repoRoot`-already-imported
claim in `test/cli.test.ts`. Codex matches that spine (shared manifest helper +
hermetic gate tests + late bump outside implement) but leaves `AGENTS.md`
unstageable as written. Cursor has the right product scope and file set but
should not list the merge-time `0.0.19` bump inside the implement Exact File
List, must specify skip-worktree-safe `AGENTS.md` staging, and should not defer
hermetic `checkVersionBump` coverage. Prefer Claude’s file map and tests as the
implementation spine, with Codex’s shared fixture helper and Cursor’s explicit
“do not wire version-bump into `check`/`check:fast`” constraint retained.

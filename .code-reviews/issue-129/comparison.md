# Issue 129 — implementation comparison

Bound implementation pins:

- claude `0f04c419068f70d5452d0798423a4ae4548a8665`
- cursor `e329a8706499f95edd3926155924da9cea41fa81`
- codex `95b888dd77a79316d6efaffc43442de19d929fa4`

All three stay inside the approved path set (`src/gitExec.ts`,
`test/workspace.test.ts`, `test/cli.test.ts`, `docs/coord-driver.md` plus
coordination artifacts). Each puts the directory preflight on the shared
`git()` boundary, rechecks after spawn failure, keeps `GitResult` / hermetic env
unchanged, covers missing / non-directory / symlink / PATH-absent cases, and
adds a `wipe-issue --product` CLI refusal that exits 2 without `spawnSync` in
the missing-path message. No new product modules or dependencies.

## Comparison

### Shared shape

| Concern | claude `0f04c419` | cursor `e329a870` | codex `95b888dd` |
| --- | --- | --- | --- |
| Preflight | `statSync` + string problem | tagged `inspectWorkingDirectory` | `statSync` + `accessSync(X_OK)` |
| Missing cwd message | `<cwd> does not exist` | `path does not exist` | `working directory does not exist` |
| Non-directory | `is not a directory` | `path is not a directory` | `working directory is not a directory` |
| PATH / ENOENT | “git executable was not found on PATH” | “git executable not found on PATH” | “could not find or launch git; check PATH” **plus** raw `spawnSync … ENOENT` |
| Docs | yes | yes | yes |
| Issue-shaped CLI | yes (relative + absolute) | yes (relative + absolute + control) | yes (relative + absolute + control) |

### Findings

#### 1. Claude — `ENOTDIR` is labeled “does not exist”

**Path:** `src/gitExec.ts:18` (claude `0f04c419068f70d5452d0798423a4ae4548a8665`).

**Rule:** An `ENOTDIR` from `statSync` (path whose parent component is a file,
e.g. `<file>/child`) must be reported as a non-directory path, not as missing;
missing vs non-directory are distinct diagnostics in the selected plan and in
claude’s own docs.

**Failure:** `workingDirectoryProblem` returns `"does not exist"` for both
`ENOENT` and `ENOTDIR`. `coord … --product /tmp/file/nested` therefore prints
“does not exist” even though a file blocks the path, contradicting the
“is not a directory” branch used for a bare regular file at lines 15–15 and the
docs wording.

**Test:** In `test/workspace.test.ts`, assert
`resolveWorkspaceFromProduct(join(file, "child"))` throws `/is not a directory/`
and not `/does not exist/` (codex already covers this at
`test/workspace.test.ts:76`).

#### 2. Codex — PATH launch errors still advertise `spawnSync`

**Path:** `src/gitExec.ts:41-43` and `test/workspace.test.ts:92-93`
(codex `95b888dd77a79316d6efaffc43442de19d929fa4`).

**Rule:** When the working directory is valid and launch fails with `ENOENT`,
the operator-facing message must identify a Git/PATH problem; it must not rely
on the raw `spawnSync git ENOENT` wrapper that caused the original misread for
missing cwd (the same wrapper text on PATH failures reintroduces that reading).

**Failure:** After a successful directory preflight, the throw concatenates the
PATH hint with `result.error.message`, and the suite **requires**
`spawnSync git ENOENT` in the message. Operators (and greppers trained by the
issue) still see the spawn wrapper on a real PATH failure.

**Test / fix sketch:** Assert the PATH phrase and `not.toThrow(/spawnSync/)`
(or `not.toMatch`), matching claude/cursor; keep OS details only if they do not
reintroduce the spawnSync token, or put them behind a secondary “detail:” suffix
the issue-shaped CLI cases do not treat as the primary diagnosis.

#### 3. Cursor — preflight errors omit the git subcommand

**Path:** `src/gitExec.ts:28-35` (cursor `e329a8706499f95edd3926155924da9cea41fa81`).

**Rule:** Directory diagnostics should name the attempted path and remain
actionable; including the git argv (as claude/codex do) makes log lines match
the failing operation.

**Failure:** Preflight throws `Cannot run git in ${cwd}: path does not exist`
without `rev-parse --show-toplevel` (or other args). Behavior is correct for the
issue, but logs are harder to correlate than claude’s
`Cannot run git ${args}: ${cwd} …` form. Not a functional blocker for
`--product` refusal.

**Smallest correction:** Mirror the spawn-error template:
`Cannot run git ${args.join(" ")} in ${cwd}: path does not exist.`

### Scope, reuse, and coverage

- **claude:** Smallest clear implementation; focused tests; PATH message is
  clean. Incomplete `ENOTDIR` classification (finding 1). No `accessSync` /
  race-mock extras.
- **cursor:** Same architecture; correctly maps `ENOTDIR` → not-directory
  (`src/gitExec.ts:21`); CLI non-mutation snapshot is strong. Slightly more
  ceremony (tagged union) without extra behavior; preflight omits argv
  (finding 3).
- **codex:** Broadest tests (inaccessible dir, race recheck via `vi.spyOn`,
  `file/child` ENOTDIR, subdirectory + symlink locator). `accessSync(X_OK)` is
  justified for chdir but is extra surface. PATH message regresses the
  spawnSync-free reading (finding 2).

### Preference

Prefer **cursor `e329a870`** or **claude `0f04c419` with finding 1 fixed** for
merge: both fix the reported diagnostic without retaining `spawnSync` in
operator-facing PATH text. Between the two pins as written, **cursor** wins on
`ENOTDIR` labeling; **claude** wins on message wording that includes the git
command. **codex `95b888dd`** is acceptable if finding 2 is fixed; its extra
tests are valuable but should not force keeping `spawnSync` in the PATH error.

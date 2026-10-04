# Implementation comparison: issue 129

Bound implementation pins compared:

- claude `0f04c419068f70d5452d0798423a4ae4548a8665`
- cursor `e329a8706499f95edd3926155924da9cea41fa81`
- codex `95b888dd77a79316d6efaffc43442de19d929fa4`

All three were read from the coordinator-exported worktrees and diffed against
baseline `8392d92`. Each pin changes the same four product paths
(`src/gitExec.ts`, `test/workspace.test.ts`, `test/cli.test.ts`,
`docs/coord-driver.md`), all inside the approved list. I did not run the peer
suites for this comparison. For my own pin, `pnpm check:fast` passed 683/683; an
earlier run hit one load-sensitive timeout in `test/onboard.test.ts`, which
passes when run alone.

## Comparison

### Shared design: all three are correct for the reported failure

Each pin adds a `statSync` preflight (it follows symlinks) to `git()` in
`src/gitExec.ts`, before `spawnSync`:

- a missing path or dangling symlink reports "does not exist";
- a regular file reports "is not a directory";
- the directory is rechecked after a spawn error;
- `ENOENT` against a valid directory is reported as git missing from `PATH`;
- every other launch error keeps its original message.

So `coord wipe-issue 392 --force --product coordinator` exits 2 with a path
diagnostic in all three, and so does `coord onboard <typo>` (through
`requireWorktree` → `git()`). `GitResult`, `gitOrThrow`, Git exit-code handling
and `hermeticGitEnv` are unchanged everywhere. No pin adds a file, dependency or
abstraction beyond one private helper, and none touches `wipeIssue.ts`,
`workspace.ts` or the CLI.

The pins differ in message details and in how heavy the tests are.

| | claude | cursor | codex |
| --- | --- | --- | --- |
| Missing-path message | `Cannot run git <args>: <cwd> does not exist.` | `Cannot run git in <cwd>: path does not exist.` | `Cannot run git <args> in <cwd>: working directory does not exist` |
| Keeps git subcommand in path errors | yes | **no** | yes |
| `ENOTDIR` (path under a file) | "does not exist" | "not a directory" | "not a directory" |
| Extra `accessSync(X_OK)` preflight | no | no | yes |
| Inaccessible-directory branch tested | **no** | **no** | yes (`chmod 000`, skipped as root) |
| Post-spawn recheck tested | **no** | **no** | yes (`spawnSync` spy) |
| CLI fixture | `makeProduct` + runtime sentinel | hand-built owner + clone | `makeProduct` + clone + staged/unstaged/untracked state |
| New workspace tests | 2 (+ extended locator test) | 2 (+ extended) | 4 (+ extended) |

### Finding C1: cursor, `src/gitExec.ts:28-36` (`workingDirectoryError`)

- **Rule:** a git failure must name the command it was running. Every other
  error from `git()` and `gitOrThrow` includes `git ${args}`, and operators use
  it to tell which step of a multi-step command failed.
- **Failure:** `onboard` runs several git commands against the same product
  path, and every one of them now reports the identical
  `Cannot run git in /x/coordinator: path does not exist.` When the directory
  disappears partway through, nothing in the message shows which step failed.
  The baseline message, `Cannot run git rev-parse --show-toplevel in …`, did
  show it.
- **Smallest test:**
  `expect(() => git(missing, "rev-parse", "--show-toplevel")).toThrow("git rev-parse --show-toplevel")`.

### Finding C2: claude, `test/workspace.test.ts` (PATH test `finally`)

- **Rule:** a test that mutates `process.env` must restore it exactly.
- **Failure:** `process.env.PATH = savedPath` assigns the string `"undefined"`
  when `PATH` was unset. Any later git spawn in the same worker would then fail
  with `ENOENT`. This is an edge case, since CI always sets `PATH`. Cursor and
  codex both branch on `undefined` and `delete` the key instead.
- **Fix sketch:**
  `if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;`

### Finding C3: claude and cursor, the `src/gitExec.ts` recheck and "inaccessible" branches have no tests

- **Rule:** the selected plan requires reporting inaccessible directories
  distinctly and rechecking after a spawn failure, and every added branch needs
  a test that fails if the branch is removed.
- **Failure:** deleting the post-spawn recheck, or the `cannot be accessed` /
  `inaccessible` branch, from either pin leaves its suite green. A regression
  that reports a directory removed mid-run as "git not found on PATH" would
  ship unnoticed.
- **Example:** codex already has these tests at `test/workspace.test.ts:101-144`:
  a `chmod 000` parent, and a `spawnSync` spy that removes the cwd and then
  returns `ENOENT`.

### Finding C4: codex, `src/gitExec.ts:11` (`accessSync(cwd, X_OK)`)

- **Rule:** the preflight should only diagnose; it must not refuse a cwd that
  git could actually use.
- **Assessment:** this is not a defect on POSIX. A directory without search
  permission makes `chdir` fail anyway, so the extra check only gives that case
  a clearer message. It does add a second syscall to every sync git call,
  including hooks, which is negligible. No change is needed; it is noted as the
  only behavioural difference between the pins.

### Finding C5: cursor, `test/cli.test.ts` (hand-built owner repository)

- **Rule:** reuse existing fixtures before building new ones (AGENTS.md
  implementation discipline).
- **Failure:** the test re-implements `makeProduct` inline (init, identity,
  commit, clone). If the fixture's repository defaults change later, for
  example the initial branch or hook installation, this copy drifts. It is a
  maintenance cost, not a correctness bug.

### Scope and test weight

- **claude:** the smallest change. The CLI test reuses `makeProduct` and checks
  refs, status, config and a runtime sentinel. The two new workspace tests
  cover missing path, dangling symlink, regular file and PATH-absent, and the
  locator test is extended for a subdirectory and a symlink. It misses the
  plan's recheck and inaccessible coverage (C3) and has the restore edge case
  (C2).
- **cursor:** the same coverage as claude plus direct `git()` assertions. Its
  messages lose the git subcommand (C1), its CLI fixture is hand-built (C5),
  and it misses the same coverage (C3).
- **codex:** the most faithful to the selected plan. Every branch it added is
  tested, and so are the extra `ENOTDIR`-under-a-file and deleted-directory
  cases. It is also the heaviest: four new workspace tests, including an ESM
  `spawnSync` spy that depends on `syncBuiltinESMExports`, and a CLI test that
  builds a clone and staged, unstaged and untracked state in two repositories.
  Those snapshots pass on baseline, because product selection already ran
  before wipe. The docs section is the longest of the three, but accurate.

### Recommendation

All three pins fix the issue correctly and stay within scope. **codex
`95b888dd77a79316d6efaffc43442de19d929fa4`** is the best match for the selected
plan: it is the only pin whose every added branch is tested, and it has no
correctness findings. **claude `0f04c419068f70d5452d0798423a4ae4548a8665`** is
the smallest acceptable alternative if the reviewers prefer lighter tests over
covering every branch. **cursor `e329a8706499f95edd3926155924da9cea41fa81`** is
acceptable but ranks last because of C1 and C5.

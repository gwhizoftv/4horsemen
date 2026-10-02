# Plan — issue #145: make the fast suite hermetic and stop the false exit 1

Issue #145 reports three test-environment defects that block commits in agent
clones, because the pre-commit hook runs `pnpm check:fast`:

1. **Git shim:** `COORD_GIT_DELEGATE=1` leaks into the shim tests, and two of them fail.
2. **Vitest:** the run reports `Timeout calling "onTaskUpdate"` and exits 1 even though every test passes.
3. **Real home directory:** two installer tests write the owner's real Antigravity settings.

All three are test-harness defects. No `src/` behavior changes.

### Evidence gathered on baseline 845d28d (this clone, Node 26.7.0, vitest 3.2.7)

- **Shim:** `COORD_GIT_DELEGATE=1 pnpm exec vitest run test/install.test.ts` fails two tests:
  - `generated git shim > refuses the reads coordination owns and delegates everything else`
  - `generated git shim > blocks the pinned peer read only once the action lists the files`

  Both expect exit 2 and get 0. Cause: `runGit` (`test/install.test.ts:772`) builds its env as
  `{ ...process.env, COORD_ISSUE: "42", ...env }`. A commit made through `.coord/bin/git` exports
  `COORD_GIT_DELEGATE=1` (`scripts/lib/launcher.sh:130`). The hook passes that variable on to
  `hook-verify`, pnpm and vitest. The shim under test then takes its "already delegated" branch
  (`launcher.sh:134`) and exits 0. Without the variable, all 46 tests pass.
- **Vitest timeout:** `pnpm test:fast` exited 1 in every run I made on baseline (3 of 3), each
  time with `Test Files 40 passed`, `Tests 621 passed` and `Errors 1 error: [vitest-worker]:
  Timeout calling "onTaskUpdate"`. The error is printed right after the `test/install.test.ts`
  results, and that file runs for 62.8 s. That is longer than vitest's 60 s birpc timeout.
  - **Why it happens:** every test in `test/install.test.ts` is synchronous (`execFileSync`).
    Between synchronous tests, `@vitest/runner` only awaits microtasks. The worker's event loop
    therefore never reaches the poll phase for the whole file, so the RPC reply sits unread
    until the 60 s timer fires.
  - **What did not fix it:** making `test/runLoop.test.ts`'s `safetyFixture.tick` yield with
    `setImmediate`. That was the earlier suspect; two full runs with the change still exited 1.
  - **What did fix it:** a vitest `setupFiles` entry whose `beforeEach` awaits
    `new Promise((r) => setImmediate(r))`. With only that change, three consecutive full runs
    exited 0 (621/621 passed), with `install.test.ts` still taking 63–64 s. I removed the probe
    files afterwards and the tree is clean.
  - **Why the owner's workaround helped:** `VITEST_MAX_FORKS=1` only made it pass by sometimes
    keeping that file under 60 s.
- **Real home directory:** I ran `test/install.test.ts` with `HOME` pointed at an empty scratch
  directory. Afterwards it held
  - `.gemini/antigravity-cli/settings.json`
  - `coord-agent-lifecycle-statusline.{json,sh}`

  Two `installOnce` calls install `antigravity` without a `home` override, so `install()` falls
  back to `homedir()` (`src/install.ts:462`):
  - `writes per-agent Terminal profile defaults into workspace config` (`test/install.test.ts:63`)
  - `launches Antigravity unattended without losing its execution mode` (`test/install.test.ts:918`)

  These are the "two installer tests" from the issue. The same fallback also makes every
  Claude install in the suite read the owner's real `~/.claude/settings.json`
  (`src/install.ts:423`). The same file passes all 46 tests with that isolated `HOME`.

## Exact File List to be changed or deleted

- `test/install.test.ts`
  - **Shim env:** add a small `shimEnv()` helper that copies `process.env` and deletes
    `COORD_GIT_DELEGATE`. Use it as the base of `runGit`'s env in the `generated git shim`
    describe, in place of `...process.env`.
  - **Explicit cases unchanged:** a test that sets `COORD_GIT_DELEGATE: "1"` itself
    (`test/install.test.ts:840`, `:886`) still passes it through the `...env` argument, so those
    cases keep their meaning.
  - **`installOnce`** (`test/install.test.ts:34`): default `home` to
    `join(fixture.workspaceRoot, "home")`. It goes before `...overrides`, so an explicit `home`
    still wins (`test/install.test.ts:619` already passes this same path).
  - **`uninstallOnce`** (`test/install.test.ts:249`): give it the same fixture-home default, so a
    future antigravity uninstall cannot call `removeAntigravityStatusLine` on the real home.
  - **New and extended cases:** add the regression cases listed under Tests.
- `vitest.config.ts`
  - Add `setupFiles: ["./test/support/yieldEventLoop.ts"]` to the existing `test` block.
  - Nothing else changes. `vitest.e2e.config.ts` stays as it is: it runs only the async
    `integration.test.ts`, and the issue concerns `check:fast`.

No files are deleted. No `src/`, `scripts/`, `githooks/` or `package.json` change. In
particular, there is no version bump (see AGENTS.md).

## Exact file list to be created

- `test/support/yieldEventLoop.ts`. This is the vitest setup file. It registers one global
  `beforeEach` that awaits one `setImmediate` turn, and has a comment saying why: synchronous
  tests otherwise starve the worker's RPC reply past vitest's 60 s timeout.
  - **Why a new file:** vitest's `setupFiles` needs a module path, and `test/support/` is the
    existing home for shared test infrastructure (`workspaceFixture.ts`).
  - **Why not a `beforeEach` in `install.test.ts` only:** `hookSync.test.ts` (41.8 s),
    `doctor.test.ts` (40.1 s) and `prepareAgentBranch.test.ts` (34.4 s) are the same kind of
    synchronous `git`-heavy file. Under owner-machine load (Spotlight indexing, parallel agents)
    each can cross 60 s the same way.
  - The file needs no ESLint or tsconfig change: `test/tsconfig.json` includes `./**/*.ts`, and
    `pnpm lint` already covers `test`.

## Reuse and Scope

**Reused, unchanged:**
- `makeProduct` / `ProductFixture.workspaceRoot` (`test/support/workspaceFixture.ts`) as the
  per-test home root.
- The existing `installOnce`, `uninstallOnce` and `runGit` helpers in `test/install.test.ts`.
- The existing `install({ home })` / `uninstall({ home })` overrides (`src/install.ts:112`, `:531`),
  which were added for exactly this purpose ("Test/embedding override").
- The existing `generated git shim` and `generated agent launchers` describes, for the new
  assertions.

**Approach:**
- **Shim:** the `shimEnv` approach matches the earlier fix `f833f87` on
  `claude/issue-126-pr-141-review`, which never reached `main`.

**Out of scope (deliberately):**
- **Leaving `src/hookPolicy.ts:121` alone:** that `spawnSync` call still passes the hook's
  inherited env to the verify command. Product verify commands may legitimately run git inside
  the clone during a hook, and should keep the delegated status. The rule that has to hold is
  test hermeticity, so the fix belongs in the test.
- **Other test files:** `onboard.test.ts`, `cli.test.ts`, `hookSync.test.ts`, `doctor.test.ts` and
  `vendor.test.ts` produced no `.gemini` writes on their own (measured file by file with an
  isolated `HOME`).
- **No `runLoop.test.ts` change:** the measurements above disproved it as the cause of the
  timeout.

## Tests

Every new case joins `test/install.test.ts`.

1. **New case in `describe("generated git shim")`:** "refuses even when the suite itself runs
   under a delegated git".
   - Install a claude clone and set `process.env.COORD_GIT_DELEGATE = "1"` inside `try`.
   - Assert that `runGit(clone, clone, ["status"]).status` is `2`.
   - Restore the previous value in `finally`.
   - Before the fix it gets `0`, because `runGit` spreads `process.env`; after the fix it gets
     `2`. This keeps the regression covered in every normal run, not only inside a hook.
2. **Extend `launches Antigravity unattended without losing its execution mode`:**
   - Assert that
     `existsSync(join(fixture.workspaceRoot, "home", ".gemini", "antigravity-cli", "settings.json"))`
     is `true`.
   - Before the fix the install writes to `homedir()`, so the fixture path does not exist and the
     assertion fails. After the fix it passes, and the real home is not touched.
3. **The onTaskUpdate timeout** cannot be unit-tested without a 60 s test. It is validated by the
   check itself:
   - Run `pnpm test:fast` 3 times in a row, without any `VITEST_*_FORKS` or `*_THREADS` exports.
     All three must exit 0. On baseline, 3 of 3 runs exit 1.
   - Report the real exit code of each run.

**Commands to run before committing, in order:**
- `COORD_GIT_DELEGATE=1 pnpm exec vitest run test/install.test.ts`. Must pass: it reproduces
  the hook env directly.
- `pnpm test:fast` ×3, all exit 0.
- `pnpm check:fast` (the `verify.precommit` check: lint + typecheck + fast tests).
- Commit through the normal shim path (`git commit`, not `/usr/bin/git`). This proves that the
  hook's own `check:fast` now passes with the leaked `COORD_GIT_DELEGATE`.
- The coordinator later runs the full `pnpm check` on the approved commit.

## Alternatives Rejected

- **Make `safetyFixture.tick` in `test/runLoop.test.ts` yield.** This was the earlier hypothesis.
  I prototyped it and two full runs still exited 1, so it does not fix the defect.
- **Run vitest in a single fork (`poolOptions.forks.singleFork` or `VITEST_MAX_FORKS=1`).** It
  hides the race by changing timing, not the cause. It also serializes 40 files and makes
  `check:fast` much slower. It fails again once one file's synchronous work alone exceeds 60 s.
- **Raise vitest's RPC timeout.** vitest 3.2 exposes no option for the worker birpc timeout
  (`DEFAULT_TIMEOUT = 6e4`), and patching `node_modules` is not acceptable.
- **Split `test/install.test.ts` into several files.** It only moves the threshold, churns about
  1000 lines of tests, and leaves the other 35–42 s files exposed.
- **Strip `COORD_GIT_DELEGATE` in `hookPolicy.ts` before spawning verify commands.** That changes
  product hook behavior for every managed product, to fix a non-hermetic test. The test is what
  breaks the rule.
- **Set `HOME` globally in the setup file.** It is broader than needed. Spawned tools (git
  identity in `~/.gitconfig`, pnpm and corepack caches) read `HOME`, so tests would start
  depending on a synthetic home that holds none of them. The existing `home` override isolates
  exactly the installer's user-global writes.

## Risks and Mitigations

- **A test may rely on the owner's real `~/.claude/settings.json`** through the new
  `installOnce` default. Mitigation: `test/install.test.ts` passed 46/46 with `HOME` set to an
  empty directory. That reaches the same `homedir()` code path as the new default, so the default
  cannot break a passing case.
- **Lingering `.gemini/antigravity-cli` files from earlier runs in the owner's real home** are not
  cleaned up by this change. Mitigation: the report will say so; cleanup is an owner decision and
  is not done by the plan.
- **The global `beforeEach` adds overhead:** about one event-loop turn per test, under 1 ms each
  across 621 tests. It also cannot reorder anything inside a test, because it runs before each
  test body.
- **A single synchronous test over 60 s could still starve the RPC.** The slowest test today is
  14.5 s (`coord onboard > applies the happy-path defaults…`), and the 15 s `testTimeout` already
  makes long tests visible.
- **The timeout is load-sensitive, so passing 3 runs is evidence, not proof.** Mitigation: the
  mechanism is identified and the A/B test was decisive (baseline 3/3 fail; with the setup file,
  3/3 pass). The validation repeats this on the final commit.

## Conclusion

The plan fixes all three issue #145 defects with test-only changes:

- **Git shim:** strip the leaked `COORD_GIT_DELEGATE` in `test/install.test.ts`'s shim `runGit`.
- **Vitest timeout:** add one vitest setup file that yields a macrotask before each test. That
  lets the worker read vitest's RPC replies during long synchronous files and removes the false
  `onTaskUpdate` exit 1.
- **Real home directory:** default the installer test helpers' `home` to the fixture, so no test
  writes to the owner's real home.

One new support file, two edited files, one new test case and one extended assertion. Afterwards
the commit and push hooks pass without `/usr/bin/git` or single-fork exports.

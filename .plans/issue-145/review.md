# Review — issue #145 plans

Bound inputs reviewed:

- cursor `098cb8181ef8221e2ace0a2df106f54a3ef0c874` — `.plans/issue-145/plan.md`
- codex `efc8ad44d8672911a5d7e4313d74d10aea96ac05` — `.plans/issue-145/plan.md`
- claude `4415a10d356c858b27a9c911b771de8b2b1944a9` — `.plans/issue-145/plan.md`

All measurements below were taken in this clone at baseline 845d28d, on Node 26.7.0 with vitest 3.2.7.

**Shared baseline facts**

- **Delegation leak:** `COORD_GIT_DELEGATE=1 pnpm exec vitest run test/install.test.ts` fails the
  two shim refusal cases.
- **Reporting timeout:** plain `pnpm test:fast` exited 1 in 3 of 3 runs, each time with 621/621
  passing and `Timeout calling "onTaskUpdate"`. The error is printed right after
  `test/install.test.ts`, whose file time was 62.8 s.
- **`install.test.ts` alone:** with no other files running, it took 66.9 s in one run and 46.3 s
  in another.
- **Yield before each test:** a probe vitest config that added only a `setupFiles` `beforeEach`
  awaiting `setImmediate` gave 3 of 3 full runs exiting 0. In those runs `install.test.ts`
  still took 63–64 s.
- **Real home writes:** running `test/install.test.ts` with an empty scratch `HOME` creates
  `.gemini/antigravity-cli/{settings.json,coord-agent-lifecycle-statusline.json,coord-agent-lifecycle-statusline.sh}`.
  The cause is `installOnce` at `test/install.test.ts:65` and `:920`, which install
  `antigravity` without `home`.
- **No `.gemini` writes elsewhere:** none of `onboard`, `cli`, `hookSync`, `doctor` or `vendor`
  writes `.gemini` on its own.

## Findings

### cursor (`098cb818`)

**C1 — File list: "`src/hookPolicy.ts` — scrub `COORD_GIT_DELEGATE` from the env used by the default `inheritRunner`".**

- **Rule:** issue #145 is a test-hermeticity defect. Product hook behavior for every managed
  product must not change to fix it. In particular, a declared verify command that legitimately
  runs git against the clone must keep the delegated pass-through it has today.
- **Failure:**
  - Take a product whose `verify.precommit` declares `["git", "diff", "--cached", "--check"]`,
    a common whitespace gate.
  - Today, in an automated issue, that command inherits `COORD_GIT_DELEGATE=1` from the hook
    and runs. After the scrub it resolves `.coord/bin/git` (the hook inherits the agent's
    PATH), sees `COORD_ISSUE` set and a `diff` against the clone, and exits 2.
  - Every commit in that product is then refused by its own hook.
  - The plan's mitigation ("product checks must not need" this-clone status/diff) is an
    assertion, not something the code enforces.
  - The change is also unnecessary: with the `runGit` env fix in `test/install.test.ts`, the
    leaked variable is harmless to this suite. The `src/hookPolicy.ts` edit also needs its own
    new test, which the plan aims at a file that does not exist (`test/hookPolicy.test.ts`).
- **Correction:** drop the `src/hookPolicy.ts` change and Tests item 3. Keep the fix at the
  test's child-process boundary.

**C2 — File list `vitest.config.ts`: "prefer `pool: "forks"` with `singleFork: true` … raise `teardownTimeout` only if still required".**

- **Rule:** a fast-suite run must not exit 1 when every test passes. The fix has to remove the
  cause, which is a worker that does not read vitest's RPC replies for more than 60 s. Changing
  timing so the race is lost less often does not meet the rule.
- **Failure:**
  - Single-fork still runs `install.test.ts` as one uninterrupted synchronous stretch. That file
    took 66.9 s when run completely alone, which is past vitest's fixed 60 s birpc timeout. So
    single-fork does not guarantee exit 0 on a loaded owner machine.
  - It also serializes all 40 files. Their summed file time in the baseline run was 335 s, so
    `check:fast`, and with it every pre-commit hook, goes from about 65 s to well over 5 minutes.
  - `teardownTimeout` is a different mechanism (hook teardown, not the worker report RPC), so
    the fallback does not help either.
- **Correction:** register a `setupFiles` module with a per-test macrotask yield
  (`await new Promise((r) => setImmediate(r))`). That yield gave 3 of 3 clean full runs without
  serialization.

**C3 — Tests item 2: "assert `~/.gemini/antigravity-cli/` was not created or mutated by the test".**

- **Rule:** a test must not read or assert on the owner's real home.
- **Failure:** on this machine `~/.gemini/antigravity-cli/coord-agent-lifecycle-statusline.json`
  already exists, left by earlier runs of exactly these tests. A "not created" assertion fails
  for this owner even after the fix. In a sandbox that denies the real home, the read itself can
  fail.
- **Correction:** use the plan's own alternative only: assert that the managed settings land
  under `join(fixture.workspaceRoot, "home", ".gemini", "antigravity-cli")`. Before the fix that
  path is absent; after the fix it exists.

**C4 — File list `test/install.test.ts`: "optionally default `installOnce` to a fixture-local home".**

- **Rule:** the plan must say exactly what the implementation does, so reviewers can tell
  whether a regression is covered.
- **Failure:** if the "optional" default is skipped and only the two named call sites get a
  `home`, the next `installOnce(fixture, { agents: ["antigravity"] })` writes to the real home
  again.
- **Correction:** make the `installOnce` and `uninstallOnce` defaults mandatory, placed before
  `...overrides`.

**Scope:** apart from C1, the plan stays within the issue and reuses the existing helpers. Its
created-file list holds only the plan itself.

### codex (`efc8ad44`)

**X1 — File list `vitest.config.ts`: "explicitly use the forks pool with `fileParallelism: false`".**

- **Rule:** every change must be justified by evidence, and no change should add cost
  speculatively.
- **Failure:**
  - The plan admits it did not reproduce the timeout. It pairs serialization with the event-loop
    yield (its `test/support/vitestSetup.ts`), and the yield alone measured 3 of 3 clean runs.
  - Serialization therefore adds no proven reliability. It does turn a roughly 65 s `check:fast`
    into the sum of 40 file times (about 335 s on baseline) on every commit and push hook.
  - It also does not protect a single file that exceeds 60 s on its own: `install.test.ts`
    measured 66.9 s solo.
- **Correction:** keep the setup-file yield and drop `fileParallelism: false`.

**X2 — File list `test/agentHookSync.test.ts`: "fix the observed receiver-fixture publication race".**

- **Rule:** keep work within the issue's three reported defects, unless a new defect is shown
  to block the same hook on the baseline.
- **Assessment:** the race is real by inspection. The stand-in receiver uses `writeFileSync`
  (`test/agentHookSync.test.ts:186`), which creates the file empty before writing, and the
  test polls only `existsSync` before reading (`:216-217`). So an empty read is possible.
- **Failure if followed as written:** the fix expands scope beyond the issue. It is supported
  only by codex's two planning runs; I ran the full suite 8+ times at baseline and never saw
  it. If it lands without a baseline repro recorded, reviewers cannot tell whether it is
  related.
- **Correction:** this is acceptable as a test-only fixture fix. The implementation report
  should say it is outside the reported defects and record the failing baseline output.

**X3 — Tests item 2: "use `uninstallOnce` to verify removal there and preservation of an owner-authored setting … ambient-home sentinel".**

- **Rule:** use the fewest focused tests.
- **Failure:** this adds uninstall and owner-setting preservation coverage to the all-agent
  profile test. That behavior belongs to `removeAntigravityStatusLine`, which
  `test/agentHookSync.test.ts` already covers, and it is not the defect. The
  "ambient-home sentinel" is also unspecified: it is unclear what directory it watches if
  `HOME` is not overridden.
- **Correction:** assert only that the settings land under the fixture home, which fails before
  the fix and passes after.

**Otherwise sound:**

- Setting `COORD_GIT_DELEGATE` to `""` in `runGit`, before the per-call `...env`, is correct;
  the shim tests `== 1`.
- The `installOnce` and `uninstallOnce` home defaults are correct.
- Its rejection of a hook-level scrub matches C1.

### claude (`4415a10d`, self-review)

**S1 — File list: the `uninstallOnce` home default is not exercised by any test.**

- **Rule:** every helper change should be justified by a defect or a regression it prevents.
- **Assessment:** no failure today, because no current `uninstallOnce` call uninstalls
  Antigravity. The default is defensive symmetry with `installOnce`, and the plan states that
  rationale.
- **Correction:** none required. It is a one-line default, not a new abstraction.

**Scope:** no other findings. The plan is test-only and states its evidence.

- **Files:** it creates one support file, justified because `setupFiles` needs a module path and
  four files exceed 34 s.
- **Tests:** it adds one new case and one extended assertion, both in `test/install.test.ts`.
- **Evidence:** the A/B measurements above back it, and it rejects the disproven `runLoop`
  hypothesis.

## Conclusion

- **cursor — changes required.**
  - C1 changes product hook behavior in a way that can break real products' declared git checks.
  - C2 picks single-fork, which neither removes the measured cause nor stays fast.
  - C3 asserts on the owner's real home.
- **codex — acceptable with corrections.**
  - Its core fixes are right: the `runGit` delegate reset, the fixture home defaults, and the
    setup-file yield.
  - It should drop `fileParallelism: false` (X1) and trim the uninstall extension (X3).
  - It should record a baseline repro for the out-of-scope `agentHookSync` race (X2).
- **claude — acceptable as written.** It is the smallest evidenced change set that covers all
  three reported defects.

I recommend implementing the claude plan, optionally adopting codex's atomic-publication fixture
fix for `test/agentHookSync.test.ts:186` if the race is reproduced on baseline.

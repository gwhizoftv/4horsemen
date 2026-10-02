# Issue 145 implementation comparison

Bound implementation pins (protocol version 1):

- claude `846a8344ffdea493149c68e5e79dcc96c82f453f`
- codex `ae32d27f68b915b2302c50b3d18fd1ec629169cb`
- cursor `a3fbd7ce8cd351d83a7be513c108470f12ce8136`

I compared the three bound worktrees file by file (`diff -u`) on the three product paths each
one changes. Those are `test/install.test.ts`, `test/support/yieldEventLoop.ts` and
`vitest.config.ts`.

## Comparison

All three pins implement the selected claude plan (`4415a10d`), with the same behavior and the
same scope. No pin touches `src/`, `scripts/`, `githooks/` or `package.json`. Each adds exactly
one file, the planned `test/support/yieldEventLoop.ts`, and no dependency.

| Change | claude `846a8344` | codex `ae32d27f` | cursor `a3fbd7ce` |
| --- | --- | --- | --- |
| `installOnce` default `home: join(fixture.workspaceRoot, "home")` before `...overrides` | yes (`:52`) | yes (`:52`) | yes (`:52`) |
| `uninstallOnce` same default | yes (`:261`) | yes (`:261`) | yes (`:261`) |
| `shimEnv()` deletes `COORD_GIT_DELEGATE`; `runGit` env `{ ...shimEnv(), COORD_ISSUE: "42", ...env }` | module scope, rationale on `runGit` | inside `describe`, one-line rationale | inside `describe`, JSDoc rationale |
| New case "refuses even when the suite itself runs under a delegated git" (sets `process.env`, expects 2, restores in `finally`) | yes | yes | yes |
| Antigravity launcher test asserts `<fixture>/home/.gemini/antigravity-cli/settings.json` exists | yes | yes | yes |
| Setup file: global `beforeEach` awaiting one `setImmediate` | global `setImmediate` in a `Promise` | `node:timers/promises` `setImmediate()` | imported `node:timers` `setImmediate` in a `Promise` |
| `vitest.config.ts` `setupFiles: ["./test/support/yieldEventLoop.ts"]` | after `testTimeout` | first key | before `testTimeout` |

Explicit per-call `{ COORD_GIT_DELEGATE: "1" }` overrides still win in all three pins, because
`...env` is spread last. The existing manual-mode and pinned-read cases keep their meaning.

**Behavioral equivalence:**

- The test bodies and assertions are identical apart from local variable names
  (`prior` / `previous`).
- The three `setImmediate` forms all wait for one check-phase macrotask before each test. That
  is the mechanism the plan measured: a 60 s birpc reply starvation, 3 of 3 runs failing on
  baseline and 3 of 3 passing with the yield.
- The other differences are comment wording, the scope of `shimEnv`, and key order in the config
  object. None of them changes runtime behavior.

**Verification on the claude pin, run in this clone:**

- `COORD_GIT_DELEGATE=1 pnpm exec vitest run test/install.test.ts` passes 47/47.
- With an empty scratch `HOME`, the same file passes 47/47 and writes no `.gemini` files.
- The implementation commit went through `.coord/bin/git` with hooks enabled, and the
  pre-commit `check:fast` passed 622/622 with no `onTaskUpdate` error.
- In repeated `test:fast` runs during heavy machine load, I saw no `onTaskUpdate` error, even with
  `install.test.ts` at 134 s.
- Two of five runs had test failures. The two failures I captured were `onboard.test.ts` timeouts
  at the 15 s `testTimeout`; that test already took 14.5 s on baseline. That limit is outside this
  issue and is the same for all three pins.

I could not run the codex and cursor pins independently. The bound worktrees have no
`node_modules`, and a scratch copy can't host the installer fixtures (42 of 47 tests fail on
environment setup, the same for both pins). Because their logic matches the verified claude pin
line for line, that evidence carries over.

### Findings

**F1 — claude `846a8344`, `test/install.test.ts:847`.**

- **Rule:** a JSDoc block must sit directly above the test it documents.
- **Failure:** the new delegated-git case was inserted between the existing JSDoc at `:840-846`
  and its test, "stays out of the way of manual mode and of other repositories", now at `:860`.
  That JSDoc explains why the shim resolves the target repository rather than refusing by
  subcommand. As committed, it reads as the rationale for the delegated-git refusal case, while
  the case it actually explains has lost its comment. A later reader or editor can delete or
  "fix" the wrong test.
- **Smallest fix:** move the new case above the JSDoc. codex (`ae32d27f:816`) places it after
  the launcher-PATH case, and cursor (`a3fbd7ce:856`) places it after the documented case. Both
  avoid the problem.
- This is a documentation-placement defect only. Test behavior is unaffected.

**F2 — codex `ae32d27f`, `test/install.test.ts` `runGit` (~`:785`).**

- **Rule:** a non-obvious environment scrub should say why it exists, in terms a future
  maintainer can act on.
- **Failure:** codex keeps the one-line comment inside `shimEnv` ("A hook-run suite is
  delegated…") but drops the explanation of the mechanism: a commit through `.coord/bin/git`
  exports `COORD_GIT_DELEGATE=1` into the hook's vitest run. Without it, a maintainer simplifying
  `runGit` back to `...process.env` gets no warning beyond the new regression case.
- The regression test does catch that change, so this is minor.
- **No fix needed:** the new regression case is the guard.

**cursor `a3fbd7ce`:** no defects found. The JSDoc keeps its test, the rationale comments are
complete, and the setup file imports `setImmediate` explicitly from `node:timers`, which is
slightly clearer than relying on the global.

### Scope and discipline

- **Scope:** all three stay inside the issue's three defects. None adds the serialization,
  `src/hookPolicy.ts` scrub or `agentHookSync` fixture change that the plan reviews rejected.
- **Reuse:** all three reuse `installOnce`, `uninstallOnce`, `runGit`, `ProductFixture.workspaceRoot`
  and the existing `home` install option.
- **Coverage:** each adds the same one new test and one extended assertion, both in the existing
  `test/install.test.ts`.

### Ranking

**cursor `a3fbd7ce` ≥ codex `ae32d27f` > claude `846a8344`.** All three are functionally
equivalent and acceptable. Cursor's pin is the cleanest: JSDoc placement is correct and the
rationale is complete. Codex's pin is also correct, with slightly thinner comments. My own pin
(claude) carries the misplaced JSDoc from F1.

# Issue 145 — implementation comparison

Compared bound implementation pins:

- claude `846a8344ffdea493149c68e5e79dcc96c82f453f`
- codex `ae32d27f68b915b2302c50b3d18fd1ec629169cb`
- cursor `a3fbd7ce8cd351d83a7be513c108470f12ce8136`

Authority: selected plan claude `4415a10d` (test-only hermetic suite). Protocol
version 1.

## Comparison

All three pins change the same product surfaces — `test/install.test.ts`,
`test/support/yieldEventLoop.ts`, `vitest.config.ts` — and leave `src/`,
`scripts/`, `githooks/`, and `package.json` untouched. None ships the rejected
alternatives (hookPolicy scrub, single-fork / `fileParallelism: false`,
Antigravity no-op under `VITEST`, or the out-of-scope agentHookSync fixture
edit). On the three issue defects they are functionally equivalent.

### Shared correct behavior

1. **Shim leak.** Each adds a `shimEnv()` that copies `process.env` and
   `delete`s `COORD_GIT_DELEGATE`, then builds `runGit` as
   `{ ...shimEnv(), COORD_ISSUE: "42", ...env }`. Explicit
   `{ COORD_GIT_DELEGATE: "1" }` overrides still exercise the bypass. Each adds
   `it("refuses even when the suite itself runs under a delegated git")` that
   sets `process.env.COORD_GIT_DELEGATE = "1"`, asserts `runGit(…, ["status"])`
   exits 2, and restores in `finally`.

2. **Antigravity home.** Each defaults `installOnce` / `uninstallOnce`
   `home` to `join(fixture.workspaceRoot, "home")` before `...overrides`, and
   extends the Antigravity launcher case to assert
   `…/home/.gemini/antigravity-cli/settings.json` exists under the fixture.

3. **Reporting timeout.** Each registers
   `setupFiles: ["./test/support/yieldEventLoop.ts"]` on the fast config only
   and yields one macrotask per test so long synchronous files can drain
   vitest’s worker RPC. `vitest.e2e.config.ts` is unchanged; `testTimeout`
   stays 15_000.

### Differences (non-blocking)

| Topic | claude `846a8344` | codex `ae32d27f` | cursor `a3fbd7ce` |
| --- | --- | --- | --- |
| `shimEnv` scope | module-level helper above the describe | nested in the describe | nested in the describe |
| Yield API | `beforeEach(() => new Promise(… setImmediate …))` (global) | `await setImmediate()` from `node:timers/promises` | `async` + `setImmediate` from `node:timers` |
| New-test placement | after the target-repo JSDoc (see finding) | early in the describe | after “stays out of the way” |
| Comments | strongest why-text on `runGit` | brief | brief |

Any of the three yield forms is a valid macrotask turn; none changes production
policy.

### Findings

1. **claude `846a8344` — `test/install.test.ts` ~840–858.** The JSDoc that
   explains why the shim resolves the target repository (and belongs on
   “stays out of the way of manual mode and of other repositories”) is
   attached to the new “refuses even when the suite itself runs under a
   delegated git” case instead. Rule: documentation for a test must describe
   that test’s behavior. Failure: a later editor reading the comment against
   the delegated-env regression will think the case is about `-C` / other-repo
   resolution, not about ambient `COORD_GIT_DELEGATE`. Smallest correction:
   move the JSDoc back onto the “stays out of the way…” `it` (cursor
   `a3fbd7ce` already has that order). Not a behavioral defect.

No other rule-breaking defects turned up. Coverage is focused (one new shim
case + one extended Antigravity assertion + one shared setup file). Helpers
reused: `installOnce`, `uninstallOnce`, `runGit`, `product()` /
`workspaceRoot`. No unnecessary files or refactors.

### Verdict

Accept any of the three pins; prefer **claude `846a8344`** as the selected-plan
author with the strongest `runGit` commentary, after (or ignoring) the
misplaced JSDoc. **codex `ae32d27f`** and **cursor `a3fbd7ce`** are equally
correct on behavior and slightly cleaner on comment/test ordering. Do not
prefer one for serialization, production env scrubbing, or extra fixture work —
none of those landed.

# Issue 145 implementation comparison

Protocol version: 1. Reviewed the exact exported worktrees bound by action `116a93d0-f97d-4543-9220-e6df148df132`:

- Claude: `846a8344ffdea493149c68e5e79dcc96c82f453f`.
- Codex: `ae32d27f68b915b2302c50b3d18fd1ec629169cb`.
- Cursor: `a3fbd7ce8cd351d83a7be513c108470f12ce8136`.

## Comparison

**No blocking correctness findings in any of the three implementations.** All implement the selected test-only plan, and the differences are helper placement, comments, test ordering, configuration property ordering, and equivalent timer APIs. The earlier objections to production environment scrubbing and permanent serialization do not apply to these implementation pins.

### Common behavior and coverage

- **Fixture home isolation:** `test/install.test.ts:52` and `:261` in all three pins default installation and uninstallation to `join(fixture.workspaceRoot, "home")`, before explicit overrides. This uses the existing injection point and fixture cleanup, preserves intentional custom homes, and confines the two reported Antigravity installers to their fixture roots. Each extends the existing launcher test with an assertion that the settings file exists there: Claude line 952, Codex line 948, Cursor lines 948–950. No test attempts to inspect or clean the owner's real Antigravity settings.
- **Shim environment isolation:** Claude `test/install.test.ts:767–788`, Codex `:768–785`, and Cursor `:769–785` copy the parent environment, remove only inherited `COORD_GIT_DELEGATE`, then apply deliberate per-call overrides. This preserves the explicit delegation tests while making ordinary policy tests independent of whether the suite was launched by a Git hook. Each adds the same focused regression and restores the prior environment in `finally`: Claude lines 847–857, Codex lines 816–826, Cursor lines 856–866. Production shim and verification behavior remain unchanged.
- **Reporting progress:** each `vitest.config.ts` registers exactly one new shared setup module. Each module returns/awaits a real `setImmediate` turn from a global `beforeEach`, allowing reporting replies to be processed between synchronous cases. Test discovery, e2e exclusion, parallelism, and the 15-second per-test deadline remain unchanged; none catches or suppresses runner errors.

### Differences and relative merits

| Pin | Implementation details | Assessment |
| --- | --- | --- |
| Claude `846a8344ffdea493149c68e5e79dcc96c82f453f` | File-local `shimEnv`; setup returns a manually constructed promise around global `setImmediate`; more detailed explanation of the reporting mechanism. | Correct and close to the selected plan's literal example. The existing suite does not install fake timers, so using the global timer is not a current defect. |
| Codex `ae32d27f68b915b2302c50b3d18fd1ec629169cb` | `shimEnv` stays inside its consuming describe block; setup awaits Node's existing `node:timers/promises` API. | Correct, compact, and avoids a hand-written promise wrapper. Its implementation received direct local verification, including normal commit and push hooks. |
| Cursor `a3fbd7ce8cd351d83a7be513c108470f12ce8136` | Same describe-local helper; setup imports `setImmediate` from `node:timers` and wraps it in a promise. | Correct. The explicit timer import is clear; the additional wrapper is a stylistic difference, not a reason to request revision. |

### Scope, reuse, and validation limits

All three change the same three product-tree paths supplied in the action: `test/install.test.ts`, `test/support/yieldEventLoop.ts`, and `vitest.config.ts`. They reuse `installOnce`, `uninstallOnce`, `runGit`, `ProductFixture.workspaceRoot`, the existing installer options, and existing tests. The one new setup file is justified by the same reporting-progress requirement across multiple synchronous suites. Each adds one test and one existing-test assertion; none introduces dependencies, production abstractions, hook changes, timeout changes, version changes, or the separate status-line fixture repair.

I inspected the complete differences between these three exported versions of the changed product files. I did not rerun the peer worktrees' suites, so their runtime results are not inferred from Codex's results. For Codex, the new shim test failed before the fix, all 47 installer cases subsequently passed under `COORD_GIT_DELEGATE=1`, and the normal product-commit hook passed lint/typecheck plus 622 fast tests; the normal push hook passed both e2e tests. Earlier full-run attempts encountered the independently identified onboarding 15-second contention timeout, not the reporting timeout. Those failed attempts must not be represented as three consecutive successful full-suite runs. The owner explicitly requested publication after that limitation was disclosed; all publication hooks subsequently passed without overrides.

Comparison-action verification: a fresh `pnpm check:fast` in this clone exited 0, with lint/typecheck and all 622 tests passing (56.36 seconds for the fast test run).

### Recommendation

All three pins are acceptable on code review. **Prefer Codex `ae32d27f68b915b2302c50b3d18fd1ec629169cb` as a narrow tie-break**, for its concise use of Node's native promise timer and directly observed passing publication hooks, not because the other implementations have a correctness defect. No implementation requires code changes to resolve an issue-145 review finding. Keep any onboarding-timeout hardening separate, as directed by the owner; final coordinator verification still applies to the selected pin.

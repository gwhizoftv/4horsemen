# Issue 145: make verification independent of the launching agent environment

Protocol version: 1. Baseline: `845d28d091c530926fa4ab59d615654b56ac2977`.
Scope comes from the coordinator's `github-issue.json`: inherited Git delegation breaks shim assertions, verification can finish its assertions but fail reporting, and installer tests touch the owner's Antigravity settings.

## Exact File List to be changed or deleted

- `test/install.test.ts`: give `installOnce` and `uninstallOnce` the same fixture-local `home`, before their explicit overrides; give the two direct `install` calls fixture-local homes too. Keep the launcher tests' deliberate home overrides. In `runGit`, set `COORD_GIT_DELEGATE` to an empty value after spreading the parent environment and before spreading explicit per-call overrides. Thus shim-policy tests start as fresh agent calls even when verification itself runs inside a delegated Git hook; the existing explicit delegation assertions still exercise the bypass. Extend the existing installer and shim cases with the regressions below.
- `vitest.config.ts`: explicitly use the forks pool with `fileParallelism: false`, preserving isolation, discovery, exclusions and the existing test timeout. Register the small test setup file below. These become checked-in defaults for the existing `test:fast`/`check:fast` commands, not optional owner shell variables.
- `test/agentHookSync.test.ts`: fix the observed receiver-fixture publication race without changing production status-line behavior. Have the fake receiver publish completed bytes atomically (write a sibling temporary file, then rename), retain the exact byte assertion, and ensure bounded receiver settlement runs in `finally` before fixture removal. This makes existence a completion signal instead of observing the interval between file creation and write completion.

No deletions, product-hook edits, production shim policy changes, dependency changes, package version changes, or unrelated cleanup.

## Exact file list to be created

- `test/support/vitestSetup.ts`: a minimal shared Vitest `afterEach` hook awaiting a real `setImmediate` from `node:timers`. Its sole purpose is to give worker IPC/report acknowledgements an event-loop turn between synchronous, subprocess-heavy test cases. It is registered only in the fast suite; the separate asynchronous e2e suite is unchanged. Do not reset the worker environment globally or swallow runner errors.
- `.plans/issue-145/plan.md`: this required planning artifact; not an additional implementation module.

## Reuse and Scope

Reuse `makeProduct`, `ProductFixture.workspaceRoot`, its existing recursive cleanup, `installOnce`, `uninstallOnce`, `runGit`, the generated-shim describe block, and the existing `home` injection supported by `install`/`uninstall`. No new fixture abstraction or dependency is needed: `join(fixture.workspaceRoot, "home")` supplies a deterministic home owned and removed by each fixture. Extend the existing all-agent installer test to verify the Antigravity settings location and cleanup, rather than adding another expensive installation.

Reuse `teeFixture`, `received`, `settled`, `claudeStatusLinePaths`, and the existing original-bytes assertion for the status-line regression. Keep production `scripts/lib/launcher.sh` unchanged: it intentionally exports `COORD_GIT_DELEGATE=1` so hook subprocesses can perform the reads needed to enforce verification. Fix the isolated test invocation boundary rather than stripping that guard from the real hook process.

The one new support file is justified by a cross-suite need: several existing suites run repeated synchronous Git/build subprocesses, so copying IPC-yield hooks into each suite would be broader and easier to miss. It adds no test-only production branches. Runner serialization reduces aggregate subprocess contention and concurrent `ensureBuilt` work; the real event-loop yield separately addresses reporting starvation that serialization alone does not address.

## Tests

1. In `test/install.test.ts`, extend the shim coverage with one case that sets an inherited `COORD_GIT_DELEGATE=1` using Vitest's scoped environment stubbing and restores it in `finally`. A normal `runGit` must still refuse `status` and an exported pinned read with status 2, while an explicit per-call `{ COORD_GIT_DELEGATE: "1" }` must succeed. Preserve the existing manual-mode and other-repository assertions. The inherited-environment case fails before the helper fix.
2. Extend the existing all-agent installer case to assert that managed Antigravity settings are created under the fixture home, then use `uninstallOnce` to verify removal there and preservation of an owner-authored setting. Use a fixture-local ambient-home sentinel, not the real home, to assert that explicit fixture injection leaves the unrelated ambient settings unchanged. The fixture settings assertion fails before the home fix; no regression test may deliberately write to the owner's real home.
3. Retain and run the existing status-line original-bytes test repeatedly. During planning, `pnpm check:fast` twice returned 620 passing tests and one failure at `test/agentHookSync.test.ts:217`: the receiver file existed but was empty. Atomic fixture publication and settlement must retain the payload/owner exit-code checks, not relax them.
4. Validate runner behavior by running complete commands and checking their process exit status, not just the reported passing-test count. Keep reporting errors fatal. Reproduce the reported reporting-timeout symptom if possible and record whether it reproduces; the planning runs did not reproduce that specific timeout. The pool limit and event-loop yield are a targeted mitigation to be verified, not a claim of an already proven root cause.

Implementation validation commands:

```sh
pnpm exec vitest run --config vitest.config.ts test/install.test.ts test/agentHookSync.test.ts
COORD_GIT_DELEGATE=1 pnpm exec vitest run --config vitest.config.ts test/install.test.ts
pnpm check:fast
COORD_GIT_DELEGATE=1 pnpm check:fast
pnpm check
```

Repeat plain `pnpm check:fast` at least twice after the change, including a run from the normal shim-launched hook path when committing implementation. Run `pnpm check:fast` before every commit as required. During pre-fix reproduction use a scratch HOME under `.codex/tmp/` to protect real settings; post-fix validation must also work without an externally supplied isolated HOME. Do not invoke real Git directly to evade the shim, disable hooks, add success-on-error wrappers, or use environment-only worker-count workarounds. Full `pnpm check` remains the coordinator acceptance suite.

## Alternatives Rejected

- Removing or unsetting delegation in real hooks: breaks the intentional ability of verification subprocesses to read the current clone. Only fresh test invocations should reset their inherited guard.
- Running `/usr/bin/git commit`, skipping hooks, ignoring Vitest's exit status, or interpreting a passing assertion count as success: none fixes verification and each can conceal a genuine failure.
- Merely increasing assertion/teardown timeouts: those are not the worker-report RPC mechanism and do not address environment leakage or synchronous starvation.
- Serial environment variables only: keep verification dependent on owner intervention. Check in the execution policy; do not assume serialization alone drains IPC.
- Global HOME mutation for every test, disabling Antigravity installation, or making production install silently skip home writes under Vitest: broader than explicit existing installer injection and would obscure the behavior being tested.
- Splitting suites, replacing all synchronous subprocess helpers, upgrading Vitest, or adding a new runner: excessive scope without evidence that the focused runner/fixture changes are insufficient.

## Risks and Mitigations

- Serial fast-suite execution will be slower. Preserve every test and all failure detection; measure elapsed time and exit status rather than trading coverage for speed. Keep the ordinary assertion timeout unchanged unless a separately demonstrated case requires a reviewed change.
- A reporting timeout might have another cause. Capture its exact diagnostic and process behavior if it persists. Do not declare success or broaden timeout settings just because assertions pass; revise the plan if evidence calls for a different fix.
- A broad delegate reset could disable real hook verification reads. Reset only `runGit`'s child environment and leave explicit delegate tests and production guard semantics intact.
- Installer overrides or uninstall could accidentally use a different home. Place helper defaults before overrides, exercise matching install/uninstall with the same fixture path, and keep cleanup within the fixture tree.
- Receiver assertions can fail before background work settles. Use `finally` with a bounded settlement check; atomic publication must occur only after the fixture receiver has read and written the full payload, preserving a meaningful byte-for-byte test.

## Conclusion

Implement the smallest test/runner repair covering all reported symptoms: isolate installer homes and fresh shim invocations, make fast-suite scheduling predictable and allow reporting progress, and remove the concretely observed receiver-fixture race. Preserve production coordination policy, every normal hook, and full-suite failure semantics. Acceptance requires clean exit statuses from the commands above, not merely green assertion counts.

# Issue 234: select Node for the coordinator without changing the product runtime

The frozen issue reports `coord onboard` failing in a Node 16 workspace before command handling begins. The root wrapper currently runs both its rebuild and its CLI with ambient tools. The driver declares Node >=26.0.0. The fix must select a compatible, already installed Node before loading driver JavaScript, preserve the caller's working directory and arguments, and leave the environment used by product commands intact.

## Exact File List to be changed or deleted

No deletions. Change these existing files only:

| File | Necessary change |
| --- | --- |
| `coord` (scope token `coord/`) | Resolve a supported Node before rebuilding or starting the CLI; use it for the rebuild only within that build subprocess, then exec the CLI with the original PATH. Preserve existing symlink resolution, caller cwd, arguments, stderr routing and exit behavior. |
| `scripts/bootstrap.sh` | Use the shared selector from the cloned/updated install before dependency installation or build. Run those coordinator-only pnpm commands with the selected Node directory first on their subprocess PATH. |
| `scripts/setup_common.sh` | Run the inline program in common_configure_trust with the shared selector, because it imports the driver's compiled agentTrust module. Leave product and harness Node selection alone. |
| `githooks/lib/policy.sh` | Replace ambient Node dispatch for hook-verify and hook-scope with the shared selector located relative to the recorded CLI entry's install root. Preserve missing-entry checks, stdin, failure propagation and every verification gate. |
| `src/hookSync.ts` | Include the runtime selector in canonicalSourceDigest: the hook bridge will depend on its bytes. The selector remains beside the installed CLI for both shim and vendor modes; no extra vendored hook copy or manifest key is needed. |
| `src/install.ts` | Give bootstrapCoordination's driver dependency/build subprocesses a PATH starting with the running coordinator Node's directory. Do not change process.env or the environment for product operations. |
| `src/githubAuth.ts` | Render coordinator credential helpers with the shell-quoted absolute process.execPath instead of ambient env node. This covers helpers invoked during onboarding itself and helpers saved in agent clones. Preserve the ownership marker and credential protocol. |
| `src/agentHookSync.ts` | Use the same running Node executable in generated lifecycle, shell-guard and Antigravity telemetry commands. Preserve markers, JSON/stdin handling, the guard fast path, existing timeout behavior and downstream commands. |
| `src/claudeStatusLine.ts` | Pin only the coordinator telemetry receiver to the running Node executable; keep the owner's status-line command and its environment unchanged. |
| `test/wrapper.test.ts` | Extend writeFixture and wrapper regressions to cover runtime selection, early rejection, rebuild selection, and preservation of cwd, arguments, streams and product PATH. |
| `test/bootstrap.test.ts` | Extend the existing isolated bootstrap fixture with the selector and version-aware fake tools; verify old ambient Node does not run the coordinator install/build. |
| `test/install.test.ts` | Update credential-command expectations and extend existing bootstrap/trust integration coverage for an old ambient Node. |
| `test/githubAuth.test.ts` | Update helper argv expectations and execute a rendered helper with an incompatible ambient node to prove the pinned executable is used. |
| `test/agentHookSync.test.ts` | Extend existing executable hook/status-line fixtures to verify coordinator receivers use their pinned Node while downstream commands retain the product environment. |
| `test/hookSync.test.ts` | Extend installed-hook tests for separate coordinator/product runtimes in both shim and vendor modes, plus digest coverage of the selector. |
| `docs/setup-workspace.md` | Document runtime selection, the explicit override, failure remediation, build isolation and regeneration of generated commands after removing a pinned Node installation. |

The literal root file is coord. The additional scope token `coord/` is needed because the current file-map extractor ignores extensionless root tokens; its existing tree-root matcher removes the trailing slash and matches that file. Coord is a regular file, so this token approves no additional existing paths. Do not change the evidence parser as part of this issue.

## Exact file list to be created

- `scripts/lib/node-runtime.sh`: one executable POSIX-shell selector/runner, shared by the root wrapper, bootstrap and shell bridges. It must operate before any driver JavaScript can load. It supports a path-only resolution mode for builds and a normal mode that execs the selected Node with all supplied arguments and inherited stdin. This is the only new product file; the current plan is the required coordination artifact.

No new dependencies, configuration schema, persistent runtime cache or test files are needed.

## Reuse and Scope

Reuse the root wrapper's BASH_SOURCE/readlink loop and stale-build test rather than replacing the entry point. Reuse bootstrap's checkout, ownership and managed-link behavior. Reuse common_configure_trust, bootstrapCoordination, coord_cli_entry, coord_verify and coord_scope at their existing dispatch boundaries. Existing generated-command builders already have shellQuote/singleQuote helpers, ownership markers and reconciliation logic; use those to quote process.execPath and refresh managed commands without changing their protocols. Reuse canonicalSourceDigest to cover the selector's effect on hook behavior.

Reuse writeFixture in `test/wrapper.test.ts`, fixture/bootstrap in `test/bootstrap.test.ts`, installOnce and the trust test in `test/install.test.ts`, fakeRunner and existing credential assertions in `test/githubAuth.test.ts`, executable receiver fixtures in `test/agentHookSync.test.ts`, and installed-hook fixtures in `test/hookSync.test.ts`. Continue using makeProduct, ensureBuilt, git and tryGit from `test/support/workspaceFixture.ts` without modifying that shared file. ProductFixture and EffectOptions remain unchanged. Read the existing engines.node declaration in `package.json` and the driver `.nvmrc` as requirements; neither needs a version change.

Implementation behavior:

1. The shell selector accepts stable Node versions satisfying the current >=26.0.0 floor. Probe the executable itself with --version; do not trust a directory name. Keep a small shell-side minimum because this check must work with no usable Node; test its agreement with the existing package engine requirement. Reject failing, malformed and prerelease probe results.
2. An explicit COORD_NODE takes precedence and must be an absolute path to an executable named node. If set but invalid or too old, fail with a specific diagnostic rather than silently ignoring it. Otherwise try node executables in PATH order, skipping incompatible candidates, then installed versions under NVM_DIR/versions/node or the default HOME/.nvm/versions/node. Among compatible nvm candidates choose the highest numeric version, using portable shell comparisons rather than GNU-only version sorting. Do not source nvm, run nvm use, download Node, or change version-manager aliases. Other installation managers can supply a compatible executable through PATH or COORD_NODE.
3. Normalize selected paths to absolute paths without changing the caller's cwd. Quote paths, preserve PATH entries containing spaces and handle empty/relative PATH components deliberately. Successful selection is silent except for the requested path-only result. If no compatible runtime exists, fail before pnpm or CLI execution with the required version, the detected ambient version when available, and an actionable COORD_NODE/install instruction on stderr; stdout stays empty.
4. The root wrapper selects once, runs its existing stale/missing build with the selected Node directory prepended only to the build subprocess PATH, then execs that absolute Node with the original PATH. Bootstrap applies the same scoped environment to its install/build commands after obtaining the checkout. Its standalone curl-to-sh entry remains usable: it must not require a sibling helper before cloning. Keep pnpm 11 as an explicit prerequisite. bootstrapCoordination uses process.execPath for its own scoped build environment.
5. Shell hook/trust bridges use the selector without changing the environment inherited by their JavaScript children. Resolve the helper from the existing installed CLI/root contract, including vendor-hook mode where coord.installRoot is absent but coord.cliEntry still names the installed CLI. A missing selector fails with a repair diagnostic; do not fall back to unchecked ambient Node. Hash the selector alongside existing hook dependencies.
6. Generated JavaScript callback commands capture the already selected process.execPath. This is sufficient to keep credential helpers, lifecycle events, shell guards and status-line receivers working after an agent launcher selects the product's older Node. Reuse current sync/inspection behavior to update these commands on onboarding/reinstallation. Do not alter authentication policy, guard policy, product verification argv, the owner's downstream commands, or launcher_environment's product .nvmrc handling.

The new shell file is justified by the same pre-JavaScript requirement at multiple real entry points. A generic version-manager framework, an auto-installer and a new TypeScript runtime abstraction would add machinery without helping this issue.

## Tests

Add or extend the following focused regressions in the existing files above; use isolated fake homes, PATHs and version-aware executable stubs so results do not depend on the developer's installed managers. Clear inherited COORD_NODE/NVM_DIR in fixture environments unless the case deliberately supplies them.

1. Wrapper selection: parameterize a compatible ambient runtime, an old Node 16 first on PATH with a compatible later candidate, nvm fallback, and an explicit compatible override. Verify the selected executable reaches the CLI. Parameterize missing/old/malformed candidates and invalid overrides to verify a useful stderr failure before any build or CLI marker, with empty stdout. Include a future stable major satisfying >=26 and an engines-floor consistency assertion.
2. Wrapper isolation: extend the symlink/caller-cwd test with paths containing spaces, spaced arguments, a product .nvmrc and a missing or stale build. The build must observe selected Node; a child command launched by the CLI must still observe the product's Node 16 and original PATH. Verify original arguments/stdin, CLI exit status, build-failure propagation and the existing no-build-banner-on-stdout rule. A fresh build must not invoke pnpm.
3. Bootstrap/install: existing bootstrap tests must show pnpm install and pnpm build using selected Node, reject an unsupported runtime before either pnpm command, and retain clean rerun/ownership/link behavior. Extend the install test's coordinator bootstrap and common_configure_trust coverage under an old ambient Node. Verify no process-wide environment change escapes these driver-build invocations.
4. Generated callbacks: execute the actual rendered credential helper and representative lifecycle/guard/status-line receivers with an ambient node stub that would fail on coordinator JavaScript. Assert payload/output/exit semantics still hold and a downstream user command still resolves the ambient product node. Extend existing parameterized vendor coverage rather than creating a second fixture framework.
5. Installed hooks: parameterize shim/vendor fixtures with a supported coordinator override and an old product node. A declared product command must observe the old product node, run, and still block the commit when it fails; a passing declaration must succeed. With no compatible coordinator Node, the hook must fail closed before checks. Verify changing selector bytes changes canonicalSourceDigest.

Focused development commands, using the checked-in Vitest configurations:

```sh
pnpm exec vitest run --config vitest.system.config.ts test/wrapper.test.ts test/bootstrap.test.ts
pnpm exec vitest run --config vitest.system.config.ts test/install.test.ts test/agentHookSync.test.ts test/hookSync.test.ts
pnpm exec vitest run --config vitest.config.ts test/githubAuth.test.ts
bash -n coord scripts/setup_common.sh githooks/lib/policy.sh
sh -n scripts/bootstrap.sh scripts/lib/node-runtime.sh
```

The product precommit hook owns pnpm check:fast, which the current package script expands to lint, typecheck, fast tests and system tests. The workflow-critical push hook owns pnpm test:e2e. Do not duplicate these suites immediately before committing. The frozen issue start configuration assigns the final pnpm run check to the coordinator; that script includes build, check:fast and e2e. Cite only observed results and distinguish coordinator-owned checks from local checks. This plan-only action requires heading/file-map/evidence validation and hook acceptance, not product tests.

## Alternatives Rejected

- Merely print a version error, lower the engine requirement, or ask the owner to switch the workspace Node: these do not use an available compatible runtime independently of the product.
- Globally prepend the coordinator Node to PATH or run nvm use for the whole CLI: product verification commands and agent processes inherit that environment and would run the wrong development runtime.
- Guard only after importing main/cli: the reported failure happens during module loading, before such a guard can execute.
- Fix only the root wrapper: onboarding's Git credential helper and installed coordinator callbacks still launch ambient Node and can reproduce the failure after the wrapper succeeds.
- Automatically install Node or persist a second runtime registry: discovery plus an explicit override solves the issue without downloads, machine-wide changes or cache migration.
- Change hook gates to permit failures: the hook change is strictly a runtime-dispatch repair; every existing verification requirement remains enforced.

## Risks and Mitigations

- Shell portability and quoting: use POSIX constructs in the shared selector/bootstrap, preserve Bash 3.2 compatibility in existing Bash entry points, and cover spaces, numeric version comparisons and symlink invocation with executable fixtures.
- Runtime leakage: inspect both the coordinator's executable and a product child process's PATH/Node; checking only the parent's terminal after exit would miss inherited-environment regressions.
- Removed pinned installations: generated commands use an absolute binary and may need regeneration after that installation is deleted. Document rerunning onboarding/install with a supported runtime; existing managed-command inspection/reconciliation must recognize the changed command without taking ownership of user commands.
- Hook coverage drift: include the selector in the canonical digest, exercise shim and vendor modes, and retain fail-closed behavior for missing runtime/helper and failed product checks. Editing this product hook bridge is necessary to fix its Node dispatch, not a means of bypassing this repository's checks.
- Host-dependent tests: isolate homes, overrides and candidate paths; use stubs that implement the probe and record execution. Preserve existing bootstrap and callback tests rather than weakening their expectations to accommodate the change.
- Scope enforcement for the extensionless entry point: validate the extracted coord/ token against the current matcher before publication. No evidence-parser or plan-schema changes are included.

## Conclusion

Select a compatible installed Node before driver code loads, apply it only to coordinator execution and coordinator builds, and preserve the product's runtime environment. Reuse existing entry points, command renderers and tests, with one shared shell selector and no new dependencies. Publish only this plan for the current action; product work begins after plan selection.

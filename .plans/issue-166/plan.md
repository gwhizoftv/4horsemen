# Issue 166: Python and Flutter onboarding defaults

Protocol version: 1. Action: c91a9ea2-c6c6-4844-8108-34647d202f89.
Baseline: b824e845b83925c7adeaf471b4966e24d2f00b8a.

Plain onboarding should recognize Python and Flutter projects, record useful verification commands, and explain the policy it installed. An explicit declaration remains an override for projects with different test runners or combined toolchains. This action publishes the plan only.

## Exact File List to be changed or deleted

| Existing file | Planned change |
| --- | --- |
| `src/setupWorkspace.ts` | Extend installer policy inference with Python and Flutter detection, verification defaults, and critical paths. Keep inference in the existing proposal pipeline. |
| `src/install.ts` | Report the effective verification policy and which fields came from a declaration after configuration validation and before clone wiring. Both install and onboard use this path. |
| `package.json` | Move the existing js-yaml dependency from development to runtime dependencies, keeping its current version range. No package version bump. |
| `pnpm-lock.yaml` | Regenerate the importer classification for that dependency move without unrelated dependency upgrades. |
| `test/verify-config.test.ts` | Extend the existing installer-proposal tests for the two ecosystems, detector boundaries, precedence, and declaration overrides. |
| `test/onboard.test.ts` | Add parameterized Python/Flutter onboarding regressions with controlled executable fixtures; verify persisted policy, policy announcements, overrides, and dry-run behavior. |
| `README.md` | Update supported languages and product-tool prerequisites to describe automatic Python and Flutter proposals. |
| `docs/setup-workspace.md` | Replace the Python declaration-only description with detection rules, exact defaults, onboarding effects, prerequisites, and optional override examples. |

No existing files will be deleted.

## Exact file list to be created

No product source files, test files, fixture files, or configuration formats will be created. The only new repository artifact for this planning action is `.plans/issue-166/plan.md`. Test manifests and executable stubs will be generated inside the existing disposable fixtures.

## Reuse and Scope

Reuse `proposeToolchainPolicy`, `proposeProjectPolicy`, `ProjectPolicyProposal`, `proposedVerify`, `nodeScripts`, and `makeTargets` in `src/setupWorkspace.ts`. Detection must remain an installation-time operation. The existing `buildWorkspaceConfig` and `workspaceDeclarationSchema` already apply field-level declaration precedence and validate nonempty final checks; preserve that behavior. Existing `CheckCommand` argument vectors, `runVerifyPhase`, `unresolvableCommands`, and `doctor` already support non-Node executables. No hook, runner, state-schema, CLI-option, or protocol changes are needed.

Use this explicit detector order: Cargo, Go, Flutter, Node, Python, Make. Cargo and Go retain their current priority. A confirmed Flutter SDK dependency precedes an incidental Node tooling manifest. Node retains priority over Python markers because a pyproject can configure auxiliary Python tooling in a Node repository. Python and Flutter precede the Make fallback so their language defaults are available even when a Makefile contains only auxiliary targets. Mixed projects can use existing declarations to select or combine checks; the documentation must state this precedence.

Python detection recognizes a root `pyproject.toml`, `setup.py`, `setup.cfg`, or `requirements.txt` file. Do not execute packaging files, scan virtual environments, or infer Python merely from arbitrary source filenames. Set `toolchain` to `python` and propose:

| Phase | Commands |
| --- | --- |
| Precommit | one check named `test`, argv `["pytest", "-q"]` |
| Prepush | an empty list; the suite already runs at commit and finalization |
| Finalization | one check named `test`, argv `["pytest", "-q"]` |

Use pytest as the announced default rather than requiring an unrelated formatter or linter. Its normal command entry point uses the environment exposed on PATH and lets existing doctor checks identify a missing pytest executable. Projects using uv, Poetry, Hatch, or a virtual environment can expose their prepared environment normally; this change does not select environment managers or install packages. Projects requiring a wrapper or a different runner can override the commands. Preserve a real nonempty default verification phase and final gate; never replace failing or absent tests with success. Add `src/`, `tests/`, and `test/` as Python critical prefixes, and `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt`, `pytest.ini`, `tox.ini`, `uv.lock`, `poetry.lock`, `Pipfile`, and `Pipfile.lock` as critical files. These paths protect classification; unknown product paths continue to receive product checks.

Flutter detection parses a root `pubspec.yaml` using the already installed js-yaml `load` function. Treat the parsed result as unknown and narrow mappings before accessing fields. Recognize `dependencies.flutter.sdk === "flutter"`, or a development dependency named `flutter` or `flutter_test` with `sdk === "flutter"`. Quoting, comments, block mappings, and inline mappings must work. A plain Dart pubspec, a comment mentioning Flutter, or unrelated text containing the word must not identify Flutter. An unreadable, malformed, or incorrectly shaped manifest contributes no Flutter proposal; normal fallback and explicit declarations still work, and an otherwise unrecognized project retains the current missing-checks error. Do not execute YAML tags or manifest-supplied commands. Set `toolchain` to `flutter` and propose:

| Phase | Commands |
| --- | --- |
| Precommit | `analyze`: `["flutter", "analyze"]` |
| Prepush | `test`: `["flutter", "test"]` |
| Finalization | `analyze`, then `test`, with the same argument vectors |

Use critical prefixes `lib/`, `test/`, `integration_test/`, `android/`, `ios/`, `web/`, `macos/`, `windows/`, and `linux/`; critical files are `pubspec.yaml`, `pubspec.lock`, and `analysis_options.yaml`. Do not default to a platform build, emulator, or device test: those require product-specific targets. The defaults match the standard [Flutter CLI](https://docs.flutter.dev/reference/flutter-cli); the SDK marker comes from the [Flutter pubspec specification](https://docs.flutter.dev/tools/pubspec). Python uses the normal [pytest invocation](https://docs.pytest.org/en/stable/how-to/usage.html).

Promoting js-yaml to a runtime dependency is necessary because installed production code will import it. Reuse the current package and `@types/js-yaml`; add no new dependency or parser framework. A small private manifest predicate inside the existing proposal module is sufficient. Keep the current tracked-prose documentation proposal and declaration merge intact.

In `install`, reuse the existing `options.log`/`EffectOptions` channel and the validated `config` returned by `buildWorkspaceConfig`. Print a compact effective-policy summary for installation and reinstallation: selected toolchain; local precommit and prepush command names and argument arrays, including explicit empty lists; finalization commands; critical paths; and any documentation-only exemption. Label each policy group inferred or declared based on the corresponding declaration field. Print the resulting values, not the unmerged proposal. If coordinator verification is declared, label local hook commands as local and distinguish its configured coordinated-hook/candidate commands so the summary does not promise local suites on every coordinated commit. This is reporting existing configuration, not a new verification mode.

For the new defaults, explain the effects in ordinary language: Python runs pytest at commit and finalization; Flutter analyzes at commit and tests at push, then runs both at finalization. State that the required tools and product dependencies must be available to agents and coordinator verification worktrees. Onboarding records commands and checks executable availability; it does not run the product suite or install its environment. A dry run labels the same summary as proposed and writes nothing. Explicit declarations, including an explicit local-check opt-out, must be represented accurately without claiming inferred commands will run. Summaries are output only and must not add entries to the mutation list or break install idempotence.

Reuse the `installer proposals` describe block, temporary-directory cleanup, `config`, `buildWorkspaceConfig`, and fixture helpers in `test/verify-config.test.ts`. For end-to-end onboarding, reuse `makeProduct("plain")`, `ensureBuilt`, `git`, existing cleanup, `readConfig`, and output capture. Add manifests to plain fixtures instead of broadening the shared `ProductKind` abstraction. Executable stubs belong inside each disposable fixture and restored PATH changes must not affect other tests. No real Python packages or Flutter SDK are required for these coordinator tests.

## Tests

Add the following focused regressions to existing files. Positive Python/Flutter inference and onboarding cases must fail on the baseline because it produces no finalization checks for these manifests; the output assertions must fail because no effective-policy announcement exists yet.

1. In `test/verify-config.test.ts`, use a table for the four Python markers and representative Flutter manifests. Assert exact toolchain and phase command arrays plus critical paths. Include block and inline/quoted Flutter forms. Include plain Dart, comment-only, malformed, and wrong-shaped pubspec cases in the same detector table to prevent false positives. Preserve existing unknown-project, Cargo, Go, and Node assertions.
2. In `test/verify-config.test.ts`, add a compact mixed-marker case that locks the stated priority: Cargo/Go retain priority, Flutter wins over incidental Node, Node wins over Python, and Python wins over auxiliary Make targets. Apply a declaration over a new proposal and assert that declared verify/checks/toolchain/critical paths survive unchanged, including explicitly empty local phases while final checks remain nonempty.
3. In `test/onboard.test.ts`, parameterize a plain Python and a Flutter product without a declaration. Commit and push the fixture manifests before onboarding so the clones have the same tree. Put executable pytest/flutter stubs on a fixture PATH; each stub must leave a marker if invoked. Assert onboarding succeeds, the recorded config contains the expected commands, the summary matches it, the owner locator is registered, the product tracked tree is unchanged, and no tool-invocation marker exists. Missing-executable behavior continues through existing doctor checks; add a controlled unavailable-tool variant and assert a toolchain finding rather than the old inference error.
4. In `test/onboard.test.ts`, reuse one new fixture for re-onboarding with a custom declaration. Assert both saved policy and displayed commands reflect the override, not the inferred defaults. Exercise `install` dry-run on a fresh equivalent fixture and assert a proposed-policy summary with no config or clone creation. Reuse existing idempotence/owner-tree tests rather than duplicating them.

Run focused commands during implementation:

```sh
pnpm exec vitest run --config vitest.config.ts test/verify-config.test.ts
pnpm exec vitest run --config vitest.system.config.ts test/onboard.test.ts test/install.test.ts
```

The second command also runs the existing installer regressions because reporting and a runtime import touch that shared path; no new cases are needed in its file. The fixture's existing build freshness helper compiles the CLI where necessary.

The inspected package scripts define `pnpm check:fast` as lint, typecheck, fast tests, and system tests. The product precommit hook owns that mandatory check; do not manually duplicate it immediately before a commit. The current prepush policy owns `pnpm run test:e2e`. Full final acceptance is the coordinator's `pnpm run check`, which adds build and e2e. If a later action switches to coordinator verification mode, cite its recorded suites and run only focused investigations rather than duplicating coordinator-owned checks.

For this evidence-only plan action, validate all seven required sections have nonempty bodies, verify that the coordinator's approved-path extractor yields exactly the eight existing files above, and check the action ID/digest before publication. Do not run or claim implementation tests for this plan.

## Alternatives Rejected

- Keeping mandatory declarations for Python/Flutter leaves the reported plain-onboard failure unresolved. Declarations should customize the defaults.
- Treating every Dart manifest as Flutter or searching raw text for the word Flutter misclassifies ordinary Dart projects and comments. Reusing the existing YAML parser avoids a fragile partial grammar.
- Guessing linters, activating owner-local environments, installing dependencies during onboarding, or selecting every Python environment manager adds assumptions beyond the reported gap. A visible pytest default is smaller and can be overridden with existing policy fields.
- Defaulting to unittest discovery can report success while missing pytest-style tests. Suppressing missing tests or emitting empty verification/finalization gates weakens the existing checks.
- Adding ecosystem branches to hooks, a new policy schema, a plugin registry, or a separate detector module duplicates infrastructure already present in the proposal builder.

## Risks and Mitigations

- A Python project may use another test runner or lack pytest, and a Flutter project may need custom test setup. Announce the assumptions and exact commands; retain actionable doctor failures and explicit overrides. Missing tests remain a verification failure, never a fabricated pass.
- An executable being on PATH does not prove dependencies are ready. Document ordinary environment preparation for agents and fresh verification worktrees; do not claim onboarding executed or validated the product suite.
- Mixed-language markers can select an unintended policy. Make precedence deterministic, cover the overlaps, display the resulting policy, and retain declaration precedence. Standalone Dart support and monorepo orchestration are outside this issue.
- A YAML runtime import can break production-only installs if the dependency stays development-only. Move the existing dependency and update its lockfile importer together; existing build/typecheck coverage checks the import.
- Reporting inferred values after a declaration would mislead the owner. Generate summaries from the validated effective config, distinguish provenance and verification phases, and test a re-onboard override. Preserve no-write dry runs and mutation-list idempotence.

## Conclusion

The implementation will make plain Python and Flutter onboarding produce a nonempty, reviewable verification policy and announce its effects. It reuses the existing installer, declaration merge, command execution, doctor, and tests, changes exactly the eight listed files, and introduces no new product files or protocol surface.

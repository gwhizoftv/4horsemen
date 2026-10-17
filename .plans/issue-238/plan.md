# Issue 238: Flutter analyzer warnings are nonfatal by default

Protocol version: 1. This plan implements the requirements recorded in issue 238: generated Flutter analysis must tolerate informational diagnostics and warnings while retaining analyzer error failures. The existing Flutter test command remains required.

## Exact File List to be changed or deleted

1. `src/setupWorkspace.ts` — in the Flutter branch of `proposeToolchainPolicy`, append `--no-fatal-warnings` to the shared analyzer argument array, yielding exactly `["flutter", "analyze", "--no-fatal-infos", "--no-fatal-warnings"]`. Continue using this object in both the precommit list and finalization `checks`. Preserve `flutter test` in prepush and finalization, detection precedence, critical paths, and declaration precedence.
2. `src/install.ts` — update the Flutter explanation in `logProjectPolicy`. Keep the SDK/dependency notice. Replace the current statement that `--no-fatal-infos` leaves warnings fatal with an explanation tied to each effective `flutter analyze` command's arguments. State separately whether informational diagnostics and warnings block, and that analyzer errors remain fatal. Do not combine flags found on different commands into one policy claim. Scope these explanations to the analyzer subcommand, and use the existing command rendering to identify the command when local and final policies differ. Handle the four combinations of the two nonfatal flags, with absence meaning that severity remains fatal; explicit positive counterparts, if present, take precedence according to their last occurrence in that command's argv. Keep this logic local to the existing logger.
3. `test/verify-config.test.ts` — update the expected analyzer argv in the existing `identifies Flutter by its SDK mapping` table. Its full proposal equality already verifies both analyzer placements, unchanged Flutter tests, critical paths, and detection behavior.
4. `test/onboard.test.ts` — update the existing Flutter onboarding expectation and extend its captured proposed/effective policy assertions. Add focused declared-policy display coverage using the existing install dry-run and declaration fixtures, including differing local and final analyzer arguments.
5. `docs/setup-workspace.md` — update the Flutter row in the Product languages table and its explanatory paragraph. Document both nonfatal flags, errors remaining fatal, and the unchanged `flutter test` checks. Explain that omitting `--no-fatal-warnings` from a declared analyzer command restores fatal warnings, and omitting both flags restores strict informational and warning handling. Policy is generated during install/onboard and recorded in configuration; explicit declarations retain precedence.

No files are deleted.

## Exact file list to be created

No new product, test, fixture, configuration, or dependency files are needed. This action creates only the required coordination artifact, `.plans/issue-238/plan.md`.

## Reuse and Scope

Reuse `proposeToolchainPolicy` and its shared `analyze` and `test` objects, the public `proposeProjectPolicy` entry point, and `buildWorkspaceConfig`'s existing declared-field precedence. Retain the existing `ProjectPolicyProposal`, `CheckCommand`, `CoordinatorConfig`, and `WorkspaceDeclaration` types without schema changes.

Reuse `logProjectPolicy`'s merged configuration, `effectiveCommands`, command rendering, and `EffectOptions.log`; keep the severity description within this function without exporting a new API or introducing a general command parser. Descriptions follow each command independently so a permissive precommit and strict finalization policy cannot produce a misleading global claim.

Reuse the existing Flutter YAML table in `test/verify-config.test.ts` and the Python/Flutter onboarding test in `test/onboard.test.ts`. For declared-policy cases, reuse that file's `product` fixture, `install` dry-run, captured log array, `readConfig`, and `writeDeclaration`. These rely on `makeProduct`, `ensureBuilt`, and cleanup from `test/support/workspaceFixture.ts`; that support file requires no edits. Preserve the fixture's assertion that installation does not execute Flutter or install dependencies.

The scope is the generator, its explanation, documentation, and their existing tests. There is no runtime migration, verification-runner change, hook modification, language-detection change, version bump, new dependency, or new abstraction.

## Tests

Extend existing coverage before the corresponding production changes:

1. In `test/verify-config.test.ts`, require the exact four-element analyzer argv in the existing Flutter SDK table. The current generator fails the updated expectation. Full proposal equality confirms that precommit and finalization use it and that prepush/finalization still run exactly `flutter test`.
2. In `test/onboard.test.ts`, update the existing Flutter onboarding case to assert the persisted argv and that both proposed dry-run and effective output describe warnings and informational diagnostics as nonfatal while keeping errors fatal. Retain checks that no product tool was executed, partial declarations remain authoritative, and the Python branch behaves as before. The current generator and warning-fatal explanation fail these expectations.
3. Add one compact declared-policy display test/table in `test/onboard.test.ts`, reusing a Flutter product and `install` with `dryRun: true`. Cover both flags, info-only, warning-only, and neither flag; include a mixed local/final declaration to associate each explanation with the proper command. Include an explicit-positive override row to verify the last-occurrence handling described above. Assert exact declared argv remains unchanged and the output accurately states fatality. Permissive-warning cases and per-command mixed output fail against the existing logger; strict cases protect compatibility. Use the existing fixture machinery, without requiring an installed Flutter SDK or simulating Flutter's analyzer implementation.

Focused implementation commands, confirmed against the package scripts and Vitest configurations:

```sh
pnpm exec vitest run --config vitest.config.ts test/verify-config.test.ts
pnpm exec vitest run --config vitest.system.config.ts test/onboard.test.ts
```

The active workspace configuration declares `pnpm run check:fast` for product precommit, `pnpm run test:e2e` for product prepush, and `pnpm run check` for coordinator finalization. The product commit/push hooks own their checks; do not manually duplicate their suites immediately before publishing. The final suite belongs to the coordinator at the approved pin. Here, `check:fast` includes lint, typecheck, fast tests, and system tests; `check` also builds and runs e2e. The existing `ensureBuilt` fixture refreshes compiled CLI output when needed.

For this evidence-only plan action, validate the required headings, nonempty section bodies, exact five-file map, issue requirements, and action identity/digest, then publish only the plan. No product suite is needed for this artifact, and no implementation or coordinator test result is claimed.

## Alternatives Rejected

- Editing only the finalization command would leave commit-time analysis warning-fatal. Updating the existing shared object covers both required defaults.
- Removing analysis or swallowing its exit status would also hide errors. The requested Flutter flags preserve the analyzer's error behavior.
- Replacing the log sentence with an unconditional permissive-policy claim would misdescribe strict declarations and mixed local/final policies. Derive each explanation from that command's arguments.
- Rewriting existing runtime configurations or overriding declarations exceeds the requested generator change and would alter owner-selected policy.
- Adding test files, custom fixture infrastructure, or a new policy abstraction would duplicate the existing proposal and onboarding coverage.

## Risks and Mitigations

- The shared analyzer command must remain identical at both verification stages. Existing full-object proposal assertions and persisted onboarding checks verify both placements.
- Install output can mislead owners if declarations differ from the defaults. Tests cover strict, permissive, and mixed command arguments and keep explanations associated with individual analyzer commands.
- Documentation may retain the old warning-fatal statement. Update both the language table and adjacent Flutter paragraph, and inspect references to `no-fatal-infos`, `no-fatal-warnings`, and warning fatality in the five changed files.
- Existing installations hold recorded policy. Document install/onboard generation and declaration precedence; this change does not silently rewrite active workspace configuration.
- The onboarding test suite uses compiled hook code. Continue using its existing `ensureBuilt` and disposable repository fixtures so verification reflects current source without touching a live product installation.

## Conclusion

Change the shared Flutter analyzer argv so informational diagnostics and warnings do not block generated precommit or finalization checks, while analyzer errors and failing Flutter tests still block. Keep the implementation within the five existing files, derive display text from effective commands, extend existing tests, and publish through the configured verification workflow.

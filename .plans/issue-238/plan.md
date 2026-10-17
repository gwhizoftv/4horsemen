# Implementation Plan — Issue 238: Ignore Warnings in Flutter Analyze Default Policy

## Exact File List to be changed or deleted

- `src/setupWorkspace.ts`
  - In `proposeToolchainPolicy` (line 278), update the `analyze` `CheckCommand` definition for `flutter` from `["flutter", "analyze", "--no-fatal-infos"]` to `["flutter", "analyze", "--no-fatal-infos", "--no-fatal-warnings"]`. Because `analyze` is shared by `verify.precommit` and `checks`, both precommit and finalization verification inherit the new default while `flutter test` (`verify.prepush` and second entry of `checks`) remains unchanged.
- `src/install.ts`
  - In `reportVerificationPolicy` (lines 305–310), inspect `effectiveCommands` for `flutter` commands that include `--no-fatal-infos` and/or `--no-fatal-warnings` so the printed explanation accurately states whether analyzer warnings are fatal:
    - When both `--no-fatal-infos` and `--no-fatal-warnings` are present (the new default):
      `"  --no-fatal-infos and --no-fatal-warnings leave only analyzer errors fatal; warnings and informational diagnostics do not block."`
    - When `--no-fatal-infos` is present without `--no-fatal-warnings`:
      `"  --no-fatal-infos leaves analyzer warnings and errors fatal; informational diagnostics do not block."`
    - When `--no-fatal-warnings` is present without `--no-fatal-infos`:
      `"  --no-fatal-warnings leaves only analyzer errors fatal; warnings do not block."`
- `docs/setup-workspace.md`
  - At line 545 in the product languages table, update the Flutter precommit/finalization proposal entry from `` `flutter analyze --no-fatal-infos` / `flutter test` `` to `` `flutter analyze --no-fatal-infos --no-fatal-warnings` / `flutter test` ``.
  - At lines 579–581 in the Flutter prose paragraph, update the explanation to state that the analyzer default leaves only errors fatal while allowing warnings and informational diagnostics, and that declaring `flutter analyze` without `--no-fatal-warnings` or `--no-fatal-infos` enforces those too.
- `test/verify-config.test.ts`
  - In `describe("installer proposals")` -> `"identifies Flutter by its SDK mapping: %s"` (line 185), update the expected `analyze` command to `{ name: "analyze", argv: ["flutter", "analyze", "--no-fatal-infos", "--no-fatal-warnings"] }`.
- `test/onboard.test.ts`
  - In `"onboards %s without declarations and reports the effective policy"` (line 153), update the expected Flutter `analyze` check argv to `["flutter", "analyze", "--no-fatal-infos", "--no-fatal-warnings"]`.
  - Update the Flutter summary expectation (line 165) to verify that the default summary reports `"only analyzer errors fatal; warnings and informational diagnostics do not block"`, and extend the Flutter branch of that test to verify that a declared `["flutter", "analyze", "--no-fatal-infos"]` policy (without `--no-fatal-warnings`) still reports `"leaves analyzer warnings and errors fatal; informational diagnostics do not block"`.

## Exact file list to be created

None. No new files will be created.

## Reuse and Scope

- **Reused functions and types**:
  - `proposeToolchainPolicy`, `proposeProjectPolicy`, `hasFlutterSdk`, `CheckCommand`, and `ProjectPolicyProposal` in `src/setupWorkspace.ts`.
  - `reportVerificationPolicy`, `install`, and `onboard` in `src/install.ts`.
  - Existing test helpers and fixtures `product`, `writeDeclaration`, `readConfig`, `localConfigGet`, `runCli`, and `runner` in `test/onboard.test.ts`, plus `proposeProjectPolicy` in `test/verify-config.test.ts`.
- **New files justification**:
  - Zero new files, dependencies, or abstractions are introduced; all changes are confined to the 5 existing files listed under `## Exact File List to be changed or deleted`.

## Tests

- **Existing test cases updated / extended (no new test files)**:
  1. `test/verify-config.test.ts` (`"identifies Flutter by its SDK mapping: %s"`): asserts that `proposeProjectPolicy(root)` returns `analyze` with `argv: ["flutter", "analyze", "--no-fatal-infos", "--no-fatal-warnings"]` in both `verify.precommit` and `checks` for every recognized Flutter `pubspec.yaml` layout. Fails before the `src/setupWorkspace.ts` change and passes after it.
  2. `test/onboard.test.ts` (`"onboards %s without declarations and reports the effective policy"`): asserts that onboarding a Flutter repository writes `["flutter", "analyze", "--no-fatal-infos", "--no-fatal-warnings"]` to `config.json` (`checks` and `verify.precommit`), prints the non-fatal-warnings explanation for the inferred default policy, and prints the fatal-warnings explanation when `--declare` supplies `["flutter", "analyze", "--no-fatal-infos"]` without `--no-fatal-warnings`. Fails before the `src/setupWorkspace.ts` and `src/install.ts` changes and passes after them.
- **Commands to run**:
  - Focused unit test: `pnpm vitest run --config vitest.config.ts test/verify-config.test.ts`
  - Focused system test: `pnpm vitest run --config vitest.system.config.ts test/onboard.test.ts`
  - Documentation check: `pnpm check:docs`
  - Pre-commit hook suite (owned by the commit hook on product commits): `pnpm check:fast` (`pnpm lint && pnpm typecheck && pnpm test:fast && pnpm test:system`)

## Alternatives Rejected

- **Hardcoding only the new default explanation in `src/install.ts` when `--no-fatal-infos` is present**: Rejected because an operator who explicitly declares `flutter analyze --no-fatal-infos` (without `--no-fatal-warnings`) via `--declare` still has fatal warnings. Checking both `--no-fatal-infos` and `--no-fatal-warnings` on `effectiveCommands` ensures `reportVerificationPolicy` accurately reflects whether warnings are fatal for both inferred defaults and custom declarations.
- **Adding `--no-fatal-warnings` only to `verify.precommit` while keeping warnings fatal in `checks`**: Rejected because the issue explicitly specifies changing the shared `analyze` definition in `src/setupWorkspace.ts:278` so both precommit and final verification ignore warnings and fail only on errors.

## Risks and Mitigations

- **Risk**: Updating the explanation string in `src/install.ts` could break existing substring assertions in `test/onboard.test.ts` or misdescribe a declared Flutter policy that uses only one of `--no-fatal-infos` or `--no-fatal-warnings`.
  - **Mitigation**: Handle all flag combinations (`--no-fatal-infos` + `--no-fatal-warnings`, `--no-fatal-infos` alone, and `--no-fatal-warnings` alone) in `src/install.ts`, and test both the inferred default and declared `--no-fatal-infos`-only case in `test/onboard.test.ts`.
- **Risk**: Machine-specific paths from the issue prompt (`/Users/...`) accidentally copied into `docs/setup-workspace.md` would fail the release-preparation check in `test/verify-config.test.ts`.
  - **Mitigation**: Keep `docs/setup-workspace.md` free of machine-specific paths and verify with `pnpm check:docs`.

## Conclusion

Updating the `analyze` command vector in `src/setupWorkspace.ts`, making the Flutter diagnostic explanation in `src/install.ts` reflect whether `--no-fatal-warnings` is active, and aligning `docs/setup-workspace.md`, `test/verify-config.test.ts`, and `test/onboard.test.ts` completely and minimally resolves Issue 238.

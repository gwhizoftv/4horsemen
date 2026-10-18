# Plan Review — Issue 238

Reviewed plans:
- `cursor` (`906c261150c48bfe2671010c4a2b1ef6425d9b4d`)
- `muse` (`9ab54576c173c0b47da66e2cbe02c5122a3fd6af`)
- `claude` (`9f7d9207003e367a3fcc7df2f7c4ee7c5d5d1b7e`)
- `codex` (`baccd4b9c16a97f2f3715377d7d7d9521e18cc90`)
- `antigravity` (`0cc8e654282591984cea541cf79a18106ade04f1`)

## Findings

1. **`cursor` (`906c261150c48bfe2671010c4a2b1ef6425d9b4d`) — `## Tests` (line 70, focused test command `pnpm vitest run test/verify-config.test.ts test/onboard.test.ts`)**
   - **Rule that must hold**: Focused test commands named in a plan must use the Vitest configuration that actually includes the target test file (`vitest.system.config.ts` for `test/onboard.test.ts`, because the default `vitest.config.ts` explicitly excludes `test/onboard.test.ts` at line 15).
   - **Concrete failure if followed as written**: Running `pnpm vitest run test/verify-config.test.ts test/onboard.test.ts` loads `vitest.config.ts` by default, which excludes `test/onboard.test.ts`, so `test/onboard.test.ts` is never executed by the planned development test command.
   - **Smallest correction**: Run `pnpm exec vitest run --config vitest.config.ts test/verify-config.test.ts` and `pnpm exec vitest run --config vitest.system.config.ts test/onboard.test.ts`.

2. **`cursor` (`906c261150c48bfe2671010c4a2b1ef6425d9b4d`) — `## Exact File List to be changed or deleted` (lines 18–21) and `## Tests` (lines 66–68)**
   - **Rule that must hold**: Every conditional branch introduced in `src/install.ts` (both the new default `--no-fatal-warnings` branch and the retained `--no-fatal-infos`-only fallback for declared overrides) must be covered by a focused assertion.
   - **Concrete failure if followed as written**: Because `test/onboard.test.ts` only updates the default Flutter onboarding expectation and adds no `--declare` assertion for a `--no-fatal-infos`-only policy, a regression that unconditionally prints the non-fatal-warnings message would pass all planned tests.
   - **Smallest correction**: In `test/onboard.test.ts`, add an assertion in the existing `--declare` section for `language === "flutter"` verifying that declaring `["flutter", "analyze", "--no-fatal-infos"]` outputs the warnings-fatal explanation.

3. **`muse` (`9ab54576c173c0b47da66e2cbe02c5122a3fd6af`) — `## Tests` (line 112, `pnpm exec vitest run --config vitest.config.ts test/verify-config.test.ts test/onboard.test.ts`)**
   - **Rule that must hold**: `test/onboard.test.ts` belongs to the system test partition in `vitest.system.config.ts` and is excluded in `vitest.config.ts` (line 15); commands targeting it must pass `--config vitest.system.config.ts`.
   - **Concrete failure if followed as written**: Invoking `vitest run --config vitest.config.ts` with `test/onboard.test.ts` skips `test/onboard.test.ts` completely, leaving the onboarding and install-summary changes unverified during focused test runs.
   - **Smallest correction**: Split the command to use `--config vitest.config.ts` for `test/verify-config.test.ts` and `--config vitest.system.config.ts` for `test/onboard.test.ts`.

4. **`muse` (`9ab54576c173c0b47da66e2cbe02c5122a3fd6af`) — `## Exact File List to be changed or deleted` (lines 23–28) and `## Tests` (lines 41–43, 104–107)**
   - **Rule that must hold**: `src/install.ts` must not claim that informational diagnostics do not block unless `--no-fatal-infos` is present, and `test/onboard.test.ts` must assert a substring that fails before the `src/install.ts` edit and passes after it.
   - **Concrete failure if followed as written**: Checking `includes("--no-fatal-warnings")` first without requiring `--no-fatal-infos` prints `"warnings and informational diagnostics do not block"` for a declared `flutter analyze --no-fatal-warnings` command where informational diagnostics still block. Additionally, keeping line 165 of `test/onboard.test.ts` as `"informational diagnostics do not block"` without requiring the warnings-non-fatal phrase lets the summary assertion pass even against the unedited `src/install.ts` message.
   - **Smallest correction**: Require both `--no-fatal-infos` and `--no-fatal-warnings` before claiming neither warnings nor informational diagnostics block, and update line 165 of `test/onboard.test.ts` to assert `"warnings and informational diagnostics do not block"`.

5. **`codex` (`baccd4b9c16a97f2f3715377d7d7d9521e18cc90`) — `## Exact File List to be changed or deleted` (item 2, line 8) and `## Tests` (item 3, line 35)**
   - **Rule that must hold**: `logProjectPolicy` in `src/install.ts` scans `effectiveCommands = [...(config.verify?.precommit ?? []), ...(config.verify?.prepush ?? []), ...config.checks]` (where the default `analyze` command appears twice, once in `verify.precommit` and once in `checks`) and must keep the change minimal within the issue without emitting duplicate lines or adding speculative flag-override parsers.
   - **Concrete failure if followed as written**: Emitting an explanation "tied to each effective `flutter analyze` command's arguments" across `effectiveCommands` prints duplicate analyzer explanation lines for every default Flutter install (since `verify.precommit` and `checks` both contain `analyze`), and prints a new fatality explanation line for bare `flutter analyze` commands that previously emitted none. Furthermore, implementing last-occurrence parsing for `--fatal-infos` / `--fatal-warnings` and a multi-row dry-run matrix exceeds the minimal change requested for `src/install.ts:307`.
   - **Smallest correction**: Keep a single summary explanation line in `logProjectPolicy` keyed on the effective Flutter analyzer flags (as in `claude`'s plan) rather than per-entry output across `effectiveCommands` and last-occurrence positive-flag parsing.

6. **`antigravity` (`0cc8e654282591984cea541cf79a18106ade04f1`) — `## Exact File List to be changed or deleted` (`src/install.ts` bullet, lines 10–17)**
   - **Rule that must hold**: When checking `effectiveCommands` in `src/install.ts`, the non-fatal-warnings message must only be printed when every relaxed `flutter` analyzer command includes `--no-fatal-warnings`, not merely when `.some(...)` command includes it.
   - **Concrete failure if followed as written**: If a declared policy sets `--no-fatal-warnings` in `verify.precommit` but omits `--no-fatal-warnings` in `checks` (finalization), using `.some(...)` for both flags prints that warnings do not block even though finalization still fails on warnings.
   - **Smallest correction**: Filter `effectiveCommands` to the relaxed `flutter` commands and require `.every((check) => check.argv.includes("--no-fatal-warnings"))` before printing the non-fatal-warnings explanation.

### Scope, Reuse, New Files, and Test Discipline Evaluation

- **Scope & New Files**: All five plans restrict changes to the exact five files named in Issue 238 (`src/setupWorkspace.ts`, `src/install.ts`, `test/verify-config.test.ts`, `test/onboard.test.ts`, and `docs/setup-workspace.md`) and create zero new product, test, or fixture files. `codex` over-scopes the `src/install.ts` and `test/onboard.test.ts` changes with last-occurrence positive-flag parsing and per-command output.
- **Reuse**: All five plans reuse `proposeToolchainPolicy` / `proposeProjectPolicy` in `src/setupWorkspace.ts`, `effectiveCommands` in `src/install.ts`, and the existing parameterized tests in `test/verify-config.test.ts` and `test/onboard.test.ts`.
- **Focused Tests**: `claude` (`9f7d9207003e367a3fcc7df2f7c4ee7c5d5d1b7e`) and `antigravity` (`0cc8e654282591984cea541cf79a18106ade04f1`) name the exact Vitest configs (`vitest.config.ts` and `vitest.system.config.ts`) and propose extending the existing Flutter branch in `test/onboard.test.ts` with one assertion for a declared `--no-fatal-infos`-only policy.

## Conclusion

`claude`'s plan (`9f7d9207003e367a3fcc7df2f7c4ee7c5d5d1b7e`) is the strongest and most mechanically complete: it stays strictly within the 5 files named in Issue 238, uses `relaxed.every((check) => check.argv.includes("--no-fatal-warnings"))` in `src/install.ts` so mixed or strict declarations are never misdescribed as ignoring warnings, updates line 165 of `test/onboard.test.ts` so the summary check fails before the change and passes after, adds a single focused `--declare` assertion in the existing `test/onboard.test.ts` loop to cover the warnings-fatal branch, and specifies the exact Vitest config flags for both test files.

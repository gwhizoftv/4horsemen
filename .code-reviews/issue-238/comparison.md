## Comparison

Compared bound implementation pins:
- `claude`: `6f585a13e6c88058c917d6c725f37e6092475c05`
- `cursor`: `b454bb3430e636f3144d19e59b169043b8ab8fd1`
- `antigravity`: `94b0da3d60ef3dc5e05b1019b81afb19b6396462`
- `codex`: `0968ef2b00bd7fa79c910360dc037d2906b1a39b`

All four implementations stay strictly within the five product, test, and documentation files named in Issue 238 (`src/setupWorkspace.ts`, `src/install.ts`, `test/verify-config.test.ts`, `test/onboard.test.ts`, and `docs/setup-workspace.md`), create no new product or test files, reuse `proposeToolchainPolicy` in `src/setupWorkspace.ts` and `logProjectPolicy` in `src/install.ts`, and add focused assertions to the existing test cases in `test/verify-config.test.ts` and `test/onboard.test.ts`. No additional tests were run during this comparison review; existing verification results were read from the bound submissions.

All four implementations are identical in `src/setupWorkspace.ts:278` and `test/verify-config.test.ts:185`, setting the shared Flutter `analyze` command to `{ name: "analyze", argv: ["flutter", "analyze", "--no-fatal-infos", "--no-fatal-warnings"] }` while leaving `flutter test` unchanged. They differ in how `src/install.ts` (`logProjectPolicy`) evaluates mixed or stricter declared analyzer policies and how `test/onboard.test.ts` tests those cases:

- `codex` (`0968ef2b00bd7fa79c910360dc037d2906b1a39b`) filters `effectiveCommands` to `flutter analyze` commands (`analyze.length > 0 && analyze.every((check) => check.argv.includes("--no-fatal-infos"))`) and then checks `analyze.every((check) => check.argv.includes("--no-fatal-warnings"))`. This ensures the summary claims informational diagnostics do not block only when every analyzer stage includes `--no-fatal-infos`, and claims warnings do not block only when every analyzer stage also includes `--no-fatal-warnings`. In `test/onboard.test.ts:180–199`, `codex` tests both a declared `--no-fatal-infos`-only override and a declared plain `["flutter", "analyze"]` override.
- `cursor` (`b454bb3430e636f3144d19e59b169043b8ab8fd1`) and `antigravity` (`94b0da3d60ef3dc5e05b1019b81afb19b6396462`) filter `effectiveCommands` to commands containing `--no-fatal-infos` before checking `.every((check) => check.argv.includes("--no-fatal-warnings"))`, which drops a declared plain `["flutter", "analyze"]` command from the check.
- `claude` (`6f585a13e6c88058c917d6c725f37e6092475c05`) checks `analyzers.every((check) => check.argv.includes("--no-fatal-warnings"))` inside `if (effectiveCommands.some((check) => check.argv[0] === "flutter" && check.argv.includes("--no-fatal-infos")))`, which prints `"informational diagnostics do not block"` even when finalization is declared as plain `["flutter", "analyze"]` (where informational diagnostics are still fatal).

## Findings

1. **`cursor` (`b454bb3430e636f3144d19e59b169043b8ab8fd1`) at `src/install.ts:307–311` and `antigravity` (`94b0da3d60ef3dc5e05b1019b81afb19b6396462`) at `src/install.ts:307–311`**
   - **File path and line number**: `src/install.ts:307` (in both `cursor` `b454bb3430e636f3144d19e59b169043b8ab8fd1` and `antigravity` `94b0da3d60ef3dc5e05b1019b81afb19b6396462`).
   - **Rule that must hold**: `logProjectPolicy` must not print `"leave only analyzer errors fatal; warnings and informational diagnostics do not block"` when any effective `flutter analyze` gate omits `--no-fatal-warnings` (including a strict `["flutter", "analyze"]` gate that omits both `--no-fatal-infos` and `--no-fatal-warnings`).
   - **Concrete failure that follows from breaking it**: When a Flutter workspace uses the inferred `verify.precommit` (`["flutter", "analyze", "--no-fatal-infos", "--no-fatal-warnings"]`) and declares strict finalization `checks: [{ name: "analyze", argv: ["flutter", "analyze"] }]`, `relaxed` (filtered by `check.argv.includes("--no-fatal-infos")`) excludes the strict finalization command. `relaxed.every((check) => check.argv.includes("--no-fatal-warnings"))` then evaluates to `true` and prints that only analyzer errors are fatal even though finalization fails on warnings and informational diagnostics.
   - **Smallest illustrative test**:
     ```ts
     writeDeclaration(fixture.workspaceRoot, { checks: [{ name: "analyze", argv: ["flutter", "analyze"] }] });
     output.length = 0;
     expect(await runCli([...argv, "--declare", declaration], { home: null, processRunner: runner, io: { stdout: log, stderr: log } })).toBe(0);
     expect(output.join("")).not.toContain("leave only analyzer errors fatal");
     ```

2. **`claude` (`6f585a13e6c88058c917d6c725f37e6092475c05`) at `src/install.ts:307–313` and `test/onboard.test.ts:198–204`**
   - **File path and line number**: `src/install.ts:307` and `test/onboard.test.ts:198` (in `claude` `6f585a13e6c88058c917d6c725f37e6092475c05`).
   - **Rule that must hold**: `logProjectPolicy` must not claim `"informational diagnostics do not block"` when an effective `flutter analyze` command omits `--no-fatal-infos` (where informational diagnostics remain fatal in `flutter analyze`).
   - **Concrete failure that follows from breaking it**: When `verify.precommit` is inferred (`["flutter", "analyze", "--no-fatal-infos", "--no-fatal-warnings"]`) and `checks` is declared with `["flutter", "analyze"]` (without `--no-fatal-infos`), `effectiveCommands.some(... includes("--no-fatal-infos"))` is `true` while `analyzers.every(... includes("--no-fatal-warnings"))` is `false`, so `src/install.ts:312` prints `"--no-fatal-infos leaves analyzer warnings and errors fatal; informational diagnostics do not block"` — falsely telling the user that informational diagnostics do not block even though the declared finalization `flutter analyze` gate exits non-zero on informational diagnostics.
   - **Smallest illustrative test**:
     ```ts
     writeDeclaration(fixture.workspaceRoot, { checks: [{ name: "analyze", argv: ["flutter", "analyze"] }] });
     output.length = 0;
     expect(await runCli([...argv, "--declare", declaration], { home: null, processRunner: runner, io: { stdout: log, stderr: log } })).toBe(0);
     expect(output.join("")).not.toContain("informational diagnostics do not block");
     ```

## Conclusion

`codex` (`0968ef2b00bd7fa79c910360dc037d2906b1a39b`) is the strongest implementation: it stays strictly within the five approved files, requires `analyze.length > 0 && analyze.every((check) => check.argv.includes("--no-fatal-infos"))` before claiming informational diagnostics do not block, requires `analyze.every((check) => check.argv.includes("--no-fatal-warnings"))` before claiming warnings do not block, and verifies both `--no-fatal-infos`-only and plain `flutter analyze` declarations in `test/onboard.test.ts`.

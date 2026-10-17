# Issue 238 — Flutter analyzer default fails only on errors

Issue #238 asks coord's inferred Flutter policy to stop failing on analyzer
warnings. The single `analyze` command object in `proposeProjectPolicy` feeds
both `verify.precommit` and `checks` (finalization), so changing its `argv`
changes both defaults. `flutter test` is unchanged. Projects that need stricter
analysis keep overriding through `--declare`.

## Exact File List to be changed or deleted

- `src/setupWorkspace.ts` (line 278, Flutter branch of `proposeProjectPolicy`):
  change the `analyze` command to
  `{ name: "analyze", argv: ["flutter", "analyze", "--no-fatal-infos", "--no-fatal-warnings"] }`.
  Nothing else in that branch changes (test command, prefixes, critical files).
- `src/install.ts` (lines 306–309, inside `logProjectPolicy`): keep the
  existing condition (any `flutter` command whose argv includes
  `--no-fatal-infos`) and choose the explanation by whether warnings stay fatal:
  - when every such command also includes `--no-fatal-warnings`, print
    `  --no-fatal-infos --no-fatal-warnings leave only analyzer errors fatal; warnings and informational diagnostics do not block.`
  - otherwise keep the current line
    `  --no-fatal-infos leaves analyzer warnings and errors fatal; informational diagnostics do not block.`

  Sketch:
  ```ts
  const relaxed = effectiveCommands.filter((check) => check.argv[0] === "flutter" && check.argv.includes("--no-fatal-infos"));
  if (relaxed.length > 0) {
    lines.push(relaxed.every((check) => check.argv.includes("--no-fatal-warnings"))
      ? "  --no-fatal-infos --no-fatal-warnings leave only analyzer errors fatal; warnings and informational diagnostics do not block."
      : "  --no-fatal-infos leaves analyzer warnings and errors fatal; informational diagnostics do not block.");
  }
  ```
- `test/verify-config.test.ts` (line 185, `identifies Flutter by its SDK mapping`):
  update the expected `analyze.argv` to include `"--no-fatal-warnings"`.
- `test/onboard.test.ts`:
  - line 153: update the expected Flutter `analyze.argv` to include `"--no-fatal-warnings"`.
  - line 165: change the Flutter summary expectation to
    `"warnings and informational diagnostics do not block"`.
  - in the existing `--declare` re-run section of the same `it.each` case
    (after line 179), add a Flutter-only branch next to the existing
    `if (language === "python")` block. It declares
    `checks: [{ name: "analyze", argv: ["flutter", "analyze", "--no-fatal-infos"] }]`
    and asserts that the summary contains
    `"leaves analyzer warnings and errors fatal"` and does not contain
    `"leave only analyzer errors fatal"`.
- `docs/setup-workspace.md`:
  - line 545 (marker table): change the Flutter precommit entry to
    `flutter analyze --no-fatal-infos --no-fatal-warnings` / `flutter test`.
  - lines 579–581: replace "The analyzer default leaves warnings and errors
    fatal while allowing informational diagnostics; declare `flutter analyze`
    without `--no-fatal-infos` to enforce those too." with text saying the
    analyzer default fails only on errors, and that projects can declare
    `flutter analyze` without `--no-fatal-warnings` (and/or `--no-fatal-infos`)
    to make warnings (and infos) fatal again.

No files are deleted. `dist/` is untracked build output and is not edited.

## Exact file list to be created

- `.plans/issue-238/plan.md` (this coordination artifact) is the only new file.
- No product files are created.

## Reuse and Scope

- Reuse the existing `analyze` constant in the Flutter branch of
  `proposeProjectPolicy` (`src/setupWorkspace.ts`). Because one object already
  supplies `verify.precommit` and `checks`, a single argv edit changes both
  defaults with no new plumbing.
- Reuse the existing Flutter explanation block in `logProjectPolicy`
  (`src/install.ts`), its `effectiveCommands` list, and its
  `--no-fatal-infos` condition. Only the chosen sentence changes.
- Reuse the existing tests: the `identifies Flutter by its SDK mapping`
  `it.each` in `test/verify-config.test.ts`, and the
  `onboards %s without declarations and reports the effective policy` case in
  `test/onboard.test.ts`, including its `writeDeclaration` / `runCli`
  `--declare` re-run helpers and fixture `product(...)`. No new fixture,
  helper, test file, type, or dependency is added.
- Scope is limited to the analyzer arguments named in the issue, the
  explanation text, the matching tests, and the documentation. The `flutter
  test` command, Flutter detection, critical paths, and other toolchains stay
  unchanged.

## Tests

The edited cases fail before the source change and pass after it:

1. `test/verify-config.test.ts` → `identifies Flutter by its SDK mapping`
   (the Flutter-positive rows): with the updated expected argv it fails until
   `src/setupWorkspace.ts` emits `--no-fatal-warnings`.
2. `test/onboard.test.ts` → `onboards flutter without declarations and reports
   the effective policy`:
   - The expected `checks` / `verify.precommit` argv fails until the generator
     changes.
   - The summary assertion `"warnings and informational diagnostics do not
     block"` fails until `logProjectPolicy` picks the new sentence.
   - The new declared-strict branch in the same case keeps the
     warnings-fatal sentence covered, so both sides of the new conditional are
     tested. That branch passes before and after the change, and it guards
     against regressing to a single sentence that is unconditionally relaxed.

Commands:
- While developing: `pnpm exec vitest run --config vitest.config.ts test/verify-config.test.ts`
  and `pnpm exec vitest run --config vitest.system.config.ts test/onboard.test.ts`.
- `pnpm check:docs` for the edited documentation (it runs the
  shipped-examples and verification-instructions tests in
  `test/verify-config.test.ts`).
- The precommit hook runs `pnpm check:fast` (lint, typecheck, fast and system
  tests), which covers both edited test files. The coordinator owns full
  `pnpm check` (build + check:fast + e2e) at the approved pin.

## Alternatives Rejected

- **Drop `--no-fatal-infos` and keep only `--no-fatal-warnings`.** In Flutter's
  analyzer, info and warning fatality are separate flags, and both are fatal by
  default. Dropping `--no-fatal-infos` would make infos fatal again, which the
  issue does not ask for. The issue also gives the exact argv.
- **Separate analyze commands for precommit and finalization.** The issue
  wants both defaults changed together. Splitting the object adds divergence
  risk with no benefit.
- **Remove the explanation line from `install.ts`.** The issue asks that the
  displayed explanation reflect whether warnings are fatal, and onboarding
  users rely on this line to understand the default.
- **Explain each analyze command separately in the summary.** That adds output
  and code for a rare mixed declaration. The conservative "warnings fatal"
  sentence is printed whenever any relaxed-infos command keeps warnings fatal,
  which is accurate for at least that gate.
- **A new test file for the explanation.** The existing onboard case already
  captures the summary and has a `--declare` re-run, so extending it is
  smaller.

## Risks and Mitigations

- **Existing onboarded Flutter projects keep the old argv.** Policy is recorded
  at install, and hooks execute the recorded policy. Only new or re-onboarded
  installs pick up the default. This is intended: re-onboarding without
  `--declare` adopts it, and the docs say how to opt back into fatal warnings.
- **Warnings no longer block commits or finalization.** This is the requested
  behavior. The docs state how to restore stricter analysis with `--declare`.
- **Mixed declarations (one relaxed, one strict analyze command).** The summary
  prints the warnings-fatal sentence, which is conservative and true for the
  strict gate. The new onboard branch checks the strict path.
- **Documentation drift.** The table row and the prose paragraph are both
  edited, and `pnpm check:docs` runs the shipped-documentation tests.
- **Flag spelling.** `--no-fatal-warnings` is the negated form of Flutter's
  `--[no-]fatal-warnings` analyze option. The tests pin the exact argv.

## Conclusion

Add `--no-fatal-warnings` to the single Flutter `analyze` command in
`src/setupWorkspace.ts`. This changes both the precommit and finalization
defaults so that only analyzer errors fail. Then make `logProjectPolicy` in
`src/install.ts` choose its explanation by whether warnings remain fatal,
update the expected argv and summary in `test/verify-config.test.ts` and
`test/onboard.test.ts`, add one declared-strict assertion branch to the
existing onboard case, and update `docs/setup-workspace.md` (table row and
prose). No new files, helpers, or dependencies are needed. Verification uses
focused vitest runs, `pnpm check:docs`, and the hook-owned `pnpm check:fast`.

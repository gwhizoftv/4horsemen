# Issue 238 — Flutter analyze defaults ignore warnings

Make the Flutter toolchain policy default treat analyzer warnings as
non-fatal (errors only), matching the issue’s prescribed `analyze` argv.
`flutter test` stays unchanged. Scope is the five files the issue names; no
new abstractions or dependencies.

## Exact File List to be changed or deleted

- `src/setupWorkspace.ts` — in `proposeToolchainPolicy`’s Flutter branch
  (~line 278), change the shared `analyze` CheckCommand to:
  `{ name: "analyze", argv: ["flutter", "analyze", "--no-fatal-infos", "--no-fatal-warnings"] }`.
  That object is already reused for `verify.precommit` and `checks`, so both
  defaults update together; leave the `test` command as `flutter test`.
- `src/install.ts` — in the Flutter install-summary branch (~lines 307–308),
  make the printed explanation depend on whether argv includes
  `--no-fatal-warnings`: when present, state that infos and warnings do not
  block and only errors remain fatal; when only `--no-fatal-infos` is present
  (declared overrides), keep the existing “warnings and errors fatal /
  informational diagnostics do not block” wording so declared policies stay
  accurate.
- `test/verify-config.test.ts` — update the Flutter-positive expectation’s
  `analyze` argv (~line 185) to include `--no-fatal-warnings` after
  `--no-fatal-infos`.
- `test/onboard.test.ts` — update the Flutter onboard expectation’s `analyze`
  argv (~line 153) the same way. If the install-summary string no longer
  contains the current Flutter substring asserted near line 165
  (`informational diagnostics do not block`), adjust that assertion to match
  the new default explanation while still proving warnings are described as
  non-fatal.
- `docs/setup-workspace.md` — in the language-defaults table (~line 545),
  document `flutter analyze --no-fatal-infos --no-fatal-warnings` /
  `flutter test`. Update the Flutter prose (~lines 579–581) so the documented
  default matches: errors fatal; infos and warnings non-fatal; note how to
  declare a stricter analyze command if warnings must fail.

## Exact file list to be created

- `.plans/issue-238/plan.md` (this plan; coordination artifact only).

No product source files are created.

## Reuse and Scope

- Reuses the existing Flutter branch of `proposeToolchainPolicy` in
  `src/setupWorkspace.ts`, including the shared `analyze` object that already
  feeds both precommit and finalization checks.
- Reuses `effectiveCommands` scanning in `src/install.ts` (the existing
  `argv[0] === "flutter"` / `--no-fatal-infos` gates); only the warning-fatal
  explanation becomes flag-sensitive.
- Reuses the Flutter cases already in `test/verify-config.test.ts`
  (`identifies Flutter by its SDK mapping`) and `test/onboard.test.ts`
  (language onboard matrix) — extend expectations, do not add new test files.
- Reuses the existing documentation section that describes Flutter detection
  and analyzer defaults.
- Out of scope: changing `flutter test`; migrating already-installed product
  configs (policy is recorded at install/onboard time); non-Flutter toolchains;
  new helpers, packages, or files beyond this plan.

## Tests

- `test/verify-config.test.ts` — existing Flutter-positive cases must expect
  `argv: ["flutter", "analyze", "--no-fatal-infos", "--no-fatal-warnings"]`
  (and unchanged `flutter test`). These fail before the generator change and
  pass after it.
- `test/onboard.test.ts` — Flutter onboard path must expect the same analyze
  argv in `configured.checks` / verify slices, and the printed summary must
  still describe non-fatal warnings under the new install wording.
- Commands while developing: focused
  `pnpm vitest run test/verify-config.test.ts test/onboard.test.ts`.
  Product commits rely on the hook’s `pnpm check:fast`; this plan publish is
  coordination evidence only (no product suite required for the plan commit).

## Alternatives Rejected

- **Only document or only change install text**: the default is defined in
  `setupWorkspace.ts`; tests and docs would disagree with runtime policy.
- **Separate precommit vs finalization analyze argv**: the issue requires one
  shared object so both gates stay aligned.
- **Drop `--no-fatal-infos`**: the issue keeps it and adds
  `--no-fatal-warnings`.
- **New helper/module for Flutter check construction**: four call sites do not
  justify a new abstraction; edit the existing literals.
- **Rewrite already-onboarded product configs**: install records policy once;
  this issue only changes the generator default for new onboard/reinstall.

## Risks and Mitigations

- *Installed Flutter workspaces keep the old analyze argv until re-onboard or
  reinstall*: expected; document in the setup-workspace default text that the
  change applies at policy generation time.
- *Stricter declared policies that omit `--no-fatal-warnings`*: install
  summary stays accurate by branching on the flag rather than always claiming
  warnings are non-fatal.
- *Docs table and prose drift*: update both the table row and the Flutter
  analyzer paragraph in the same commit as the code default.
- *Onboard summary assertion fragility*: keep or retarget the Flutter substring
  check in `test/onboard.test.ts` in the same change as `install.ts`.

## Conclusion

Add `--no-fatal-warnings` to the shared Flutter `analyze` default, align the
two expectation sites, make the install explanation flag-aware, and document
the new default. Smallest change that fully matches issue 238; no new files
beyond this plan.

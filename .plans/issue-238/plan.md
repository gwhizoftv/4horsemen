# Plan — issue 238: Flutter analyze ignores warnings, fails only on errors

Goal: change coord's generated Flutter policy so `flutter analyze` fails only on
analyzer errors. Warnings and informational diagnostics must not block
precommit or final verification. `flutter test` is unchanged.

## Exact File List to be changed or deleted

Changed (no files deleted):

- `src/setupWorkspace.ts` — in `proposeToolchainPolicy`, the Flutter branch
  (line 278): change the single `analyze` definition from
  `argv: ["flutter", "analyze", "--no-fatal-infos"]` to
  `argv: ["flutter", "analyze", "--no-fatal-infos", "--no-fatal-warnings"]`.
  That one object is reused for `verify.precommit: [analyze]` and for
  `checks: [analyze, test]` (lines 280–283), so this one edit changes both
  the precommit and the final-verification defaults. Do not touch the
  `test` definition (`["flutter", "test"]`), `hasFlutterSdk`, toolchain
  priority/fall-through above it, `workflowCriticalPrefixes`, or
  `workflowCriticalFiles`.
- `src/install.ts` — the Flutter explanation in the install summary
  (lines 305–310, inside the `effectiveCommands` scan): make the displayed
  text reflect whether warnings are fatal. When an effective Flutter check
  includes `--no-fatal-warnings`, print a line stating that only analyzer
  errors are fatal and that warnings and informational diagnostics do not
  block; otherwise, when it includes only `--no-fatal-infos`, keep the
  existing line (`--no-fatal-infos leaves analyzer warnings and errors
  fatal; informational diagnostics do not block.`). Either wording must
  retain the substring `informational diagnostics do not block`, which the
  existing onboard test asserts. No other install output changes.
- `test/verify-config.test.ts` — line 185, in
  `identifies Flutter by its SDK mapping: %s`: update the expected
  `analyze` argv to
  `["flutter", "analyze", "--no-fatal-infos", "--no-fatal-warnings"]`.
  The same `analyze`/`test` pair is asserted against `verify.precommit`,
  `verify.prepush`, and `checks`, so this covers both verification stages.
- `test/onboard.test.ts` — line 153, in
  `onboards %s without declarations and reports the effective policy`:
  update the expected Flutter `analyze` argv to
  `["flutter", "analyze", "--no-fatal-infos", "--no-fatal-warnings"]`.
  Keep the line-165 summary assertion (`informational diagnostics do not
  block`) valid under the new `src/install.ts` wording; extend it only if
  the new wording needs an added assertion that warnings do not block.
- `docs/setup-workspace.md` — line 545 table row: change the Flutter
  precommit/finalization command to
  `flutter analyze --no-fatal-infos --no-fatal-warnings`; lines 579–581:
  rewrite the analyzer-default paragraph so it states that only errors are
  fatal, warnings and informational diagnostics do not block, and that a
  project declares `flutter analyze` without those flags to enforce
  warnings/infos too. No other rows or sections change.

## Exact file list to be created

No new product, test, or documentation files are created by the
implementation. The only file created in this phase is this planning
artifact, `.plans/issue-238/plan.md`; the implementation phase creates
nothing and deletes nothing.

## Reuse and Scope

Reuse, do not reimplement:

- `src/setupWorkspace.ts`: `proposeToolchainPolicy` (Flutter branch),
  `proposeProjectPolicy`, `hasFlutterSdk`, and the existing `CheckCommand`
  shape (`{ name, argv }`). The existing single-`analyze`-object pattern —
  one definition feeding both `verify.precommit` and `checks` — is the
  mechanism that makes one argv edit change both defaults; keep it.
- `src/install.ts`: the existing `effectiveCommands` aggregation
  (`config.verify.precommit` + `prepush` + `config.checks`) and its
  `check.argv[0] === "flutter"` / `argv.includes(...)` detection. Branch on
  the flags already present; add no new config field, flag, or helper.
- Tests: the existing fixtures and cases in `test/verify-config.test.ts`
  (temporary `pubspec.yaml` roots via `mkdtempSync`, `proposeProjectPolicy`)
  and `test/onboard.test.ts` (`product(...)` fixture, dry-run then real
  `onboard`/`runCli`, `readConfig`). Extend those cases in place; add no
  new test file and no new fixture helper.
- Docs: the existing Product languages table and Flutter paragraph in
  `docs/setup-workspace.md`.

Scope is exactly the five files above. Out of scope: `flutter test`,
Flutter detection (`hasFlutterSdk` and its YAML parsing), toolchain
priority and Node/Make fall-through, hook execution, the declaration
(`--declare`) mechanism and schema, version bump (the `0.0.N` advance is
checked only on the PR into `main`), and any already-generated workspace
config on disk (see Risks).

## Tests

Fewest focused tests; each fails before the change and passes after it.
Update expectations first or together with the source change and observe
the failure against the old argv before the source edit lands:

1. `test/verify-config.test.ts` — existing case
   `identifies Flutter by its SDK mapping: %s` (all `flutter: true` rows):
   with the expected argv updated to include `--no-fatal-warnings`, it
   fails against the old `src/setupWorkspace.ts` definition and passes
   after. It asserts the full proposal, so it proves the new argv reaches
   both `verify.precommit` and `checks`, and that `flutter test` and the
   critical prefixes/files are unchanged.
2. `test/onboard.test.ts` — existing case
   `onboards flutter without declarations and reports the effective policy`:
   with line 153 updated, the recorded `config.checks`/`verify` comparison
   fails before and passes after; the summary assertions prove the
   generated config and the printed explanation stay consistent, including
   `informational diagnostics do not block`. If the new `src/install.ts`
   wording adds a warnings-specific phrase, assert that exact phrase in
   this same case rather than adding a new test.

Focused commands while developing (run these, in this order):

```sh
pnpm exec vitest run --config vitest.config.ts test/verify-config.test.ts test/onboard.test.ts
pnpm lint
pnpm typecheck
```

No manual product suite beyond this: the precommit hook owns the mandatory
`pnpm check:fast` at commit time, and the coordinator owns final checks at
the approved pin against the frozen baseline. No Flutter SDK is needed —
both tests stub the toolchain through fixtures and a fake executable.

## Alternatives Rejected

- Add `--no-fatal-warnings` only to precommit or only to final checks:
  rejected. The issue requires both defaults to change, and the code
  deliberately shares one `analyze` object between them; splitting it
  would create a divergence the issue does not ask for.
- Drop `--no-fatal-infos` and keep only `--no-fatal-warnings`: rejected.
  The issue prescribes the exact argv with both flags, in that order.
- Downgrade warning severity via a generated `analysis_options.yaml`:
  rejected. Coord generates command policy, not product analyzer config;
  this would write into the product tree and affect developers outside
  coord.
- Replace `flutter analyze` with a wrapper that filters its output:
  rejected as new machinery for a one-flag default change.
- Change already-generated workspace configs in place: rejected. Policy
  is recorded at install/onboard time and hooks execute the recorded
  policy without re-detecting the language; rewriting live configs is a
  separate migration, not this issue.
- Update only `src/setupWorkspace.ts` and leave tests/docs/install text
  stale: rejected. The expected argv in the two tests, the install
  explanation, and the documented default would contradict the code.

## Risks and Mitigations

- Existing Flutter workspaces keep the old recorded policy until they are
  re-onboarded/reinstalled, because detection happens only at install and
  hooks run the recorded commands. Mitigation: the docs update states the
  new default; no code in this change mutates existing configs, and no
  test asserts otherwise.
- The install explanation could contradict the effective commands for a
  declared policy (for example a declaration with `--no-fatal-infos` but
  no `--no-fatal-warnings`). Mitigation: branch the message on the flags
  actually present in `effectiveCommands`, keeping the current
  warnings-fatal wording for that case, and keep the asserted substring
  `informational diagnostics do not block` in both wordings.
- Weakening the gate lets real warnings merge unnoticed. Mitigation: that
  is the issue's stated intent — errors remain fatal, `flutter test` is
  unchanged, and projects can still declare plain `flutter analyze` to
  enforce warnings; the docs must say so.
- Flag order or spelling drift between code, tests, and docs.
  Mitigation: use the exact prescribed argv
  `["flutter", "analyze", "--no-fatal-infos", "--no-fatal-warnings"]`
  everywhere, and let the two updated tests pin it.
- `docs/setup-workspace.md` is documentation, but this change also touches
  `src/` and `test/`, so it is a mixed change and retains product checks;
  do not expect the documentation-only profile.

## Conclusion

One argv edit in `src/setupWorkspace.ts` changes both the precommit and
final-verification Flutter defaults to fail only on analyzer errors, with
matching expectation updates in `test/verify-config.test.ts` and
`test/onboard.test.ts`, a flag-aware explanation in `src/install.ts`, and
the documented default updated in `docs/setup-workspace.md`. Five files
changed, none created or deleted, no new abstraction or dependency, and
two existing focused tests pin the behavior.

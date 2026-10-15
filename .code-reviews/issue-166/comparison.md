# Issue 166 implementation comparison

Bound pins:

- Claude: `ab1393881936df212f1649bc17e5804bf8cb80d7`
- Cursor: `bc5812c2ac7ed4aba2310d28a7a2f65f118df8bf`
- Codex: `72d156d68e6075027eb050b74be9d5f7b972c628`

All three stay on installer policy inference, move `js-yaml` to a runtime
dependency, announce the merged config on install/onboard, update README and
`docs/setup-workspace.md`, and extend `test/verify-config.test.ts` plus
`test/onboard.test.ts`. No pin invents a product source file outside the
approved map. The findings below are defects in the implementations as written.

## Comparison

### Codex `72d156d68e6075027eb050b74be9d5f7b972c628` — preferred

Codex is the only pin that both preserves an already usable `make test` gate
and records `flutter analyze --no-fatal-infos`. Detector flow in
`src/setupWorkspace.ts` is Cargo, Go, then Node when it already has finalization
checks, then Make when it has a `test` target, then Flutter, then Python, then a
Makefile without `test`. A Flutter tree with an incidental `package.json` that
only has `lint` still becomes Flutter; a Node tree with a real `test` script
keeps npm. Policy logging comes from the validated config with per-field
provenance, and the Flutter effect line names `--no-fatal-infos`. Tests lock
Make-over-Flutter, Make-over-Python, Node-with-checks, and Flutter-over-empty
Node.

### Claude `ab1393881936df212f1649bc17e5804bf8cb80d7` — strong, two gaps

Claude keeps Make with a `test` target ahead of Python, uses YAML for the
Flutter SDK marker, bare `pytest`, and a clear install summary with proposal
`effects` that never enter the workspace config. Order is Cargo, Go, Flutter,
Node, Make-with-checks, Python, Make-without. That fixes the Python+Make
regression and still lets Flutter beat an incidental Node manifest. It does not
keep Make ahead of Flutter, and it omits `--no-fatal-infos`.

### Cursor `bc5812c2ac7ed4aba2310d28a7a2f65f118df8bf` — plan-faithful, wrong Make order

Cursor follows the selected plan’s detector order (Cargo, Go, Flutter, Node,
Python, Make) with YAML Flutter detection, bare `pytest`, and an effective-policy
summary. That order is the defect: Python always outranks a Makefile that already
supplies `make test`. Flutter also always outranks Node and Make, and analyze
runs without `--no-fatal-infos`.

## Findings

1. Cursor `src/setupWorkspace.ts:308-320`. After the Node branch, Python returns
   before any Makefile is considered, including when `makeTargets` would yield a
   `test` target. Rule: re-onboard must not replace a finalization gate that
   already installs successfully. Failure: a repository with `pyproject.toml` and
   a Makefile whose `test` target runs the real suite currently records
   `["make","test"]`; after this pin it records `["pytest","-q"]`, so doctor or
   the first commit fails when pytest is not the gate. Smallest test: assert
   `proposeProjectPolicy` on `pyproject.toml` plus `Makefile` with `test:` returns
   `checks[0].argv === ["make","test"]` (Claude and Codex already have this).

2. Cursor `src/setupWorkspace.ts:198` and Claude `src/setupWorkspace.ts:245`.
   Precommit is `["flutter","analyze"]` with no `--no-fatal-infos`. Rule: a
   default commit gate must fail on defects, not on advisory analyzer infos that
   predate the agent’s change. Failure: `flutter analyze` treats info-level
   diagnostics as fatal by default; a `flutter create` app with `flutter_lints`
   blocks every agent commit on style infos. Smallest correction: match Codex’s
   `["flutter","analyze","--no-fatal-infos"]` and assert that argv in the Flutter
   proposal test.

3. Cursor `src/setupWorkspace.ts:286-287` and Claude `src/setupWorkspace.ts:244-255`.
   A confirmed Flutter pubspec returns before Make is inspected. Rule: the same
   Make-with-checks preservation that both pins apply (or claim) for Python must
   hold for Flutter. Failure: a Flutter app whose Makefile already has `test`
   (or a monorepo that gates with Make) re-onboards to `flutter test` instead of
   `make test`. Codex `src/setupWorkspace.ts:256-257` returns Make when
   `make.checks` is set, before Flutter. Smallest test: pubspec with Flutter SDK
   plus Makefile `test:` → toolchain `make` (Codex’s mixed-marker case).

4. Cursor `src/setupWorkspace.ts:286-305` and Claude `src/setupWorkspace.ts:244-273`.
   Flutter returns before Node even when `package.json` already has a finalization
   script. Rule: an incidental tooling manifest should yield to Flutter, but a
   Node gate that already supplies checks must keep winning. Failure: a hybrid
   app with both a working `npm test` script and a Flutter SDK dependency
   silently switches from Node to Flutter on reinstall. Codex
   `src/setupWorkspace.ts:241-242` returns the Node proposal when
   `proposal.checks !== undefined`, and only falls through for Flutter when Node
   has no finalization checks. Smallest test: `package.json` with `test` plus
   Flutter pubspec → npm/pnpm/yarn checks; `package.json` with only `lint` plus
   Flutter → flutter.

## Verdict

Prefer Codex `72d156d68e6075027eb050b74be9d5f7b972c628`. It is the only
implementation that preserves usable Make and Node gates, records
`--no-fatal-infos`, and tests those boundaries. Claude is the next best base if
Codex is not chosen: keep its Make-before-Python order and YAML detection, then
add `--no-fatal-infos` and Make-before-Flutter. Cursor should not be selected
unchanged because finding 1 changes onboarding results for every Python repo that
already used `make test`.

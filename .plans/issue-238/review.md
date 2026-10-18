# Issue 238 plan review

Reviewed the exported bound plans at these exact pins:

| Agent | Plan pin |
| --- | --- |
| cursor | `906c261150c48bfe2671010c4a2b1ef6425d9b4d` |
| muse | `9ab54576c173c0b47da66e2cbe02c5122a3fd6af` |
| claude | `9f7d9207003e367a3fcc7df2f7c4ee7c5d5d1b7e` |
| codex | `baccd4b9c16a97f2f3715377d7d7d9521e18cc90` |
| antigravity | `0cc8e654282591984cea541cf79a18106ade04f1` |

## Findings

1. **[P2] Cursor, Muse, Claude, and Antigravity — the five-file scope claims do not match the mechanically approved maps.** Each plan claims the implementation is confined to the five files named by the issue. The approved map must authorize exactly those files; unrelated paths and directory-wide permissions must not enter through explanatory prose. Running the existing `extractApprovedPaths` on the bound artifacts produces these additional permissions:

   | Plan | Additional extracted paths |
   | --- | --- |
   | cursor | `configured.checks`, `install.ts`, `setupWorkspace.ts`, `verify.precommit` |
   | muse | `analysis_options.yaml`, `config.checks`, `src/`, `test/`, `verify.precommit`, `verify.prepush` |
   | claude | `analyze.argv`, `dist/`, `install.ts`, `it.each`, `verify.precommit` |
   | antigravity | `config.json`, `pubspec.yaml`, `verify.precommit`, `verify.prepush` |

   The concrete failure is an approved scope broader than the plan promises: Muse authorizes all source and test files, Claude authorizes the build-output directory, and Antigravity authorizes product configuration/manifests. The other tokens also become unintended file permissions. The extractor in `src/evidence.ts` scans backticked tokens outside Reuse and Scope, including Tests, Risks, and Alternatives; prose saying a path is excluded does not negate that authorization. Remove path-like code formatting from non-change references, or place those references in Reuse and Scope, and validate that extraction returns only the five intended files. Codex's bound plan passes this exact-map check.

2. **[P2] Cursor and Muse — the Tests commands omit the onboarding regression.** Cursor proposes a single default-config Vitest invocation for both changed test files; Muse explicitly passes `vitest.config.ts` with both files. A focused validation command must select every regression it claims to run. The repository's fast configuration explicitly excludes `test/onboard.test.ts`, while `vitest.system.config.ts` includes it. Following either command can report success from the proposal tests while executing none of the changed onboarding/configuration/display assertions. The commit hook eventually runs the system tier, but that does not make the proposed focused check exercise onboarding. Use separate fast and system invocations, including `pnpm exec vitest run --config vitest.system.config.ts test/onboard.test.ts`.

3. **[P2] Cursor, Muse, and Antigravity — the install-display specification misstates a warnings-only override.** Cursor and Muse say an effective command containing `--no-fatal-warnings` should be described as permitting warnings and informational diagnostics; Antigravity explicitly specifies that the warnings-only case leaves only errors fatal. The display must reflect the effective analyzer arguments, and warning fatality and info fatality are independent. For a declared `flutter analyze --no-fatal-warnings`, informational diagnostics remain fatal, so the planned text promises success for an info-only result that still exits unsuccessfully. Flutter defines both fatality options with true defaults and checks the severities independently. Derive each severity from the same analyzer command and cover the warnings-only declaration, or use narrowly qualified flag-specific wording that does not make a claim about infos. Sources: [Flutter analyze option definitions](https://raw.githubusercontent.com/flutter/flutter/master/packages/flutter_tools/lib/src/commands/analyze.dart), [Flutter analyzer exit decision](https://raw.githubusercontent.com/flutter/flutter/master/packages/flutter_tools/lib/src/commands/analyze_once.dart).

4. **[P2] Claude — the install-display filter invalidates the stated mixed-policy mitigation.** The `src/install.ts` plan filters effective commands down to those containing `--no-fatal-infos`, then uses `every` to decide that only errors are fatal; Risks claims a mixed relaxed/strict declaration prints the conservative warnings-fatal explanation. The explanation must account for strict analyzer commands too. With inferred precommit `flutter analyze --no-fatal-infos --no-fatal-warnings` and declared finalization `flutter analyze`, the filter drops finalization entirely and prints that only errors are fatal, although finalization still rejects warnings and infos. Evaluating the plan's predicate with that exact pair returns the permissive result. The proposed regression uses an info-relaxed strict-warning command, so it never exercises this omission. Include plain strict analysis in the decision or associate explanations with individual commands, and add that partial-declaration case to the existing onboarding coverage.

All five plans correctly reuse the shared analyzer object to update precommit and finalization, preserve `flutter test`, and align the named tests and documentation. Each proposes reuse of existing test support and avoids new product files, dependencies, or infrastructure. Codex's broader display table remains within the issue's requirement to describe effective policy and uses the existing dry-run fixture; no blocking finding was identified in that bound plan. The other plans' principal implementation scope is appropriate, subject to the concrete map, display, and verification corrections above.

## Conclusion

Request revisions to Cursor, Muse, Claude, and Antigravity for their applicable findings. Codex's bound plan is acceptable as written.

Validation performed: verified the action ID and supplied digest, read all five exported plan artifacts, inspected the existing generator/logger, declaration merge, onboarding fixture, and Vitest configuration, ran the coordinator's approved-path extractor on each plan, and evaluated Claude's specified predicate against the mixed-policy counterexample. Flutter's primary source confirms the independent severity flags. No product suite was run or claimed; this action publishes review evidence only.

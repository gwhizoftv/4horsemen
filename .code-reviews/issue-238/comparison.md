# Issue 238 implementation comparison

## Comparison

Recommend **codex** at `0968ef2b00bd7fa79c910360dc037d2906b1a39b`. All four candidates implement the requested analyzer defaults; Codex also avoids an inaccurate permissive explanation when finalization is declared stricter than precommit.

| Agent | Exact bound implementation pin | Assessment |
| --- | --- | --- |
| claude | `6f585a13e6c88058c917d6c725f37e6092475c05` | Correct generator and warning aggregation; mixed-policy summary still misstates informational fatality. |
| cursor | `b454bb3430e636f3144d19e59b169043b8ab8fd1` | Correct generator; excludes plain strict analysis from the summary decision. |
| antigravity | `94b0da3d60ef3dc5e05b1019b81afb19b6396462` | Correct generator; same summary omission as Cursor. |
| codex | `0968ef2b00bd7fa79c910360dc037d2906b1a39b` | Correct generator, conservative summary, and focused coverage of both kinds of strict override; no blocking finding identified. |

### Findings

1. **[P2] Cursor and Antigravity: `src/install.ts:307`.** A policy summary must include strict analyzer commands when deciding whether warnings can block verification. Both implementations filter out every command lacking `--no-fatal-infos` before applying the warning test. With inferred precommit `flutter analyze --no-fatal-infos --no-fatal-warnings` and declared finalization `flutter analyze`, the strict finalization command disappears from the decision and the summary says only errors are fatal. An owner is therefore told warnings cannot block even though finalization will reject them. The existing declared regression covers only an infos-relaxed command, which survives the filter. Smallest illustrative test: extend the Flutter onboarding declaration to use plain `flutter analyze` for finalization while keeping inferred precommit, then assert that the summary does not claim only errors are fatal or that informational diagnostics do not block.

2. **[P2] Claude: `src/install.ts:307` and `src/install.ts:311`.** The statement that only errors are fatal requires every analyzer command to make both warnings and informational diagnostics nonfatal. The outer condition only requires one Flutter command with `--no-fatal-infos`, and the subsequent `every` checks warnings alone. With inferred precommit carrying both nonfatal flags and declared finalization `flutter analyze --no-fatal-warnings`, the summary says only errors are fatal although finalization still rejects infos. A plain strict finalization instead selects the warning-fatal sentence but still falsely says infos do not block. The new loop at `test/onboard.test.ts:198` checks warning wording for plain strict analysis without asserting info fatality, so it passes with that contradiction. Smallest illustrative test: retain inferred precommit, declare a finalization analyzer without `--no-fatal-infos`, and assert that neither permissive info claim appears in the output.

Flutter independently defaults both severities to fatal and tests each flag separately; changing warning handling does not change informational handling. Sources: [analyzer option definitions](https://raw.githubusercontent.com/flutter/flutter/master/packages/flutter_tools/lib/src/commands/analyze.dart), [analyzer exit decision](https://raw.githubusercontent.com/flutter/flutter/master/packages/flutter_tools/lib/src/commands/analyze_once.dart).

### Scope, reuse, and coverage

The coordinator's supplied changed-path lists show the same five product files for every candidate: `src/setupWorkspace.ts`, `src/install.ts`, `test/verify-config.test.ts`, `test/onboard.test.ts`, and `docs/setup-workspace.md`, plus their coordination evidence. None adds a product file, dependency, helper module, hook change, or unrelated refactor.

All candidates append the exact requested `--no-fatal-warnings` argument to the shared analyzer object in `src/setupWorkspace.ts:278`, which continues to supply precommit and finalization. They preserve `flutter test`, reuse the existing proposal assertions and onboarding/declaration fixtures, and update both the documentation table and Flutter prose.

Cursor and Antigravity extend the existing onboarding case with one infos-relaxed, warning-fatal declaration. Claude adds plain strict finalization to that same regression, but its assertions establish warning behavior only. Codex covers both cases in the existing test, also verifies the persisted declaration and inferred precommit, and asserts the absence of permissive info wording for the plain strict case. Its logger keeps a single explanation, requires a nonempty analyzer set, and emits that explanation only when all analyzers relax infos; otherwise the existing command listing remains the policy description. This is a small guard within the selected logger change, with no new argv parser or per-command output machinery.

### Verification evidence

I read the existing advisory hook observations in the issue's `journal.jsonl` and matched each successful precommit `index` identity to the exact bound implementation tree. These are recorded hook runs, not coordinator-owned final verification, and I did not rerun their suites for this comparison.

| Agent | Bound tree matching successful `pnpm run check:fast` | Journal sequence: precommit / `pnpm run test:e2e` prepush |
| --- | --- | --- |
| claude | `93b5c1c9c699eeb2b101b10a314035a44910af97` | 306 / 309 |
| cursor | `50e955f4558cd607382696a8b12bff4e6b783e3e` | 312 / 326 |
| antigravity | `1be71c36d9c2478e699c5ba72181eac1e10d6c08` | 308 / 319 |
| codex | `f7e4f6604566186483fa923dada8aa3a4f042585` | 345 / 347 |

All listed observations have exit code 0. The prepush records cover the outgoing ranges ending at the corresponding accepted implementation-signal commits. Earlier failed precommit observations exist for Cursor and Codex; later successful observations match the same staged tree identities. In Codex's run, the initial failure was the unrelated status-line fixture reading its output file before the bytes arrived; the focused case, its whole test file, and the unchanged full hook subsequently passed. Codex's prior implementation run also passed the 56 verification-config tests, 11 onboarding tests, and 29 selected documentation checks; the successful hooks reported 843 fast tests, 255 system tests, and 2 e2e tests.

For this comparison I ran only a focused, read-only reproduction: extracted the exact `logProjectPolicy` function from each bound source file, transpiled it with the repository's installed TypeScript, and captured its output for the default, info-relaxed/warning-fatal, plain strict, and warning-relaxed/info-fatal finalization commands, always retaining the inferred permissive precommit. It reproduced both findings. Codex emitted the expected default and warning-fatal explanations and omitted the misleading info-permissive explanation for the latter two cases. No bound source file was modified, and no Flutter SDK or product suite was run for that reproduction.

### Conclusion

Select Codex's bound implementation. The other candidates meet the generator requirement, but their displayed policy can contradict a valid stricter declaration. Keep coordinator final verification at the selected pin as the remaining acceptance gate.

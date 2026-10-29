# Issue 261 — Onboard repos with no finalization checks yet

## Exact File List to be changed or deleted

- `src/state.ts` — relax `checks` from `.min(1)` to allow `[]` in `coordinatorConfigSchema` and `startStateSchema`; allow explicit `checks: []` in `workspaceDeclarationSchema` (omission stays distinct from empty).
- `src/setupWorkspace.ts` — `buildWorkspaceConfig`: stop throwing when the resolved `checks` is an explicitly opted-in empty array; keep throwing when neither declared nor inferred and no opt-in was given, with the remedy now naming both `--declare { "checks": [...] }` and the deferred option. `proposeToolchainPolicy`: add marker-only branches for Xcode (`*.xcodeproj`/`*.xcworkspace`/`Package.swift`) and CMake (`CMakeLists.txt`) that set `toolchain` and critical files but invent no commands.
- `src/install.ts` — thread the opt-in (`allowNoChecks`) through `InstallOptions`/`OnboardOptions` into `buildWorkspaceConfig`; `logProjectPolicy` prints `finalization: none (deferred)` for the empty state.
- `src/doctor.ts` — new `finalizationUndeclared` finding (new `DOCTOR_CODES` entry) warning when `checks` is `[]`, with the re-declare remedy; non-blocking warning, not an install failure.
- `src/cli.ts` — accept `--allow-no-checks` on `install` and `onboard`, show it in usage text, and print a start-time warning when a frozen issue starts with `checks: []`.
- `test/verify-config.test.ts`, `test/install.test.ts`, `test/doctor.test.ts`, `test/onboard.test.ts` — extend in place (see Tests).
- `docs/setup-workspace.md` — product-language table rows for the Xcode/CMake markers, the deferred-checks state, and the upgrade-by-re-declare flow.

No file is deleted.

## Exact file list to be created

- None. No new source, test, or doc file; every change extends an existing file.

## Reuse and Scope

Reuse, do not replace:

- `workspaceDeclarationSchema` / `--declare <file.json>` as the update path: onboarding with no checks writes `checks: []`; once a real test exists, re-running `coord install --declare` (or `coord onboard --declare`) with real `checks` rewrites the config through the existing `writeWorkspaceConfig` diff. No new `coord config` command.
- `buildWorkspaceConfig` + `coordinatorConfigSchema.parse` as the single construction/validation boundary, and `proposeProjectPolicy` as the only ecosystem-detection site; hooks keep executing recorded policy and never sniff the tree.
- `runVerification`'s existing empty-command pass and `selectVerification`/`selectCandidateVerification` returning `[]` for coordination-only changes: an empty final gate already passes without running anything, so no runner change is needed beyond the start-time warning and journal visibility.
- The `verify` opt-out precedent (`{ "precommit": [], "prepush": [] }`): explicit empty means consent, absent means fail-closed. `checks: []` gets the same meaning; the installer never writes it unless the operator opted in via `--allow-no-checks` or an explicit `"checks": []` declaration.
- `doctor`'s finding/exit-code machinery for the deferred-state warning, mirroring `verifyUndeclared`.
- Start-state freezing (`checks: config.checks` copied into `start.json`): a mid-issue reinstall that adds checks affects the next issue, never a running one.

Scope limits: no `xcodebuild` scheme guessing (scheme/target names are unknowable from markers), no auto-detection of test commands for C++/ObjC/Swift beyond toolchain labeling, no change to `verify` semantics, no config-format migration (old configs with ≥1 check parse unchanged; `[]` is already valid JSON in the same field).

## Tests

Fewest focused tests, each failing before and passing after, joining existing files:

- `test/verify-config.test.ts` (installer proposals): Xcode/CMake marker trees propose the labeled toolchain with `checks: undefined`; `coordinatorConfigSchema` accepts `checks: []` and still rejects a missing `checks` field; `buildWorkspaceConfig` accepts an explicit empty declaration and still throws when checks are neither declared, inferred, nor opted-in.
- `test/install.test.ts`: a `plain` fixture installed with `allowNoChecks` succeeds and writes `checks: []` (replacing today's blanket refusal for the opted-in case only); the existing verify-only-without-opt-in refusal test keeps passing; a second install with real declared checks upgrades the stored config from `[]` to those checks.
- `test/doctor.test.ts`: a workspace with `checks: []` yields exactly the `finalizationUndeclared` warning finding and still exits 0 overall when nothing else is wrong.
- `test/onboard.test.ts`: `coord onboard` of a marker-only Xcode-style fixture with the flag completes end-to-end (install + doctor) instead of throwing `Cannot infer finalization checks`.

Run: `pnpm check:fast` (lint, typecheck, fast + system tests; the precommit hook already owns it at commit time — do not duplicate it manually), plus the four focused files above via `pnpm vitest run --config vitest.config.ts <file>` while developing.

## Alternatives Rejected

- Keep refusing and only improve the error/docs: rejected — the issue requires onboarding to succeed with no finalizing test, not a better refusal.
- Invent an `xcodebuild`/`ctest` finalization command from markers: rejected — scheme, destination, and target names cannot be inferred; a guessed command fails hermetically at finalization time, worse than an honestly empty gate.
- Sentinel placeholder check (e.g. `["true"]`): rejected — it fakes a green tier-3 gate and hides the missing suite from doctor and the journal.
- New `coord config set-checks` command: rejected — reinstall with `--declare` already rewrites config idempotently; a second mutation path duplicates validation.
- Auto-write `checks: []` whenever inference finds nothing, with no opt-in: rejected — it signs the operator's opt-out on their behalf, the exact failure mode the `verify` proposal rules exist to prevent; a silent empty gate would let finalization pass for every later typo'd declaration too.

## Risks and Mitigations

- Risk: an operator forgets the deferred state and ships issues whose final gate runs nothing. Mitigation: doctor warning, install-time `finalization: none (deferred)` line, and a start-time warning on every issue started while `checks` is `[]`; the state is grep-able in config as `"checks": []`, never hidden.
- Risk: relaxing `.min(1)` lets other constructors persist empty checks accidentally. Mitigation: `buildWorkspaceConfig` remains the only writer and still throws without an explicit opt-in; schema acceptance only makes the recorded state parseable.
- Risk: candidate verification with empty `checks` silently passes product pins. Mitigation: this only occurs inside the explicitly deferred workspace state, and the start warning names it; declaring real checks later restores full candidate + final gates with no code change.
- Risk: marker-only Xcode/CMake branches mislabel polyglot repos. Mitigation: branches sit below the existing Cargo/Go/Node/Make/Flutter/Python priorities and only label toolchain/critical files; they propose no commands, so a mislabel cannot weaken any gate.

## Conclusion

Adopt explicit-empty `checks` as the recorded "finalization not yet declared" state: opt in at onboard/install, warn in doctor and at issue start, pass the (empty) final gate honestly, and upgrade later by re-declaring real checks through the existing reinstall path. This onboards C++/Objective-C/Swift and brand-new repos today, keeps fail-closed behavior for everyone who did not opt in, and adds no new command, file, or config format.

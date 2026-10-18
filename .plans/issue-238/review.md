# Issue 238 — plan review (claude)

Reviewed plans (bound pins):

- cursor `906c261150c48bfe2671010c4a2b1ef6425d9b4d`
- muse `9ab54576c173c0b47da66e2cbe02c5122a3fd6af`
- claude `9f7d9207003e367a3fcc7df2f7c4ee7c5d5d1b7e`
- codex `baccd4b9c16a97f2f3715377d7d7d9521e18cc90`
- antigravity `0cc8e654282591984cea541cf79a18106ade04f1`

All five plans agree on the core change. The shared Flutter `analyze` object in
`proposeToolchainPolicy` (`src/setupWorkspace.ts:278`) gets the exact argv from
the issue, `["flutter", "analyze", "--no-fatal-infos", "--no-fatal-warnings"]`.
`flutter test` stays as it is. The expected argv changes in
`test/verify-config.test.ts:185` and `test/onboard.test.ts:153`. The table row
at `docs/setup-workspace.md:545` and the prose at lines 579–581 are updated.
Every plan stays within the five files the issue names and creates no product
files. The plans differ on how `src/install.ts` decides which explanation to
print and on how that decision is tested.

## Findings

### F1 — antigravity: the explanation for `--no-fatal-warnings` alone is false

- **Plan claim:** the `src/install.ts` section's third branch: "When
  `--no-fatal-warnings` is present without `--no-fatal-infos`: `--no-fatal-warnings
  leaves only analyzer errors fatal; warnings do not block.`"
- **Rule:** the issue requires the displayed explanation to reflect which
  severities are fatal in the effective command. Flutter's
  `--[no-]fatal-infos` and `--[no-]fatal-warnings` are independent flags, and
  both are fatal by default. Without `--no-fatal-infos`, informational
  diagnostics still fail the run.
- **Failure:** an owner declares
  `{ name: "analyze", argv: ["flutter", "analyze", "--no-fatal-warnings"] }`.
  The install summary says that only errors are fatal, yet
  `flutter analyze --no-fatal-warnings` still exits non-zero on any info-level
  lint. The owner is told commits will not be blocked by diagnostics that do
  block them. No planned test covers this branch, so the false text would ship
  unnoticed.
- **Smallest correction:** drop the third branch so the existing
  `--no-fatal-infos` gate prints nothing for this case, or make it say infos
  remain fatal. Either way, add one assertion if the branch is kept.

### F2 — antigravity: the plan names a function that does not exist

- **Plan claim:** Exact File List / Reuse and Scope:
  "In `reportVerificationPolicy` (lines 305–310)", and lists
  `reportVerificationPolicy, install, and onboard in src/install.ts`.
- **Rule:** Reuse and Scope must name the existing functions it reuses.
- **Failure:** `src/install.ts` has no `reportVerificationPolicy`. The
  explanation is built in `logProjectPolicy` (`src/install.ts:268`). An
  implementer or reviewer who looks for the named function finds nothing. That
  makes the reuse claim unverifiable, and the line range is the only reliable
  anchor.
- **Smallest correction:** replace it with `logProjectPolicy`.

### F3 — cursor, muse: the strict-explanation branch is not tested

- **Plan claim:** cursor and muse both make the `src/install.ts` explanation
  depend on whether `--no-fatal-warnings` is present and keep the old wording
  for declared `--no-fatal-infos`-only commands. cursor's Risks section says
  "install summary stays accurate by branching on the flag", and muse's says
  "keeping the current warnings-fatal wording for that case". Neither Tests
  section exercises that case. Both test only the inferred default.
- **Rule:** the issue requires the explanation to reflect whether warnings are
  fatal. A conditional added for that purpose needs a test on each side, or
  the safety claim in Risks is untested. That means one focused assertion in
  the existing onboard case's `--declare` re-run.
- **Failure:** an implementation that always prints the relaxed sentence
  ("only errors are fatal; warnings … do not block") whenever
  `--no-fatal-infos` is present passes every test both plans list. A
  declared `["flutter", "analyze", "--no-fatal-infos"]` policy would then
  report warnings as non-fatal while `flutter analyze` still fails on them.
  That is exactly the misreport both plans say they guard against.
- **Smallest correction:** in the existing
  `onboards %s without declarations and reports the effective policy` case,
  next to the existing `if (language === "python")` declared re-run, add a
  Flutter branch. It declares `checks: [{ name: "analyze", argv: ["flutter", "analyze", "--no-fatal-infos"] }]`
  and asserts that the summary contains the warnings-fatal sentence. The claude
  and antigravity plans both already do this.

### F4 — cursor, muse: the focused test command never runs `test/onboard.test.ts`

- **Plan claim:** cursor's Tests section says
  "`pnpm vitest run test/verify-config.test.ts test/onboard.test.ts`". Muse's
  Tests section says
  "`pnpm exec vitest run --config vitest.config.ts test/verify-config.test.ts test/onboard.test.ts`".
- **Rule:** the focused development commands must actually run the edited
  cases, and plans must name real commands. `vitest.config.ts` is the default
  config, and it lists `test/onboard.test.ts` in `exclude`. That file runs only
  under `vitest.system.config.ts`.
- **Failure:** I ran
  `pnpm exec vitest run --config vitest.config.ts test/onboard.test.ts` on this
  clone. It printed "No test files found, exiting with code 1", and the
  exclude list shows `test/onboard.test.ts`. When `verify-config.test.ts` is
  passed alongside it, as both plans do, the run succeeds while silently
  skipping every onboard assertion: the argv at line 153, the summary text at
  line 165, and any new declared case. The implementer then believes the
  explanation change is verified when it is not. The hook's `pnpm check:fast`
  catches the failure only at commit time.
- **Smallest correction:** run it as two commands:
  `pnpm exec vitest run --config vitest.config.ts test/verify-config.test.ts`
  and `pnpm exec vitest run --config vitest.system.config.ts test/onboard.test.ts`.
  codex, antigravity and claude already do this.

### F5 — codex: the explanation logic goes beyond what the issue asks

- **Plan claim:** the `src/install.ts` item says to "Handle the four
  combinations of the two nonfatal flags … explicit positive counterparts, if
  present, take precedence according to their last occurrence in that
  command's argv", to give per-command explanations for local and final
  policies that differ, and to "Scope these explanations to the analyzer
  subcommand". Tests item 3 adds a table covering both flags, each flag alone,
  neither flag, a mixed local/final declaration, and an
  explicit-positive override row.
- **Rule:** AGENTS.md "Implementation discipline" calls for the smallest change
  that fully solves the issue, with no speculative flexibility and only the
  fewest focused tests. The issue asks only that the displayed explanation
  reflect whether warnings are fatal.
- **Failure:** if this is followed as written, `logProjectPolicy` gains a
  small argv parser with last-occurrence `--fatal-*` / `--no-fatal-*`
  precedence. That is behavior coord never generates, and the issue never
  mentions it. It also changes the existing gate from "any `flutter` command
  with `--no-fatal-infos`" to analyzer subcommand matching, and it adds
  per-command output and a test table of six or more rows. The result is
  several times the code and tests the issue needs. Each extra rule is also
  another claim about Flutter's flag parsing that the fixture cannot check,
  because the plan explicitly avoids "simulating Flutter's analyzer
  implementation". A wrong precedence assumption would print false text with
  tests that still pass.
- **Smallest correction:** keep the existing `--no-fatal-infos` gate and
  choose between the two sentences by whether `--no-fatal-warnings` is present.
  Cover the relaxed default plus one declared strict case in the existing
  onboard case, as in F3.

### F6 — claude: the generator function is misnamed

- **Plan claim:** the Exact File List says "Flutter branch of
  `proposeProjectPolicy`", and Reuse and Scope says "the Flutter branch of
  `proposeProjectPolicy` (`src/setupWorkspace.ts`)".
- **Rule:** Reuse and Scope must name the existing function correctly.
- **Failure:** the Flutter branch is in the private `proposeToolchainPolicy`
  (`src/setupWorkspace.ts:207`). `proposeProjectPolicy`
  (`src/setupWorkspace.ts:304`) is the exported wrapper that calls it. The
  line anchor (278) is still correct, so the edit lands in the same place,
  but the named reuse target is wrong. This is minor and non-blocking.
- **Smallest correction:** say `proposeToolchainPolicy`, called through
  `proposeProjectPolicy`.

### Scope, reuse and test focus (all plans)

- **Scope:** every plan is limited to the five files the issue names. None
  creates a product file, adds a dependency, migrates existing configs or
  bumps the version. codex's logger expansion (F5) is the only expansion
  beyond what the issue asks.
- **Reuse:** every plan reuses the shared `analyze` object, `effectiveCommands`
  in `logProjectPolicy`, and the existing Flutter cases in
  `test/verify-config.test.ts` and `test/onboard.test.ts`. No plan adds a test
  file or fixture.
- **Focused tests:** cursor and muse under-test the new conditional (F3).
  codex over-tests speculative combinations (F5). claude and antigravity add
  one declared-strict assertion to the existing onboard case, which is the
  proportionate amount.
- **Mixed declarations:** claude's `every` rule prints the warnings-fatal
  sentence when any `--no-fatal-infos` command keeps warnings fatal. Its
  planned declared case is `checks` declared strict with `verify` inferred
  relaxed, which is exactly that mixed input, so the rule is exercised.

## Conclusion

cursor and muse are acceptable but need revision. Both leave the new
explanation conditional untested (F3), and both name a focused command that
silently skips `test/onboard.test.ts` (F4). antigravity's structure is right
and it includes the strict-case test, but its third branch prints a false
"only errors are fatal" claim for `--no-fatal-warnings` alone (F1), and it
names a function that does not exist (F2). codex is correct on the core change
but over-builds the explanation logic and its tests beyond what the issue asks
(F5). claude's plan has one minor naming error (F6) and otherwise meets the
issue with the smallest tested change. I recommend claude's plan, with F6
corrected, as the basis for implementation. It reuses the existing
`--no-fatal-infos` gate, chooses between two sentences by whether
`--no-fatal-warnings` is present, and adds one declared-strict assertion in the
existing onboard case. Its focused commands run each file under the config
that includes it.

Checks I ran for this review: only
`pnpm exec vitest run --config vitest.config.ts test/onboard.test.ts`, to
confirm F4 (exit 1, "No test files found"). I ran no product suite. Final
checks are coordinator-owned.

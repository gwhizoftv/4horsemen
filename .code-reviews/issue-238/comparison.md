# Issue 238 implementation comparison (claude)

Bound implementation pins compared:

- claude `6f585a13e6c88058c917d6c725f37e6092475c05`
- cursor `b454bb3430e636f3144d19e59b169043b8ab8fd1`
- antigravity `94b0da3d60ef3dc5e05b1019b81afb19b6396462`
- codex `0968ef2b00bd7fa79c910360dc037d2906b1a39b`

I read the bound worktrees directly and diffed each peer's five product files
against the claude worktree.

## Comparison

### What is identical

- **Generator:** `src/setupWorkspace.ts:278` is byte-identical in all four
  pins. The shared `analyze` argv is
  `["flutter", "analyze", "--no-fatal-infos", "--no-fatal-warnings"]`. It still
  feeds `verify.precommit` and `checks`, and `flutter test` is unchanged. This
  meets the issue's core requirement in every pin.
- **Generator test:** `test/verify-config.test.ts:185` is byte-identical in all
  four pins, updated to the new argv.
- **Onboard default expectations:** `test/onboard.test.ts:153` (argv) and
  `:165` (summary contains
  `"warnings and informational diagnostics do not block"`) are identical in
  all four pins.
- **Docs table:** `docs/setup-workspace.md:545` is identical in all four pins.
- **Scope:** every pin touches only the five approved product files plus its
  own coordination artifacts. None adds files, helpers, dependencies or
  refactors, and none changes `dist/`.

### Where they differ: the `src/install.ts` explanation predicate

`effectiveCommands` is `verify.precommit + verify.prepush + checks`. The
relevant input is a partial declaration that overrides only `checks`. Then
precommit keeps the inferred relaxed analyzer, while finalization runs the
declared one. I evaluated each pin's predicate on three inputs. "Default"
means no declaration. "Mixed-plain" means `checks` is declared as
`flutter analyze`. "Mixed-infos" means `checks` is declared as
`flutter analyze --no-fatal-infos`.

| Pin | default | mixed-plain | mixed-infos |
| --- | --- | --- | --- |
| claude | only-errors sentence | warnings-fatal sentence (also says infos do not block) | warnings-fatal sentence |
| cursor | only-errors sentence | **only-errors sentence** | warnings-fatal sentence |
| antigravity | only-errors sentence | **only-errors sentence** | warnings-fatal sentence |
| codex | only-errors sentence | no analyzer line | warnings-fatal sentence |

The two sentences are:

- only-errors: `--no-fatal-infos --no-fatal-warnings leave only analyzer errors fatal; warnings and informational diagnostics do not block.`
- warnings-fatal: `--no-fatal-infos leaves analyzer warnings and errors fatal; informational diagnostics do not block.`

#### C1 — cursor and antigravity: a strict finalization analyzer is reported as relaxed

- **Location:** `src/install.ts:307`, in both the cursor and the antigravity
  pins (their code is identical):
  `const relaxed = effectiveCommands.filter((check) => check.argv[0] === "flutter" && check.argv.includes("--no-fatal-infos"));`
  followed by `relaxed.every((check) => check.argv.includes("--no-fatal-warnings"))`.
- **Rule:** the issue requires the displayed explanation to reflect whether
  warnings are fatal. The relaxed sentence must not print while any effective
  `flutter analyze` gate keeps warnings fatal.
- **Failure:** onboard a Flutter product with
  `--declare` `{ "checks": [{ "name": "analyze", "argv": ["flutter", "analyze"] }] }`.
  Precommit keeps the inferred relaxed analyzer. The filter drops the plain
  finalization command because it lacks `--no-fatal-infos`. The summary then
  prints "leave only analyzer errors fatal; warnings and informational
  diagnostics do not block", yet finalization runs plain `flutter analyze`,
  which fails on any warning or info. The owner is told finalization will
  accept warnings when it rejects them. This is the counterexample Codex's plan
  review raised. Neither pin's new test covers it: both declare only
  `["flutter", "analyze", "--no-fatal-infos"]`, which the filter keeps.
- **Smallest test:** in the existing Flutter `--declare` branch of
  `test/onboard.test.ts`, declare
  `checks: [{ name: "analyze", argv: ["flutter", "analyze"] }]` and assert that
  the output does not contain `"leave only analyzer errors fatal"`. Both
  cursor and antigravity fail this. The claude and codex pins already include
  this case.

#### C2 — claude: a strict finalization analyzer still gets the "infos do not block" claim

- **Location:** `src/install.ts:307–309` in the claude pin. The outer gate is
  still
  `effectiveCommands.some((check) => check.argv[0] === "flutter" && check.argv.includes("--no-fatal-infos"))`.
  The inner check ranges over all `flutter analyze` commands and only chooses
  between the two sentences.
- **Rule:** the explanation must not claim that any severity is non-blocking
  when some effective analyzer gate keeps it fatal.
- **Failure:** in the same mixed-plain declaration as C1, the claude pin
  correctly avoids the only-errors sentence. It prints the warnings-fatal
  sentence instead, which ends "informational diagnostics do not block". The
  declared finalization `flutter analyze` still fails on infos, so that half
  of the line is false for the finalization gate. The baseline printed that
  same sentence for this input, so this is not a regression. It is still less
  accurate than codex, which prints no analyzer line for this input. The
  claude test's mixed-plain case asserts only `"leaves analyzer warnings and
  errors fatal"` and the absence of the only-errors sentence, so it does not
  catch the infos claim.
- **Smallest test:** in the claude pin's mixed-plain iteration, add
  `expect(output.join("")).not.toContain("informational diagnostics do not block")`.
  The claude pin fails it and the codex pin passes it, since the codex test
  already has this exact assertion. The fix is codex's predicate: print a line
  only when every `flutter analyze` command has `--no-fatal-infos`.

#### codex — accurate in every case evaluated

- **Location:** `src/install.ts:307–312` in the codex pin. It filters to
  `flutter analyze` commands and prints the explanation only when
  `analyze.length > 0 && analyze.every((check) => check.argv.includes("--no-fatal-infos"))`.
  It then chooses the sentence by `every(... "--no-fatal-warnings")`.
- Both sentences are now claims about every analyzer gate, so neither can
  overstate leniency for a stricter stage. The `length > 0` guard also avoids
  the vacuous `every([])` case, where a `--no-fatal-infos` flag on some
  non-analyze Flutter command would otherwise print the relaxed sentence. That
  case exists in the claude pin, though it is practically unreachable.
- The plan reviews rejected the codex plan's last-occurrence `--fatal-*`
  parsing and its combinatorial test table. Neither was implemented: the
  implementation is the same size as the others.

### Tests

Every pin extends the existing
`onboards %s without declarations and reports the effective policy` case. No
pin adds a test file or fixture.

- **cursor:** adds an `if (language === "flutter")` block after the Python
  block. It contains one infos-only declared case, so it misses C1.
- **antigravity:** adds an `else` branch with the same single infos-only case,
  so it also misses C1.
- **claude:** adds an `else` loop over the infos-only and plain declared
  cases. It catches C1, but its plain case does not assert the infos claim
  (C2).
- **codex:** adds a Flutter block before the Python block with the same two
  cases. It also asserts the persisted `checks` / `verify.precommit` split,
  the `finalization (declared)` rendering, the absence of
  `"informational diagnostics do not block"` for the plain case, and that no
  Flutter tool was executed. The assertions are slightly more numerous but
  every one is on the behavior under change, so the coverage stays focused.

### Docs (`docs/setup-workspace.md:579–581`)

- **All four:** state that the default leaves only errors fatal.
- **codex:** gives the precise override recipes:
  `flutter analyze --no-fatal-infos` for fatal warnings, and plain
  `flutter analyze` for fatal warnings and infos. It adds that existing
  workspaces adopt the default on reinstall or re-onboarding while retained
  declarations still override it. These are two extra sentences, both
  accurate and both relevant to the default change.
- **claude and cursor:** describe the overrides correctly in terms of
  omitting each flag.
- **antigravity:** says "without `--no-fatal-warnings` or `--no-fatal-infos`
  to enforce those too". That is slightly ambiguous about which omission
  enforces which severity, but not wrong.

### Ranking

1. **codex `0968ef2b00bd7fa79c910360dc037d2906b1a39b`:** the only pin whose
   explanation is accurate for the default, an infos-only declaration and a
   plain strict declaration. Its tests pin all three cases, and it stays
   within the five files.
2. **claude `6f585a13e6c88058c917d6c725f37e6092475c05`:** never prints the
   false only-errors claim. C2 leaves a pre-existing inaccurate infos claim
   for mixed-plain declarations.
3. **cursor `b454bb3430e636f3144d19e59b169043b8ab8fd1`** and
   **antigravity `94b0da3d60ef3dc5e05b1019b81afb19b6396462`** (tied, identical
   `src/install.ts`): C1 prints "only errors fatal" for a strict finalization
   gate, which is the misreport the issue's display requirement exists to
   prevent, and their tests do not cover it.

I recommend codex's pin as the implementation to accept.

Checks I ran for this comparison: `diff -u` of each peer's five product files
against the claude worktree, and a Node evaluation of each pin's
`src/install.ts` predicate on the default, mixed-plain and mixed-infos inputs.
I did not run any product test suite on the peer pins, and I claim no
coordinator-owned checks.

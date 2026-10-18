# Review — issue 238 peer plans

Bound plans reviewed: cursor `906c261150c48bfe2671010c4a2b1ef6425d9b4d`,
muse `9ab54576c173c0b47da66e2cbe02c5122a3fd6af`,
claude `9f7d9207003e367a3fcc7df2f7c4ee7c5d5d1b7e`,
codex `baccd4b9c16a97f2f3715377d7d9521e18cc90`,
antigravity `0cc8e654282591984cea541cf79a18106ade04f1`.
All five identify the correct core change: the shared `analyze` object at
`src/setupWorkspace.ts:278` gains `--no-fatal-warnings`, the two expected
argv sites and the docs follow, `flutter test` is unchanged, no plan
invents a product file, and all reuse the existing Flutter branch, the
existing tests, and the existing install summary rather than adding an
abstraction. The findings below are the differences that matter.

## Findings

1. **Cursor plan, Tests section; muse plan, Tests section — the named
   focused command never runs the onboard test.**
   The rule that must hold: a plan's named validation command must
   actually execute every test file it claims as fail-before/pass-after
   evidence.
   Concrete failure: cursor names `pnpm vitest run
   test/verify-config.test.ts test/onboard.test.ts` and muse names
   `pnpm exec vitest run --config vitest.config.ts
   test/verify-config.test.ts test/onboard.test.ts`, but
   `vitest.config.ts` explicitly excludes `test/onboard.test.ts` (it runs
   under `vitest.system.config.ts`). Verified directly: that command
   reports `No test files found, exiting with code 1` for
   `test/onboard.test.ts`, so the onboard half of both plans produces no
   evidence and the implementer is left with a failing command.
   Smallest correction: split the commands as the claude, codex, and
   antigravity plans do —
   `pnpm exec vitest run --config vitest.config.ts test/verify-config.test.ts`
   and `pnpm exec vitest run --config vitest.system.config.ts test/onboard.test.ts`.

2. **Antigravity plan, Exact File List (`src/install.ts` bullet) and Reuse
   and Scope — it names a function that does not exist.**
   The rule that must hold: a plan's reuse claims must name existing
   functions, so the implementer edits the real code instead of
   re-creating it.
   Concrete failure: the plan twice names `reportVerificationPolicy` in
   `src/install.ts`; there is no such symbol — the explanation lives in
   `logProjectPolicy` (`src/install.ts:268`, Flutter branch at lines
   305–310). Followed literally, the implementer searches for a missing
   function and can stall or introduce a duplicate reporter beside the
   real one.
   Smallest correction: replace both mentions with `logProjectPolicy`.

3. **Antigravity plan, Exact File List (`src/install.ts` bullet) — the
   warnings-only explanation sentence states the wrong fatality.**
   The rule that must hold: the displayed explanation must reflect, per
   severity, whether that severity is fatal for the effective command —
   that is the whole point of the `src/install.ts` change in the issue.
   Concrete failure: for `--no-fatal-warnings` without `--no-fatal-infos`
   the plan prescribes `--no-fatal-warnings leaves only analyzer errors
   fatal; warnings do not block.` Informational diagnostics are relaxed
   only by `--no-fatal-infos` (the current line at `src/install.ts:308`
   exists precisely because infos need that flag), so in that combination
   infos remain fatal and the sentence tells the operator the opposite;
   the plan's own extended onboard case would then pin false output.
   Smallest correction: either drop the third branch, or word it
   `leaves analyzer errors and informational diagnostics fatal; warnings do not block.`

4. **Codex plan, Exact File List item 2 and Tests item 3 — the install
   explanation is expanded into a per-command flag parser beyond the
   issue.**
   The rule that must hold: the plan must stay within the issue and make
   the smallest change that fully solves it, with only focused tests; the
   issue asks only that the displayed explanation reflect whether
   warnings are fatal for the new default.
   Concrete failure: the plan requires handling all four flag
   combinations per individual command, associating explanations with
   commands via the existing rendering, honouring explicit positive
   counterparts (`--fatal-warnings`/`--fatal-infos`) by last occurrence
   in argv, and a declared-policy test table covering both-flags,
   info-only, warning-only, neither, mixed local/final, and an
   explicit-positive row. Nothing in the generator, the tests, or the
   docs produces a positive flag form, so the implementer must invent
   parsing precedence and output format for inputs the issue never
   names, and grow `test/onboard.test.ts` well past the two expectation
   updates the issue lists — scope, review surface, and failure modes
   the issue did not ask for.
   Smallest correction: keep the explanation keyed on the two cases the
   issue creates (new default with both flags; declared infos-only
   keeping warnings fatal), cover at most one declared-strict case in
   the existing onboard test as the claude plan does, and delete the
   last-occurrence, per-command, and mixed-policy requirements.

5. **Claude plan, Exact File List (`test/onboard.test.ts` bullet) — the
   declared-strict branch is under-specified at the one step that makes
   it run.**
   The rule that must hold: a test addition must state its trigger
   mechanically enough that following it literally exercises the new
   branch; a declaration written but never submitted proves nothing.
   Concrete failure: the plan says to declare
   `checks: [{ name: "analyze", argv: ["flutter", "analyze", "--no-fatal-infos"] }]`
   and assert on the summary, but does not state that the branch must
   overwrite the same declaration path the existing `declaration`
   variable points at, clear `output`, and re-run
   `runCli([...argv, "--declare", declaration], ...)` the way the
   neighbouring python block (`test/onboard.test.ts:180–196`) does.
   Written without that re-run, the assertions read the previous
   inferred-policy output, which contains the relaxed sentence, so the
   `does not contain "leave only analyzer errors fatal"` assertion fails
   for a reason unrelated to the implementation.
   Smallest correction: add one sentence naming the overwrite, the
   `output.length = 0` reset, and the `runCli` re-run with the same
   `declaration` path.

6. **Claude plan, opening paragraph and Exact File List — the Flutter
   branch is attributed to the wrong function (minor).**
   The rule that must hold: reuse claims should name the function that
   actually owns the cited lines, as in finding 2.
   Concrete failure: the plan places line 278 in
   `proposeProjectPolicy`; that branch is in `proposeToolchainPolicy`
   (`src/setupWorkspace.ts:207`), and `proposeProjectPolicy`
   (`src/setupWorkspace.ts:304`) only wraps it. The cited file and line
   are right, so an implementer still lands on the correct edit, but the
   named owner is wrong.
   Smallest correction: name `proposeToolchainPolicy` for the branch and
   keep `proposeProjectPolicy` as the public entry the tests call.
   The muse plan's Tests wording has the same class of slip in miniature
   (the shared pair is asserted against `verify.precommit` and `checks`;
   `verify.prepush` holds only `test`), with no effect on its coverage
   conclusion.

## Conclusion

No bound plan is wrong on the core change, and none expands the product
file map beyond the five files the issue names, invents a file, or adds
a dependency. The claude plan (`9f7d9207003e367a3fcc7df2f7c4ee7c5d5d1b7e`)
is the strongest basis for implementation — correct split test
commands, the exact flag-aware sentence retaining the asserted
substring, and declared-strict coverage — once findings 5 and 6 are
corrected. The muse (`9ab54576c173c0b47da66e2cbe02c5122a3fd6af`) and
cursor (`906c261150c48bfe2671010c4a2b1ef6425d9b4d`) plans become
acceptable after the finding-1 command split. The antigravity plan
(`0cc8e654282591984cea541cf79a18106ade04f1`) must not be followed as
written until findings 2 and 3 are fixed. The codex plan
(`baccd4b9c16a97f2f3715377d7d9521e18cc90`) should be reduced per
finding 4 before use; its generator, docs, and first two test items are
sound. Recommendation: implement from the claude plan with the two
small corrections above.

# Issue 261 plan review (claude)

Bound inputs reviewed:
- muse plan `8b78468a623f703332f004a9c98f50ceaee71e16` (.plans/issue-261/plan.md)
- claude plan `daa87d045eafce23b9ee9532f64e6ec8ce253334` (.plans/issue-261/plan.md)
- codex plan `f1d01874ea5d2ccda3d0d07259113c9f9537c8ad` (.plans/issue-261/plan.md)

The authority for scope is the issue body together with the owner's design
comment (issuecomment-6483409830). The body says "Use the comment to guide the
design plan and implementation". The comment requires all of the following:

- guided discovery with source labels;
- CMake/Xcode command sequences;
- a commit/PR timing question;
- saving to the existing config with explicit > saved > detected precedence;
- empty lists everywhere, with the wording "Automated checks skipped: none configured.";
- agent-proposed additive checks reviewed with the implementation, bound to the effective policy, and persisted for future issues with baseline-gated activation.

To evaluate each file map, I ran the coordinator's own `extractApprovedPaths`
(built `dist/evidence.js`) over each bound plan. I also read the vitest
partitions and the existing tests that assert today's refusal.

## Findings

### muse `8b78468a623f703332f004a9c98f50ceaee71e16`

**M1 (blocking): the plan addresses only the issue body, not the owner's design comment.**
- *Plan claim.* Conclusion and Reuse: "Adopt explicit-empty checks … opt in at onboard/install … upgrade later by re-declaring real checks through the existing reinstall path". Scope limits: "no auto-detection of test commands for C++/ObjC/Swift beyond toolchain labeling".
- *Rule.* The owner comment requires:
  - guided discovery and selection of runnable build/test commands (items 1–2);
  - a timing question (item 3);
  - "Normal onboarding requires no JSON authoring, example-file search or `--declare`" (item 4);
  - agent-proposed checks adopted "without requiring re-onboarding" (item 5).
- *Failure.* Followed as written, the plan delivers none of items 1, 2, 3 or 5. The upgrade path is "re-run `coord install --declare` with real checks", which is exactly the JSON authoring and re-onboarding the comment forbids. Every acceptance item about native plans, configure/build/test order, timing, proposals, effective-policy binding and future activation goes unimplemented.
- *Smallest correction.* Re-plan against the comment's six items.

**M2 (blocking): the default onboarding still fails exactly as reported.**
- *Plan claim.* `src/setupWorkspace.ts` "keep throwing when neither declared nor inferred and no opt-in was given"; the opt-in is a new `--allow-no-checks` flag.
- *Rule.* "A first-time project with no recognized command gets clearly announced empty settings." The issue reporter ran plain `coord onboard` on a C++/Objective-C/Swift repository.
- *Failure.* `coord onboard <finalerev>` without the new flag still throws `Cannot infer finalization checks for finalerev`. The marker-only Xcode/CMake branches propose `checks: undefined`, so the reported failure is unchanged for the reporter's exact command.

**M3: the reporting wording differs from what the issue requires.**
- *Plan claim.* `logProjectPolicy` prints `finalization: none (deferred)`, plus a doctor warning.
- *Rule.* No-checks must report "Automated checks skipped: none configured.", and a build-only selection must be reported as a build result.
- *Failure.* Owners and tests see different wording from the required message. Nothing labels build-only results, because the plan has no build-only selection.

**M4: the file map approves stray product-root paths.**
- *Plan claim.* `proposeToolchainPolicy` branch text backticks `CMakeLists.txt` and `Package.swift`.
- *Rule.* Every backticked path outside Reuse becomes an approved implementation path (repo map: "The file map is extracted from backticked paths anywhere in the plan").
- *Failure.* `extractApprovedPaths` returns `CMakeLists.txt` and `Package.swift` as approved root files, which lets an implementation add those files to this repository unreviewed.

**M5: one development command runs no tests.**
- *Plan claim.* Tests: "plus the four focused files above via `pnpm vitest run --config vitest.config.ts <file>`".
- *Rule.* The named command must actually run the named tests. `vitest.config.ts` excludes `test/install.test.ts` and `test/onboard.test.ts`, which run only under `vitest.system.config.ts`.
- *Failure.* The documented focused command reports no test files for two of the four suites. A developer following it believes those tests passed.

### codex `f1d01874ea5d2ccda3d0d07259113c9f9537c8ad`

The plan covers every item of the owner comment. Its file map is clean: the extractor returns only the intended `src/`, `test/` and doc paths. It correctly lists `test/install.test.ts`, whose two existing `Cannot infer finalization checks` assertions (lines 551 and 741) must change. It also lists `src/materializedInputs.ts`, so reviewers can read proposal bytes (see C1-self below, where my own plan has this gap). Both new modules are justified. Its focused commands match the real vitest partitions.

**X1: future activation goes beyond the issue's rule and can leave checks pending.**
- *Plan claim.* Section 5: activation requires that "the authorized introducing pin (or a previously verified activation baseline) is an ancestor … or entry-point blobs exactly match the approved ones". It records a witnessed baseline, and "once ancestry establishes activation, deletion of a required entry point is an actionable stale-policy error". It adds blob identities to the stored records.
- *Rule.* The issue's rule is "activating them only when the issue's starting code contains the new test entry point; an unmerged change must not make another issue's checks unusable". The issue also asks to keep scope small and tight.
- *Failure, part 1: checks stay pending.* Consider the normal case: the PR is squash-merged, so the introducing pin is not an ancestor of main. The test script is then edited by a later issue before any issue starts between the merge and the edit. The blob no longer matches and no activation baseline was ever witnessed, so the adopted check stays pending forever. It is never run on later issues even though the entry point is present at their baseline.
- *Failure, part 2: renaming blocks starts.* Once a check has been activated, renaming its script makes every subsequent `coord <n>` fail with a stale-policy error. The plan specifies no onboarding path that removes an adopted record, so the owner must hand-edit config JSON. That contradicts "Normal onboarding requires no JSON authoring".
- *Smallest correction.* Activate when every recorded entry-point path exists at the new issue's baseline. Drop the ancestry, blob-identity and witnessed-baseline state. When paths are absent, skip with a logged explanation instead of an error, and let re-onboarding list adopted checks with keep/remove.

**X2 (minor): the plan moves more schema than the proposal needs.**
- *Plan claim.* `src/protocol.ts` "House the shared command/cache schemas currently defined in state" and re-export them from state.
- *Rule.* Make the smallest change. The plan itself says agent proposals carry "no cache/retry shortcuts".
- *Failure.* Moving `checkCacheSchema` and the full `checkCommandSchema` into protocol churns a schema that every coordinator command uses, for a proposal that needs only a strict `{ name, argv }`. Any mismatch in the re-export changes config parsing across all workspaces, outside this issue's behavior.
- *Smallest correction.* Define a minimal strict proposal command schema in protocol and leave the state schemas where they are.

### claude `daa87d045eafce23b9ee9532f64e6ec8ce253334` (self-review)

**C1-self (blocking): reviewers cannot see the proposal.**
- *Plan claim.* "Coordination validates it against the pinned commit, so it is reviewed with that implementation by the existing review, compare and consensus steps." `src/materializedInputs.ts` is not in the file map, and the signal is not bound into review inputs.
- *Rule.* "Review that proposal with the implementation using the existing workflow." Reviewers must be able to read the proposal, and a changed proposal must not inherit reviews of an unchanged code pin.
- *Failure.* `MATERIALIZED_PIN_KINDS` exports implementation and revision inputs as worktrees at the product pin. The implementation-ready signal lives in a descendant commit, so it is not in those worktrees, and the bound input set does not cite it. Reviewers never see the commands they are supposedly approving. A resubmission that keeps the same pin but changes the proposal keeps the same input hash.
- *Smallest correction.* Add `src/materializedInputs.ts`. Export the signal JSON for implementation/revision inputs and include the signal citation in the input-set hash, as the codex plan does.

**C2-self (blocking): the plan omits an existing test file that must change.**
- *Plan claim.* `buildWorkspaceConfig` "no longer throws on empty checks", but `test/install.test.ts` is absent from the file map.
- *Rule.* An implementation may change only approved paths. Existing tests that assert the removed refusal must be updated in the same change.
- *Failure.* The two `toThrow(/Cannot infer finalization checks/)` cases in test/install.test.ts fail once the throw is removed. Fixing them requires a path outside the approved map, which forces a plan amendment mid-implementation.

**C3-self: the plan leaves noninteractive timing unspecified.**
- *Plan claim.* `resolveCheckSettings` noninteractive mode accepts "an unambiguous detected plan" but never states the timing it saves.
- *Rule.* Ambiguous or unresolved parameters must not be resolved by an arbitrary choice, so the plan must fix the rule for timing too.
- *Failure.* Two implementers could save precommit+checks or checks only for the same tree. That changes whether every agent commit runs a full native build.
- *Smallest correction.* State "before opening a pull request" for newly detected unattended plans, as codex does, and print it.

### Scope, reuse and tests across the plans

- **codex.** The plan stays within the issue apart from X1. It reuses the existing runner, writer, prompts and fixtures, and it keeps tests inside existing suites. The test list is large but maps one-to-one onto the comment's acceptance list.
- **claude.** One new module plus its test file follows the one-file-per-module convention, but the plan has the C1 and C2 gaps.
- **muse.** The plan is small, but because of M1 it is small by omitting required behavior.

## Conclusion

- **muse:** revise. It does not implement the owner's design comment (M1). It leaves the reported `coord onboard` failure in place by default (M2) and approves stray root files (M4).
- **claude (mine):** revise. Reviewers cannot see agent proposals, and they are not bound into review inputs (C1). It also omits the existing install tests that must change (C2).
- **codex:** the strongest basis. It is complete against the comment, its file map is clean, its reuse is correct and its test commands are accurate. Adopt it with the X1 simplification (activate on entry-point presence at the baseline, skip with an explanation when absent, no ancestry, blob or witness state). X2 is optional.

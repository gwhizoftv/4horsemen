# Issue 209 — Empirical Phase Analysis and Coordination Efficiency Proposal

## Exact File List to be changed or deleted

None. This issue is an operational analysis and optimization proposal; no existing product source files are modified or deleted.

## Exact file list to be created

- `.plans/issue-209/plan.md`: The implementation plan and methodology for Issue 209.
- `docs/phase-efficiency-proposal.md`: Comprehensive empirical analysis of coordinator journals and logs across the last 5 completed issues (issues 177, 184, 195, 204, and 206), identifying primary latency bottlenecks and detailing 6 concrete efficiency proposals to significantly reduce coordination phase durations.

## Reuse and Scope

- Reuses existing coordinator journal event schemas (`started`, `gate-advanced`, `action-prepared`, `response-accepted`, `verification-run`, `verify-result`, `hold-created`, `hold-released`, `pr-created`) in `/Volumes/4TB-SOURCE/REPOS/4horsemen/coord-runtime/` across issues 177, 184, 195, 204, and 206.
- Reuses GitHub CLI (`gh`) to publish the finalized proposal as a comment to GitHub Issue #209 (`gh issue comment 209 --body-file docs/phase-efficiency-proposal.md`).
- Reuses existing test patterns in `test/verify-config.test.ts` to assert documentation presence, structural completeness, and data validity without introducing foreign test frameworks or unnecessary dependencies.
- Scope boundary: Focuses strictly on phase duration analysis, root cause diagnosis of delays, and concrete coordination efficiency proposals as requested in Issue #209. Engine modifications to `src/runLoop.ts` or `src/machine.ts` remain separate proposals for subsequent issues.

## Tests

- Propose adding a focused test suite in `test/verify-config.test.ts` verifying that `docs/phase-efficiency-proposal.md` exists, contains complete quantitative data for each of the 5 analyzed issues (issues 177, 184, 195, 204, 206), includes per-phase duration breakdowns (R1 through R7), and details actionable proposals addressing the identified bottlenecks.
- Verify that `pnpm check:fast` passes cleanly (linting, typechecking, fast tests, and system tests).
- Verify successful publication of the comment to GitHub Issue #209 via `gh issue view 209 --comments`.

## Alternatives Rejected

- **Directly implementing engine changes in this issue**: Rejected because Issue #209 specifically requests an analysis and proposal comment: *"Analyze the last 5 issues that were run using coord <issue> and propose ways to shorten the length of the phases. Write your proposal as a comment to this issue."* Implementing large architectural changes without prior consensus on which efficiency ideas to pursue would violate scope boundaries.
- **Posting only a GitHub issue comment without committing `docs/phase-efficiency-proposal.md`**: Rejected because mid-issue coordination artifacts in `.plans/` are deleted during R7 finalization; storing the proposal in `docs/phase-efficiency-proposal.md` preserves the empirical analysis, metrics, and proposals in repository history.
- **Analyzing arbitrary or synthetic benchmark issues**: Rejected because real-world coordination journals in `/Volumes/4TB-SOURCE/REPOS/4horsemen/coord-runtime/` (issues 177, 184, 195, 204, 206) capture authentic agent interactions, real hook/shim behaviors, vendor rate-limits, and actual hold dynamics.

## Risks and Mitigations

- *Risk*: `docs/phase-efficiency-proposal.md` is classified as `product` by `changeClassification.ts` because `documentation.paths` is not defined in `config.json`, triggering full precommit checks.
  *Mitigation*: Markdown additions do not affect TypeScript compilation or unit tests. Precommit hook `check:fast` will run and pass cleanly.
- *Risk*: GitHub CLI rate limiting or transient network issues when posting the comment.
  *Mitigation*: The proposal file is persisted locally in `docs/phase-efficiency-proposal.md` first; `gh issue comment` is executed with stderr capture and validation.
- *Risk*: Data skew from manual owner holds (e.g. overnight pauses).
  *Mitigation*: The empirical analysis explicitly separates active processing time from owner hold wait time (e.g. isolating the 950-minute hold in Issue 177 and the 184-minute hold in Issue 184) to provide accurate baseline metrics.

## Conclusion

By systematically mining the journals and logs of the last 5 issues (177, 184, 195, 204, 206), the proposal documents the exact distribution of time across coordination phases, reveals that over 75% of total elapsed time stems from nudge-loop holds and straggler wait states, and proposes 6 actionable architectural enhancements to shorten phase durations by up to 60-80%.

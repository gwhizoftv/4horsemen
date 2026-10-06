# Review — issue 170 plans

Bound inputs reviewed:
- cursor `a0fcb8cb423a157eadf4ba40cc1de8b282cf2314`
- claude `ea34313c0c72fcd64ffba6f8449d81844216dac5`
- codex `4645758dd1bdbba9e4924b34d4b53c12bd26da8c`

All three are at `.plans/issue-170/plan.md` and were read from the exported Bound input files. Claims about current behavior were checked against baseline `6f5b4bc`: `src/machine.ts` (observation → decision), `src/runLoop.ts` (`retry-verification` handling, tick completion polling, `verifyFinalizationChecks`, `inputFromSubmission`), `githooks/pre-push` (buffered stdin passed to `hook-verify`), `src/install.ts` (`readDeclaration`) and `vitest.config.ts`. No product suites were run; this action publishes coordination evidence only.

## Findings

### cursor

**C1 (blocking). Tests §3: "candidate failure → `retry-verification` with command + log path".**
- *Rule:* a failed candidate check must return the work to the implementer or reviser with the failing command and its log (issue §3), and must not re-run the suite until a new submission arrives.
- *Failure as written:* `decide()` maps `status: "retry"` to `retry-verification` (`src/machine.ts:140`). `applyDecisions` then only sets the cursor to `intent` with `outstanding` (`src/runLoop.ts:2657-2660`). No action is reissued and the completion file is not cleared. On the next tick the loop re-reads the same completion SHA (`src/runLoop.ts:2740` onward) and runs the candidate suite again on the unchanged pin. The agent is never told which command failed, and the coordinator re-runs an expensive failing suite on every tick.
- *Correction:* return `status: "rejected"`, which `decide()` maps to `reissue-action`, a new R4/R6 action with the command and log in `outstanding`. Keep throwing for coordinator launch errors, as finalization does today.

**C2 (major). File list: `githooks/lib/policy.sh`, `githooks/pre-push` pass `--ref`; `hook-verify` "Accept `--ref`".**
- *Rule:* binding must use the outgoing ref for every installed hook body, and must not depend on a hook-body edit reaching clones that already exist.
- *Failure as written:*
  - `githooks/pre-push` already pipes the buffered `local_ref local_sha remote_ref remote_sha` lines to `hook-verify` on stdin (`coord_verify prepush <<< "$push_refs"`), so `--ref` duplicates data the CLI already receives.
  - The plan does not say what `hook-verify` does when `--ref` is absent. Vendored-delivery clones (`test/hookSync.test.ts` "vendored delivery") keep the old bodies, which never pass it. Such a clone either fails as an unknown or missing argument (an outage), or falls back to `HEAD`, which is the binding the owner's comment rejected.
  - Editing hook bodies also makes every attested clone report hook drift until it is resynced.
- *Correction:* derive the branch from field 3 of the single stdin ref line in `src/cli.ts`/`src/hookPolicy.ts`, and leave `githooks/` unchanged.

**C3 (major). Schema: `candidate` has "commands plus path-to-check `selection`"; Tests §5 say "unclassified paths expand to full coverage".**
- *Rule:* the issue requires unclassified changes to expand to full coverage, and declared risk rules to pull build/E2E forward. The plan therefore has to define which product paths the base candidate list is declared adequate for.
- *Failure as written:* the schema has only selection rules. Take a `scripts/bootstrap.sh` change with no matching rule:
  - If unmatched means "base list", a launcher change skips `test:e2e`, which breaks the issue's rule for unclassified paths.
  - If unmatched means "full", every ordinary `src/` change runs build plus E2E at the candidate gate, which removes the issue's savings.
  - The implementer has to guess, and the two readings produce opposite behavior.
- *Correction:* add an explicit `covers` (prefixes/files) set. Paths outside `covers` and outside every rule expand to the full `checks`.

**C4 (major). `package.json`/`vitest.config.ts` split; out of scope: "changing manual-branch verification defaults".**
- *Rule:* manual branches keep their configured verification coverage (issue §3: "Owner-driven manual branches retain their local verification policy").
- *Failure as written:* the live and example local policy is `precommit: check:fast`, `prepush: test:e2e`. Moving `install`, `cli`, `hookSync` and the other system tests out of `test:fast` means a manual-branch edit to `src/install.ts` commits and pushes without running `test/install.test.ts`. The command list is unchanged but its coverage silently shrinks.
- *Correction:* in `config.example.json`, add `test:system` to `verify.prepush`. In `docs/setup-workspace.md`, add the rollout step for the live config.

**C5 (minor). File list: `src/orderScaffold.ts` surfaces candidate results.**
- *Rule:* coordinator results must never become agent-authored evidence (issue §4: "Do not trust an agent-authored 'tests passed' signal").
- *Failure as written:* `renderArtifactScaffold` produces the JSON body agents copy into their artifacts. Results placed there are then republished by agents as their own claims.
- *Correction:* render results only in `src/action.ts` prose, from `cursors.accepted[].checkResults`.

**C6 (minor). New files: the `vitest.system.config.ts` list is "confirm from recorded durations", and there are two new test files.**
- *Rule:* the plan must give an exact file map and propose only focused tests.
- *Failure as written:* the system-tier membership is left open, so the file-partition test cannot be written against a fixed list. A separate `verificationReceipts.test.ts` duplicates fixtures for a module whose only consumer is the runner.
- *Correction:* fix the nine-file list, and use one test file.

### codex

**X1 (major). File list and §1–§3 describe intent, not a mechanical design.**
- Examples: "strict optional coordinated-verification declaration", "accepted-result references", "dependency lock/install identity", "preparation commands".
- *Rule:* the R2 action asks for a mechanically complete implementation plan. Reviewers and the comparison gate need declared field names and semantics to check `config.example.json`, the receipt key and the selection rules.
- *Failure as written:*
  - No schema field, function or event name is specified, so the implementation cannot be checked against the plan.
  - "dependency lock/install identity" has no computation: hash `node_modules`? the lockfile only? the store?
  - Reviewers would have no basis to reject, for example, a receipt key that silently omits the lockfile.
- *Correction:* name the declaration fields and their semantics, the receipt key material, the new journal event types and the runner API.

**X2 (major). §2: "Execution must not hold the state lock or stall lifecycle/owner-control polling: schedule bounded async work, observe completion on subsequent ticks … Persist job outcome and result references before acceptance."**
- *Rule:* stay within the issue with the smallest complete change, and list every persisted state the design needs.
- *Failure as written:*
  - This turns verification into a persistent background-job subsystem. The issue does not ask for that, and finalization today runs synchronously inside the tick.
  - The tick re-reads every `verifying` cursor's completion each pass (`src/runLoop.ts:2740` onward). Without a persisted job record keyed by action and pin, every tick would schedule a new job for the same submission.
  - The file map names no job schema: `src/state.ts` only gets "accepted-result references", and `paths.ts` only gets locations. No restart, drop or pause transitions are specified for an orphaned job.
- *Correction:* either keep execution synchronous and accept the blocking cost already paid by finalization, or specify the job record schema, its key, and its tick, restart and drop transitions in the file map.

**X3 (major). §4 and Tests: the system tier is "start with installer/…/real-CLI/run-loop cases after inspecting their fixtures", and the Tests commands run `test/runLoop.test.ts` under `vitest.system.config.ts`.**
- *Rule:* a fixed partition, without silently reducing manual coverage (same rule as C4).
- *Failure as written:*
  - The membership is left open.
  - Moving `test/runLoop.test.ts`, the core state-machine suite, out of `check:fast` means a manual-branch edit to `src/runLoop.ts` or `src/machine.ts` commits and pushes under the current local policy (`check:fast` / `test:e2e`) without its primary tests.
  - The plan changes no example `verify` list to compensate.
- *Correction:* fix the list and keep `runLoop.test.ts` in the fast tier. Add `test:system` to the example `verify.prepush`, plus a rollout note.

**X4 (minor). File list: `vitest.e2e.config.ts` "align shared coverage declarations if needed"; `test/support/testSuites.ts` manifest.**
- *Rule:* the plan must give an exact file map.
- *Failure as written:* "if needed" leaves the edit conditional. The manifest file is one more new file whose job, keeping the include and exclude lists in sync, is already done by the exhaustive-partition assertion the plan adds.
- *Correction:* drop both, or justify them as required.

**X5 (minor). Selection rules are not defined beyond prose.** The same gap as C3 applies: "ordinary source changes retain at least the complete fast tier … any unclassified path select full coverage" never says what declares a path "ordinary".

### claude (self-review)

**S1 (minor). §runLoop `verifyCandidateChecks` runs synchronously inside the tick, after `evaluateEvidence`.**
- *Rule:* owner controls and lifecycle observation for other agents keep working while suites run. Any blocking cost has to be stated, not discovered.
- *Failure as written:* with three implementers submitting close together, the tick runs each candidate suite in turn. It does call `checkpoint()` between commands and lock polls, but for the whole duration it observes no other agent's completion, nudge or hold. The plan states the same trade-off for finalization only implicitly.
- *Correction:* note the accepted blocking cost under Risks and record `queueWaitMs`/duration (already planned). Defer async jobs to a follow-up issue unless measurements justify them.

**S2 (minor). `config.example.json` defaults the cached commands to `tree-excluding-evidence`.**
- *Rule:* the issue allows evidence-excluding digests only for paths "proven irrelevant to that check".
- *Failure as written:* the plan has no test showing that `lint`, `typecheck`, `test:fast` and `test:system` ignore `.plans/`, `.signals/` and the other evidence paths. A future test that reads repository evidence would reuse a stale receipt.
- *Correction:* add one assertion to the planned `verify-config` example test: `eslint src test`, `tsc -p tsconfig.json` and the vitest `include` globs cannot match an evidence prefix. Otherwise default the example to `tree`.

### Scope, reuse and tests (all plans)

- **Scope:**
  - All three plans stay within issue sections 3–5 and the #170 part of section 6, and exclude the onboarding timeout and the live config.
  - codex expands scope with background jobs (X2).
  - cursor edits `githooks/` and `orderScaffold.ts` without need (C2, C5).
- **Reuse:**
  - All three reuse #162's classifier, `verificationMeasurement`, `materializeWorktree` and `processRunner`, and the existing `runLoop` and `hookSync` fixtures.
  - claude names the concrete reused symbols and fixture lines.
  - cursor and codex name the modules but do not place each change.
- **New files:**
  - All three justify the receipts and runner modules and the system config.
  - cursor's second test file and codex's `testSuites.ts` are not needed (C6, X4).
- **Tests:** all three propose focused cases in existing files. cursor's candidate-failure test asserts the wrong decision (C1).

## Conclusion

**cursor.** C1 is blocking: the candidate-failure path it specifies would re-run a failing suite every tick without informing the agent. C2–C4 leave hook binding, selection semantics and manual coverage ambiguous or regressed.

**codex.** The safety intent is sound, but the plan is not mechanically complete (X1). It adds an unspecified background-job subsystem (X2) and leaves the test-tier split open, with a manual-coverage regression (X3).

**claude.** This plan is the most mechanically complete and corrects the failure path, the hook binding, the receipt argv and the manual-coverage gaps. Its two findings (S1, S2) are minor and fit within its own file map.

Recommendation: select the claude plan with S1 and S2 applied. If cursor's plan is selected, C1 must be fixed before implementation.

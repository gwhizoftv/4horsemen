# Issue 146 — bound plan review

Reviewed the coordinator-exported `.plans/issue-146/plan.md` files at these exact pins against the issue snapshot and existing implementation/tests:

- Cursor: `29331e5a206544d2bb3fa9c7534616027db6bb97`.
- Claude: `fae0a54ca4a4f6f1a3260a71e16ddf2bbce9d93f`.
- Codex: `9cc96e5a69b432a41ad1ed6212d85ac8acd10f5f`.

## Findings

### 1. [P1] Cursor leaves the reported hold-driven exit unchanged

**Plan claim/section:** Cursor's file list limits `src/runLoop.ts` changes to recovery-log wording; its conclusion substitutes automatically running after `resume` for keeping the original runner alive.

**Rule:** Issue 146 asks the coordinator not to exit while it can continue. An owner-recoverable hold is a waiting state, not terminal completion; simplifying the subsequent restart does not satisfy that separate requirement.

**Concrete failure:** `CoordinatorRunLoop.run()` at `src/runLoop.ts:2743-2744` would still return when `state.paused && !resourceWorkPending(...)`. The same legacy `unobservable` hold in the issue transcript, or a vendor hold with unknown reset, would still terminate `coord N`. The existing unknown-reset tests at `test/runLoop.test.ts:287-304` would continue proving the unwanted immediate return. No proposed test covers the missing liveness behavior.

**Smallest correction:** Include the held-runner waiting change and focused `run()` tests, retaining observation-only held ticks and independent release authority rather than swallowing arbitrary errors.

### 2. [P1] Cursor's new resume-to-run path omits the existing run lifecycle safeguards

**Plan claim/section:** Cursor's `src/cli.ts` item and CLI tests specify invoking `makeRunLoop(paths).run()` whenever resume leaves `paused === false`; the reuse list does not include the guarded run entry or completed-issue cleanup.

**Rule:** Every command that starts automated issue effects must enforce the same manual-session exclusion and completed-issue teardown/readiness contract as `coord run`. Previously state-only `resume` did not need those effectful-entry safeguards.

**Concrete failure:** The existing `run` command checks the workspace's manual session before starting effects (`src/cli.ts:1412-1425`), while the current resume handler has no such check. With retained issue state and a live manual session, the planned resume path can release the last hold and launch automated agents against clones already in manual use. If that resumed run finishes, calling only `run()` also omits `detachCompletedIssue()`, leaving issue UI and clones behind instead of performing the normal cleanup and surfacing clone-readiness failures. `test/cli.test.ts` already has manual-entry exclusion and completed-run cleanup fixtures that can cover the new entry point.

**Smallest correction:** Route the new effectful entry through the same preflight and completion handling as `run`, checking exclusion before the recovery mutation. Make running explicit or otherwise retain a state-only recovery form: resource-held coordinators can already remain alive today, so fully unpaused state does not establish that another runner needs starting.

### 3. [P1] Claude turns a single-agent recovery instruction into release of unrelated holds

**Plan claim/section:** Claude's `src/cli.ts` item makes plain resume release every non-`nudge-loop` hold and clear manual pause; its hold logs and report prescribe that same plain command for each individual non-nudge hold.

**Rule:** A recovery instruction for one inspected agent must not silently acknowledge independent holds on other agents or clear a separate manual pause. The current scoped recovery contract explicitly preserves both (`src/state.ts:1172-1196`, `docs/coord-driver.md:517-521`). A shorter selector can preserve that boundary; changing the default to bulk release does not.

**Concrete failure:** Suppose Claude has a legacy `unobservable` hold, Codex has an unresolved vendor-resource hold, and the owner has manually paused the issue. After inspecting only Claude, the owner follows Claude's proposed per-hold `coord resume --issue N` instruction. It releases both holds and the manual pause, allowing advancement without the owner addressing Codex or independently lifting the manual stop. Per-hold audit events record the broadened effect but do not prevent it. Retaining an optional scoped command does not make the default instruction scoped.

**Smallest correction:** Preserve the current default manual-pause semantics and provide an unambiguous short hold selector, or require a separately explicit bulk-release authorization rather than recommending bulk recovery on each individual hold line.

### 4. [P1] Claude's exact test scope leaves existing checks failing or nonterminating

**Plan claim/section:** Claude's Tests section changes only the unknown-reset `run()` case, claims three focused tests prove the new behavior, and omits `test/issueReport.test.ts` from its exact file list while changing report text.

**Rule:** The planned implementation must pass the existing required checks, and its exact file map must authorize the test migrations necessitated by changed behavior. New assertions cannot substitute for updating existing assertions that the plan invalidates.

**Concrete failure:** The existing exact-deadline test at `test/runLoop.test.ts:257-284` calls `.run()` without an abort signal at line 273 and expects return after the single recheck. Under Claude's new finished predicate, its unresolved automatic hold never finishes; the injected sleep resolves immediately, so the test keeps running instead of reaching its assertions. Separately, `test/issueReport.test.ts:140` requires `coord resume --issue 1 --hold exact`; Claude explicitly replaces that non-nudge recovery line with plain resume, so that unchanged test fails. Following the stated three-test scope cannot deliver a passing `pnpm check:fast`.

**Smallest correction:** Migrate the exact-deadline test as well as the unknown-reset case to bounded abort-driven waiting while retaining the one-recheck/no-send assertions. Add `test/issueReport.test.ts` to the exact file list and update its recovery assertions to the ultimately approved semantics. Exercise release and continued progress in the same running process, not only sleeping while held.

### Scope, reuse, and focused-test assessment

- **Cursor:** The branch-preflight proposal is appropriately narrow, reuses the existing protocol/readiness path, and preserves off-branch refusal. It introduces no product files or dependencies. The proposed branch and selector cases are focused, but the missing liveness and run-entry/cleanup coverage above prevent approval as written.
- **Claude:** It also reuses the existing branch, state, journal, and test helpers and introduces no new product files or dependencies. Keeping the runner alive is directly in scope. The default bulk-release policy expands beyond the necessary recovery simplification, and the three-test limit omits existing tests affected by the change.
- **Codex:** No blocking finding identified. Its exact-branch exemption, held-state waiting, scoped agent selector, and explicit stopped-runner option address the reported boundaries while retaining manual-session exclusion and completed cleanup. It names existing helpers/fixtures, adds no product files or dependencies, and includes the exact-deadline/report-test migrations omitted above. Its larger test list remains focused on changed behavior and safety boundaries; implement those as extensions/table-driven cases, not a new test framework. The acknowledged absence of concurrent-runner detection remains a limitation: `--run` must stay explicit and must not be presented as necessary beside a live runner.

## Conclusion

Request changes to Cursor's and Claude's pinned plans for the findings above. Codex's pinned plan is suitable to implement as written, with its stated scoped-release and explicit-run boundaries preserved. All three correctly identify the dirty preflight as the reattachment bug; fixing that must not weaken off-branch protection or erase in-progress work.

# Issue 170 — bound plan review

Reviewed the coordinator-exported plans directly, with these authoritative pins:

- Cursor: `a0fcb8cb423a157eadf4ba40cc1de8b282cf2314`.
- Claude: `ea34313c0c72fcd64ffba6f8449d81844216dac5`.
- Codex: `4645758dd1bdbba9e4924b34d4b53c12bd26da8c`.

All references below are to `.plans/issue-170/plan.md` at the named pin. Review checks were source/plan inspection and artifact/hash validation, not product test execution.

## Findings

### 1. [P1] All plans: preserve manual verification coverage when splitting the fast suite

**Plan claim/section:** Cursor's file map narrows the fast Vitest configuration and adds system tests only to full acceptance; Codex's section "4. Selective tests and measurement" similarly moves expensive files out of fast while promising unchanged manual checks. Claude's package/config changes (lines 134–161) and risk mitigation (line 315) recognize the loss but rely on an owner later changing live prepush configuration.

**Rule:** Issue 170 requires owner-driven manual branches to retain their local verification policy unless explicitly reconfigured. An unchanged command name is not unchanged coverage if its test membership shrinks.

**Concrete failure:** An existing workspace uses precommit `pnpm check:fast` and prepush `pnpm test:e2e`, with coordinated mode absent. After these script/config changes, a manual commit and push can both pass without running install/onboard/hook tests that previously ran at precommit. No coordinator final gate protects that manual branch. The baseline installer proposal also still selects exactly those two commands in `src/setupWorkspace.ts`, so a fresh default installation can omit the new system tier as well. Updating only the example and documenting a future owner rollout does not protect either case automatically.

**Smallest correction:** Keep a coverage-preserving legacy/manual aggregate while introducing a separate selective candidate command, or implement an explicit, validated migration that cannot weaken existing manual runs before owner opt-in. Add one old-config manual-hook regression covering a failing test moved to the system tier, and cover the generated default proposal. This finding also applies to my own submitted plan.

### 2. [P1] Claude: receipts need execution-input validation, not only clean materialization and exit zero

**Plan claim/section:** The receipt identity in Reuse and Scope (lines 202–205) hashes the mirror tree, argv, policy, probes and declared environment. The runner algorithm (lines 216–227) materializes once, executes commands in order, and writes a receipt on exit zero. The dependency mitigation (line 319) says uncached install/build plus a tracked lockfile suffice.

**Rule:** A successful receipt must certify the immutable inputs actually checked, including dependency state; dirty execution inputs must not be attributed to a clean pin. A fresh checkout is only an initial condition, not proof that preceding commands left the input unchanged.

**Concrete failure:** An uncached install/setup command changes a tracked source file, then the cached test command passes against that modified file. The specified key still comes from the original mirror tree, and the runner writes success without comparing the execution inputs before/after. A later clean checkout of the original pin can reuse that receipt even though it never passed. Similarly, an install can select a different relevant generated dependency state without changing the lockfile or node/pnpm version probes, leaving the proposed key unchanged.

**Smallest correction:** Verify execution inputs against the declared immutable/check-input identity before running and before publishing success, include a declared dependency/preparation identity, and disable reuse when those inputs cannot be established. Add a fake preparation command that mutates a tracked input; it must not produce a reusable success for the original pin. Codex's plan already explicitly requires these checks; Cursor promises no dirty reuse but should make the same post-preparation invariant explicit.

### 3. [P1] Claude: candidate selection can discard an explicitly required check by name

**Plan claim/section:** The schema allows unique names separately within final checks and candidate checks (lines 51–54). The selector then concatenates candidate checks and rule-added final checks and deduplicates by name (line 75).

**Rule:** Every command required by a matching risk rule must execute or have its own equivalent-input receipt. A display name does not establish command identity.

**Concrete failure:** A valid declaration can name a cheap candidate command `test` and also name a different full/system command `test` in the final list. A hook/template risk rule adds the latter, but candidate-first name deduplication discards it. The candidate becomes eligible for review after only the cheap command, despite the explicit rule requiring the expensive one. The current plan's within-list uniqueness checks do not reject that declaration.

**Smallest correction:** Make check IDs refer to one canonical command definition across both lists, reject conflicting same-name definitions, or deduplicate by full canonical check identity while preserving every requirement. One selector/schema regression with equal names and different argv expresses the defect.

### 4. [P2] Claude: age alone cannot reclaim a live verification lock

**Plan claim/section:** Reuse and Scope's lock algorithm (lines 210–212), reiterated at line 318, treats a lock as stale when its owner is dead **or** it is older than six hours.

**Rule:** Single-flight and the expensive-suite limit must exclude simultaneous live owners. Elapsed time alone does not establish that a process stopped using a slot or receipt key.

**Concrete failure:** A live slow/stuck command still holding its lock after six hours can overlap a second invocation that removes the supposedly stale lock. The expensive bound and one-execution guarantee both fail. The first owner's later unconditional release can also remove a replacement owner's lock, allowing further overlapping runs.

**Smallest correction:** Use owner identity plus confirmed liveness/death and compare ownership on release. If leases are used, renewal and fencing/cancellation must prevent an expired holder from continuing to act. Add a clock-advanced test where a live owner retains exclusion past six hours; uncertain/foreign-host liveness must not be treated as dead merely by age.

### 5. [P1] Cursor: resolve the contradictory candidate-failure transition

**Plan claim/section:** The run-loop file-map entry says to reject candidate failures, but Tests item 3 explicitly specifies candidate failure leading to `retry-verification` with command and log.

**Rule:** A failed product candidate must return actionable feedback to the implementer/reviser; retrying evidence verification is not a request to fix the product.

**Concrete failure:** Following the specified test/transition keeps the existing failing completion and only resets its cursor to intent. The baseline `src/runLoop.ts` retry-verification branch does exactly that, whereas `src/machine.ts` maps rejected observations to reissue-action. No corrected action reaches the agent; the same broken product pin is repeatedly checked and the issue remains blocked without the promised failure delivery.

**Smallest correction:** Specify rejected observation → reissued implementation/revision action consistently, and assert a new action with command/log feedback rather than merely an intent cursor. Claude's explicit correction of this distinction is correct and reusable.

### 6. [P2] Cursor: include the existing measurement schema in the authorized file map

**Plan claim/section:** The file map promises candidate-phase/cache/join/queue analytics, while Reuse and Scope lists `src/verificationLog.ts` only as an unchanged reused helper. It is absent from both change lists.

**Rule:** New measurement values must be accepted by the existing strict schema and every necessary product file must be authorized in the plan; paths mentioned only as reuse do not expand scope.

**Concrete failure:** At baseline, verificationMeasurementSchema accepts only precommit/prepush/finalization and the literal cache reason "not implemented". Adding candidate/reuse records through that helper either fails type/schema validation or forces the implementation to mislabel records, omit the new metrics, introduce a second logging path, or edit an unapproved file. The analytics extension cannot obtain truthful candidate measurements by leaving this contract unchanged as planned.

**Smallest correction:** Add the measurement module to the exact change list and specify backward-compatible phase/cache/queue fields, retaining the prohibition on treating hook telemetry as receipts. Claude and Codex already include this module in their change maps.

### Scope, reuse, new-file and test assessment

- **Cursor:** The broad objective is within issue scope, and mirror, classifier, state and fixture reuse is appropriate. Two production modules and the test-tier config are justified. However, passing a new branch flag through product hook bodies is unnecessary: the existing pre-push body already buffers and forwards the full ref records to hook-verify. The pushed ref can be read in TypeScript without changing either hook body. Changes to installer/scaffold also need a concrete necessity beyond existing schema propagation/action rendering. The two new focused test files are defensible, but one shared fixture/file would be smaller. The measurement-map omission and failure-transition contradiction require correction.
- **Claude:** The strongest concrete reuse analysis: leaving hook bodies, installer and scaffold unchanged is supported by the baseline. The two new production modules, system config and single focused runner test file are justified; extending existing integration suites is appropriate. The plan stays within verification scope, but findings 1–4 prevent approval as written. Its example retains a full check:fast precommit followed by the same lint/typecheck/fast checks at the candidate gate, so it should also explain that residual mandatory duplication or select genuinely cheaper hook checks. Its explicit age-based lock policy is not conservative recovery.
- **Codex:** The plan is within scope, reuses existing state/classifier/mirror/fixtures and justifies its modules, direct test file and shared test-tier manifest. It explicitly addresses dirty inputs, dependency identity, exact-pin defaults, live locks and stale async results. Nevertheless, finding 1 is an actual unresolved flaw, not solved by its statement that manual behavior is unchanged. The broader async execution design needs the proposed stale-authority tests; avoid adding abstractions beyond those contracts. A coverage-preserving manual aggregate can be addressed within the existing package/config/setup/test map.
- **All plans:** Test groups cover the issue rather than proposing unrelated suites, but use focused development commands and let the installed hook own its mandatory checks. Do not manually duplicate full fast checks immediately before committing. No plan review needs a product test suite merely to publish findings. Editing the clone-local AGENTS overlay/index flags remains prohibited; instruction updates must respect the installed protocol rather than use index plumbing as a workaround.

## Conclusion

Request changes before treating any plan as implementation-ready: all three must preserve manual coverage through the suite split. Claude also needs the receipt-input, check-identity and lock-liveness corrections; Cursor needs a consistent rejection/reissue contract, the measurement file-map addition, and removal of unnecessary hook plumbing. Codex supplies the more conservative receipt/runner basis, while Claude supplies useful concrete reuse details, but neither comparison excuses the shared manual-policy regression. Keep selection to the coordinator's subsequent ballot; this review does not revise any bound plan or authorize new files.

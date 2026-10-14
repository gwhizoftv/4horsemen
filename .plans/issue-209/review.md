# Issue 209 plan review

Reviewed the exported bound plans directly:

- Claude: `fd898740835d2f037c8675f930f038c5d0cb4ece`.
- Codex: `fd399021665fab51a1621f5921537bfe313f4239`.
- Cursor: `e87d29faec1035954c1738980a71b1a6194f566e`.
- Antigravity: `d9d40a1ad4771af09a1838b3209f35a4abeedb72`.

All references below to plan sections refer to `.plans/issue-209/plan.md` at
the corresponding pin. Historical journal paths are relative to the issue's
configured `/Volumes/4TB-SOURCE/REPOS/4horsemen/coord-runtime` root.

## Findings

1. **[P1] Claude — Reuse and Scope, “Breakdown method,” items 3–4
   (lines 68–71): the submission boundary is mislabeled as the start of work.**
   Timing labels must match what the journal events actually record.
   `intent-seen` is emitted after the coordinator reads an agent's completion
   marker, not when the agent picks up its task (`src/runLoop.ts:3331` and
   `src/runLoop.ts:3366`). Following the plan would classify nearly all agent
   execution and pre-submission hook checks as “pickup,” then label coordinator
   validation as “Agent work.” For example, in `issue-204/journal.jsonl`,
   Claude's R4 nudge at sequence 268 to intent at 313 spans 673.828 seconds;
   intent to accepting verification at 314 spans only 0.814 seconds. The report
   would claim less than one second of implementation work and more than eleven
   minutes of pickup, directly distorting the optimization target. Rename these
   intervals submission turnaround and coordinator validation; separate actual
   pickup/work only when additional evidence supplies those boundaries.

2. **[P1] Claude — Reuse and Scope, “Breakdown method,” plus Tests,
   “Breakdown sums”: overlapping agent intervals cannot form the specified
   additive phase decomposition.** A wall-clock breakdown that must sum to a
   phase must use disjoint intervals; concurrent agent durations and the
   first-to-last acceptance spread are separate statistics. In #204 R1.join,
   the phase is 109.750 seconds, while Cursor's own nudge-to-intent interval
   already occupies 104.923 seconds (sequences 10–72). The proposed straggler
   interval from Claude's acceptance at 28 to Cursor's acceptance at 75 adds
   another 87.558 seconds over the same wall time. Those two categories alone
   exceed the entire phase before delivery, validation, or other agents are
   added. The required 0.05-minute reconciliation will fail or force arbitrary
   subtraction. Present per-agent turnaround and acceptance spread separately,
   or explicitly define a disjoint phase timeline before requiring sums.

3. **[P1] Claude — Reuse and Scope, “Publishing the comment,” lines 124–137:
   the publication schedule has no guaranteed executable completion path.**
   The plan must actually deliver the requested issue comment and must respect
   the order in which coordinator-owned final checks run. The plan places
   posting after those checks during the agent's R7 action, but
   `verifyFinalizationChecks` in `src/runLoop.ts:2810` runs only after the agent
   has submitted finalization evidence. No post-check agent action is specified.
   The additional fallback to having the owner post after merging lets the
   coordinator finish with only a document/PR and no comment, despite #209
   expressly requesting one. Assign publication to an executable selected-agent
   action, require a readback/URL receipt, and treat publication failure as
   incomplete. Do not make issue completion depend on a new authorization that
   the original comment request already supplies.

4. **[P2] Cursor — Reuse and Scope, proposal candidate 6 (line 39):
   unmeasured residual time is declared to be agent writing time.** Absence of
   recorded command time does not establish the cause of the remaining phase
   duration. The instruction “Otherwise say the remainder is agent writing time
   and is outside this proposal” turns a lack of attribution into a finding.
   The residual may include delivery delay, manual uninstrumented checks,
   coordinator work, or blocked tools; the analytics contract explicitly leaves
   manual commands unobserved. Following this rule can exclude an actionable
   delay from the proposal and incorrectly blame writing. Label it unattributed
   elapsed time and investigate matching action/log evidence before assigning
   a cause or dismissing it.

5. **[P2] Cursor — Tests, “Push the commit, then post the committed file”
   (line 50): publication has neither a unique publisher nor retry handling.**
   The issue should receive a consolidated proposal whose publication remains
   safe across competing implementations and action retries. A push is not
   implementation selection. If two selected implementers follow this plan,
   both post candidate documents before comparison; if either action restarts
   after a successful post, the same unconditional command posts again. Later
   revisions have no specified way to replace the obsolete body. Use the
   coordinator-selected reviser, identify the report comment with a stable
   marker, inspect existing comments, and verify the final body rather than
   making each implementation push publish a new comment.

6. **[P1] Antigravity — Tests, first bullet, versus “Exact File List to be
   changed or deleted: None”: the proposed test edit is outside the file map.**
   Every intended changed path must be in a file-list section; references only
   in Reuse or Tests do not grant scope. The plan explicitly adds a suite to
   `test/verify-config.test.ts`, but its file lists authorize only the plan and
   a new report. Following it either violates the approved map and fails scope
   enforcement or requires an avoidable amendment before submission. Moreover,
   checking prose presence cannot validate numerical correctness against private
   journals. Remove that suite and validate the report's arithmetic against the
   source records; no new product behavior needs a regression test.

7. **[P2] Antigravity — Conclusion and the new report description:
   quantitative conclusions and a fixed set of six proposals are committed
   before their derivation is specified.** A measured efficiency proposal must
   distinguish recorded duration from estimated avoidable delay and provide
   evidence and assumptions for savings. The conclusion asserts that more than
   75% of elapsed time comes from holds/straggler waits and promises reductions
   “up to 60–80%,” without defining non-overlapping attribution, a savings
   calculation, or a measurement that could reject those claims. Following it
   can double-count straggler time already inside a hold and publish a causal
   speedup estimate unsupported by the five observational runs. Treat both
   figures as hypotheses until derived, specify pause/profile handling and
   overlap rules, and retain only recommendations supported by the analysis.

**Scope, reuse, and verification assessment.** All four plans correctly focus on
analysis and an issue comment, choose the same five runs, and justify a durable
report for pin-based review. Claude, Codex, and Cursor reuse the existing
analytics reader and avoid new product tests. Antigravity names existing
journal schemas and a test file but omits the existing analytics reader and
proposes a prose-presence suite that adds no reliable numerical validation.
Codex's explicit source inventory, clipped pause/runner intervals, repeated-round
handling, uncertainty labels, and selected-publisher receipt address the
identified failure modes without expanding the product scope. No blocking
finding was found in the bound Codex plan.

**Owner guidance: why R1.join exceeded two minutes.** As a supplemental
diagnostic, the completed R1 interval of #209 is available even though #209 must
remain outside the five-run cohort. `issue-209/journal.jsonl` sequences 0–165
show 159.956 seconds from `started` to the join gate. All four first nudges had
occurred by 8.217 seconds after start. The first-outstanding nudge to submission
and submission to acceptance measurements are:

| Agent | Nudge → intent (seconds) | Intent → acceptance (seconds) | Evidence sequences |
| --- | ---: | ---: | --- |
| Claude | 18.525 | 1.641 | 6, 41, 43 |
| Codex | 60.830 | 0.643 | 10, 87, 89 |
| Cursor | 70.122 | 0.504 | 12, 99, 104 |
| Antigravity | 151.162 | 0.558 | 17, 161, 164 |

The last acceptance was Antigravity at `03:58:31.098Z`; the gate advanced
19 milliseconds later at `03:58:31.117Z`. Thus the observed delay was waiting
for the last readiness submission, not a two-minute coordinator validation.
There were no holds/pauses in this interval. All eight recorded precommit and
prepush observations have `command: null` and `skipReason: coordination evidence
only` (sequences 34, 35, 63, 71, 85, 95, 147, 153), so they did not run the
product suites. The journal alone does not split the 151.162 seconds into
reading, model work, tool calls, commit, and push; those causes require targeted
log evidence. The selected report can explain this supplemental join example
without changing its five-run tables or approved report-file scope.

## Conclusion

Prefer the Codex plan at `fd399021665fab51a1621f5921537bfe313f4239`.
Claude's timing definitions, additive decomposition, and publication scheduling
need correction; Cursor's residual-time attribution and unconditional posting
need correction; Antigravity's test scope and unqualified savings claims need
correction. The selected implementation should answer the R1 guidance using
submission-turnaround evidence and keep unknown subintervals explicit.

Validation performed: verified the action SHA-256, read all four bound plan
files, inspected existing event-writing/analytics/finalization code, and
recomputed the cited #204 and #209 journal intervals using read-only Python.
No product suite was run for this evidence-only review, and no historical or
coordinator-owned check is represented as a test run by this reviewer.

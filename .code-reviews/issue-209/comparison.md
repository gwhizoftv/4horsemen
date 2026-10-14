# Issue 209 implementation comparison

## Comparison

Recommend **Codex as the revision base**, incorporating Claude's compact comment
format and its explicitly provisional assessment of the recent delivery fix.
Codex provides the strongest reconciliation of pauses, overlapping verification,
action boundaries, and qualified savings. Claude adds useful delivery evidence;
its proposed retry condition needs correction before publication. Cursor has a
material overlap error and an unsupported verification-reuse mechanism.
Antigravity proposes weakening approval and verification requirements and makes
unsupported causal savings claims.

### Exact inputs and scope

| Candidate | Bound implementation pin | Assessment |
| --- | --- | --- |
| Antigravity | `3efad6dc505f58f73561c9daad385fbccaa385c2` | Revise: verification bypass, automatic roster/ballot changes, and unsupported attribution. |
| Cursor | `048135d9144c7bd8b87a1e86c78bd28b86ee27f0` | Revise: pause overlap and hook-receipt assumptions; proposals need concrete mechanisms. |
| Claude | `f274b186713f325492a93579e07f7b6c8fdab2b4` | Strong alternative: useful reproducible delivery analysis and short comment; correct retry rule. |
| Codex | `15a02a905425b5da3c891f274302f9a3c0a7ef2e` | Preferred: most complete accounting and explicit limits; update emphasis for owner guidance and shorten the publication body. |

I read all four exported worktrees named in the action. All product changes are
the single approved `docs/issue-209-efficiency-analysis.md`; the coordinator's
other listed paths are existing plan/review/participation evidence. None changes
product code, configuration, dependencies, or tests. All reuse existing journals
and `coord analytics`. A report file is justified by the issue; no maintained
analysis tool or new test suite is needed. The inline Python in Claude and Codex
is an appropriate reproduction aid, not a new product abstraction. All four
correctly leave external publication pending during parallel implementation.

All cover #177, #195, #184, #204, and #206 in start-time order and keep the
closed #209 join supplemental. Upper-middle medians in Claude/Cursor and ordinary
medians in Codex are explicitly defined; their different values are not alone a
defect. Repeated R6 rounds and solo omissions are visible in each candidate.

### Material findings

1. **[P1] Antigravity — `docs/issue-209-efficiency-analysis.md:158`
   (also 107 and 160): final acceptance must retain the frozen baseline's full
   verification unless trusted results prove equivalent checks and inputs.**
   The proposed test bypass examines only approved-pin-to-cleanup deletions and
   asserts that the approved product was already “100% verified.” In this
   cohort, hooks ran `check:fast` and `test:e2e`; the final `check` additionally
   runs `build` (`package.json:17–19`). There were no candidate executions or
   cached results proving the proposed inheritance. A product whose build fails
   while its hook commands pass could consequently reach final acceptance after
   an evidence-only cleanup without ever running its required build. This is
   also the exact last-cleanup classification shortcut prohibited by the issue
   protocol. Use the existing coordinator candidate/final policy and trusted
   command receipts; retain uncovered checks. An illustrative case is successful
   hook commands, no build receipt, and cleanup consisting solely of evidence
   deletions: final build must still execute.

2. **[P2] Antigravity — `docs/issue-209-efficiency-analysis.md:143`
   and `:150`: the selected plan requires preserving review and verification
   gates; delayed participation is not a vote or owner-approved roster change.**
   Automatically converting a missing ballot into an abstention or dropping its
   author can advance a revision before a required reviewer submits a concrete
   objection. For example, two early approvals and a delayed third review with
   a reproducible defect become an accepted revision instead of a revision
   request. “Majority consensus is preserved” does not establish equivalent
   review rigor. Remove these recommendations from this plan's proposal set;
   retain safe delivery recovery and explicit pre-run profile selection. Any
   future policy redesign must identify the review guarantee it gives up.

3. **[P2] Antigravity — `docs/issue-209-efficiency-analysis.md:118`
   (also 120–134, 167, and 174): event labels and savings must distinguish
   observed intervals from unmeasured causes and dissimilar-task comparisons.**
   Every listed “Nudged at” timestamp is actually `action-prepared`. For example,
   #209 Antigravity preparation is sequence 13 at `03:55:56.501Z`, but nudge 17
   is `03:55:59.378Z`. The nudge-to-accept interval is 151.720 s, not 154.6 s.
   The report then calls the turn 1.5–2.5 minutes of CLI invocation overhead and
   predicts a sub-30-second response-mode join without measuring that cause.
   In fact, sequences 64 and 147 leave about 95 s between the containment
   observation and precommit observation, with no breakdown of that interval.
   Likewise one different solo task does not establish a 35–50-minute consensus
   saving. These claims could direct follow-up work toward removing Git steps
   without addressing the dominant unmeasured delay. Correct the event joins
   and replace causal forecasts with explicit hypotheses and pilot targets.

4. **[P2] Cursor — `docs/issue-209-efficiency-analysis.md:132`
   (also 128, 138, and 152): a share of unpaused time must exclude verification
   intervals inside pauses, and an interval union is not a causal critical path.**
   #184's 555.310 s runner union includes 189.580 s during a recorded pause.
   Only 365.730 s overlaps the 58.0437-minute unpaused run: **10.50%, not 16%**.
   Its R4 runner union is 388.456 s, but only 198.876 s is outside the pause.
   The current table and recommendation therefore overstate verification's
   unpaused contribution and count paused work again when comparing savings.
   Intersect the merged runner intervals with unpaused phase intervals and label
   the result as overlap. The existing #184 journal is the sufficient focused
   reproduction; no product test is needed.

5. **[P2] Cursor — `docs/issue-209-efficiency-analysis.md:152`:
   reuse must come from trusted command receipts with equivalent coverage and
   environment, not advisory observations of passing hooks on the same tree.**
   The proposal expects a near-zero final runner “when the hooked commands
   already passed.” Current hook records are explicitly advisory and say
   `not cached: hook` (`src/verificationLog.ts:38,120`); they are not receipts.
   `src/verificationRunner.ts:121–151` also binds command, frozen policy,
   dependencies, environment and toolchain. Moreover, the full final command
   includes build, absent from the hook command pair. With the proposal as
   written, enabling this expectation either yields no reuse or encourages
   skipping uncovered work. Name adoption of the existing coordinator mode and
   command-level cache policy, retain build/install and other uncovered checks,
   and treat historical final duration as an opportunity ceiling rather than
   proof that hook telemetry can satisfy it.

6. **[P2] Claude — `docs/issue-209-efficiency-analysis.md:344`
   and `:708`: retry authorization must require positive evidence of failed
   delivery, not silence from a prompt-submission hook.**
   The proposed condition treats no `prompt-submitted` within a few seconds as
   lost and sends again. A delayed or missing hook after successful submission
   can then inject into an agent already working. The same-action duplicate
   guard cannot establish that the pane is ready. The report's reference to
   “positive hook evidence that no prompt was submitted” does not define an
   available positive observation, and the short comment omits even that
   qualification. Existing `docs/readiness-policy.md:165–174` requires a current
   ready prompt with the action absent, applicable delivery wait, and all queue,
   lifecycle and send-budget checks. Preserve those conditions if proposing a
   different back-off. A successfully delivered prompt whose hook arrives late
   must never authorize a resend merely because the five-second window expired.
   Label the delivery table as hook-confirmed-within-five-seconds observations;
   missing confirmation alone is not proof that delivery never occurred.

### Revision priorities and owner guidance

The action says idle detection and timed prelude delivery may already have been
fixed. Historical holds remain valid measurements, but **verification of the
recent fixes should precede proposing another delivery change**. Claude already
makes this distinction and reports a small, explicitly inconclusive #209 sample.
Carry that framing into the selected report. Keep readiness constraints intact;
do not interpret historical delay as permission to retry into an uncertain pane.

Codex's opening and first recommendation (`docs/issue-209-efficiency-analysis.md:4`
and `:376`) should explicitly acknowledge this new guidance. Its existing caveat
that old behavior may no longer occur is sound, but naming the current hypothesis
will keep the final comment from presenting resolved symptoms as new defects.
Measure comparable post-fix runs before claiming the historical hold or
delivery-delay opportunities remain recoverable.

Use Codex's pause/verification tables, source manifest, and receipts distinction
as the base. Claude's 27-of-33 last-agent count, submission-hook correlations, and
join observation timeline are useful supplementary evidence with the stated
coverage and causality limits. The 13.3–15.2-minute delivery scenario depends on
unchanged work time and hook coverage; it is not an observed post-fix saving.

Shorten Codex's issue-comment payload: it currently includes the complete
report, hash tables and reproduction script. Retain those in the repository
report, and publish a concise summary, measurements, qualified proposals and a
link to the pinned report, following Claude's separation of report and comment.
This is a readability improvement, not a platform-size failure.

Cursor's first two proposals largely restate the desired outcomes (shorter holds
and a faster last implementer) without specifying how to achieve them. Adopt
concrete choices from the stronger reports: validate the delivery fix, improve
owner notification where still needed, trial existing verification policy, and
evaluate a response-mode join without promising that all its turnaround is Git.
Its hold prose also says five holds/four nudge loops despite listing six/five;
correct these counts if any of that prose is reused.

Publication is still required to finish the original issue. Do not post during
comparison. The future selected publisher should follow its current action,
inspect existing comments with pagination, use one stable marker, compare the
posted body with the prepared payload, and report the resulting URL. Resolve
the candidates' R6/R7 wording in that publication action; do not mark the issue
complete from a pending receipt or modify an already-approved pin just to add a
URL. No missing URL is treated here as an R4 failure because the selected plan
explicitly deferred publication beyond parallel implementation.

### Validation performed for this comparison

I read the issue snapshot, selected plan, four bound reports, relevant readiness
and verification source, and the referenced journal events. I executed the
read-only Python snippets embedded in Claude and Codex to investigate the
delivery and overlap findings. Codex's reconciliation assertions passed across
46 historical phase rows plus the separate #209 join. Claude's reported
last-agent counts, prompt-confirmation counts and delivery-scenario calculations
reproduced. Matching numerical output does not prove the causal assumptions or
authorize retries. No product suites were rerun for this evidence-only review.

Existing #209 journal observations record the following successful implementation
hook checks (sequence numbers are in `issue-209/journal.jsonl`):

| Candidate | `check:fast` success | `test:e2e` success | Submission accepted |
| --- | --- | --- | --- |
| Antigravity | 852 | 891 | 899 |
| Cursor | 913 | 917 | 925 |
| Claude | 952 | 954 | 956 |
| Codex | 958 | 961 | 963 |

Cursor and Claude each have an earlier failing precommit observation (864 and
933); Codex has three earlier failed setup attempts (935, 936, 951), followed by
the successes above. These are recorded hook observations, not coordinator final
verification at an approved pin and not suites I ran in this comparison. They
also do not validate the reports' factual claims; those require the evidence
checks above.

## Verdict

Select **Codex `15a02a905425b5da3c891f274302f9a3c0a7ef2e`** for revision.
Keep its measurement and verification safeguards, incorporate the recent-fix
validation framing and concise publication format from Claude, and complete the
single issue comment through the selected publication action. The other three
pins have the concrete corrections listed above; none should be published as-is.

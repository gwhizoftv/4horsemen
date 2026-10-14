# Issue 209: measure recent coordinator phases and publish efficiency proposals

The issue asks for analysis of the last five issues run with `coord <issue>` and
a proposal posted as a comment to `gwhizoftv/4horsemen#209`. Deliver a measured
report and that comment. Proposed workflow improvements are recommendations for
later work; this issue does not implement them.

## Exact File List to be changed or deleted

None. No existing source, tests, dependencies, configuration, hooks, or runtime
records need modification. Read the historical runtime as evidence only.

## Exact file list to be created

- `docs/issue-209-efficiency-analysis.md`: the sole new deliverable file. It holds
  the measured findings, reproducible methodology, ranked proposals, and the
  exact comment body, followed by a publication receipt containing the comment
  URL. A versioned report lets the coordinator compare and review candidate
  analyses before the selected reviser publishes one consolidated comment.

The current action creates only `.plans/issue-209/plan.md`. Later actions' required
signals and reviews follow their supplied scaffolds; they do not expand this
deliverable file map. Temporary calculations, if needed, belong in ignored
`.codex/tmp/`, not in new maintained scripts or fixtures.

## Reuse and Scope

Use the frozen issue description in
`/Volumes/4TB-SOURCE/REPOS/4horsemen/coord-runtime/issue-209/github-issue.json` and
the cutoff `2026-10-14T03:55:51.161Z` from this issue's `start.json`.

The runtime inventory contains six earlier runs. Selecting the five most recent
by `start.json.createdAt` before the cutoff gives the following cohort in
chronological order, not issue-number order:

| Issue | Start time (UTC) | Profile | Terminal gate sequence |
| --- | --- | --- | --- |
| 177 | 2026-10-10T22:48:18.145Z | consensus | 3418 |
| 195 | 2026-10-12T22:43:41.151Z | consensus | 723 |
| 184 | 2026-10-13T20:31:20.486Z | consensus | 625 |
| 204 | 2026-10-14T01:55:48.449Z | consensus | 768 |
| 206 | 2026-10-14T03:24:28.568Z | solo | 71 |

Exclude older #172 and the active #209. All five selected runs have a terminal
`gate-advanced` event; a late lifecycle event is not the run's end. Record each
run's session identity, baseline, roster, and relevant configuration in the
report's source inventory. Preserve this cohort if new issues start later.

Reuse the existing read-only `coord analytics --issue N --coord-runtime ROOT`
command, `readAnalyticsRuntime`/`readJournalForAnalytics` in `src/state.ts`, and
`buildAnalytics`/`renderAnalytics` in `src/analytics.ts`. The existing
`AnalyticsReport`, `PhaseAnalytics`, `WaitAnalytics`, and `JournalEvent` types
define the metrics; no new abstraction is needed. Follow `derivePhases`,
`derivePausedMs`, `deriveResponseLatency`, and
`deriveEvidencePublicationLatency` for interval and retry semantics. Consult
`src/verificationLog.ts` for runner records and `src/steps.ts` for profile gates.

Use `docs/analytics.md` as methodological context, not as a source of current
five-run measurements. Existing `test/analytics.test.ts` cases and
`test/support/fixtures/analytics-journal.jsonl` and
`analytics-journal-format2.jsonl` document pause, repeated-round, retry,
unavailable-data, and verification-overlap behavior. Reuse these expectations
without copying fixtures or adding tests for unchanged analytics code.

Implementation procedure:

1. Read each selected `start.json`, `journal.jsonl`, and `cursors.json`; inventory
   `verification-logs/*.log` and `agents/*/terminal/*.log`. Record source-relative
   paths, journal sequence ranges, and timestamps for every substantive finding.
   Include source hashes and calculation commands/snippets in the report so
   another agent can reproduce the tables without the author's scratch files.
2. Produce a per-issue, per-phase table of elapsed minutes, overlapping recorded
   pause minutes, and elapsed minus recorded pauses. Keep repeated R6 rounds
   separate in the detailed table. Mark solo-profile omitted phases as N/A.
   Add per-run totals and a phase ranking for the four consensus runs separately
   from #206. Show sample sizes and define any aggregation/median convention.
3. Join action events by `(agent, actionId)`: preparation to first recorded
   nudge, first outstanding nudge to intent, and intent to matching verification
   result. Report missing endpoints instead of inventing intervals. For ballots,
   separate `response-accepted` latency from batch pending-to-published latency.
   Identify the last accepted required agent/action at slow gates, with concrete
   sequence evidence; do not sum concurrent agents' waits into phase time.
4. Examine holds/pauses, delivery deferral reason codes, repeated nudges,
   rejected submissions, revision rounds, and verification commands alongside
   the slow phases. Inspect the available final-check logs and relevant terminal
   excerpts to corroborate explanations. Terminal output lacking timestamps is
   qualitative evidence only. Missing older terminal logs are an explicit gap.
5. Report executed/skipped verification counts, durations by command and
   trigger, failures/retries, and the union of runner intervals clipped to each
   phase. Separate summed runner effort from elapsed overlap; avoid counting
   `final-check` and its `verification-run` twice. Manual test commands are
   unobserved unless a log supports them. A deferral count alone does not measure
   delay; unpaused time is not proof of active agent computation.
6. Rank a small set of recommendations by observed avoidable delay, affected
   phases, confidence, effort, and risk. Each must cite a concrete cohort example
   and state a validation metric for future comparable runs. Check whether an
   improvement already exists in the current source/configuration before
   recommending it. In particular, existing coordinator verification, cache
   receipts, private ballots, and profile selection are candidates for adoption
   analysis, not automatically missing product features. Label all savings as
   estimates with assumptions; do not add overlapping savings or infer a solo
   speedup from one dissimilar task. Preserve review and verification gates.
7. During implementation, produce candidate reports for review without posting
   competing issue comments. During `R6.revise`, the coordinator-selected reviser
   consolidates the findings and publishes the single report's comment section
   to #209. Use `gh issue comment 209 --repo gwhizoftv/4horsemen --body-file PATH`
   with an exact UTF-8 payload and the marker `<!-- coord-issue-209-analysis -->`.
   First inspect existing issue comments with pagination; reuse an already
   matching publication and update only the previously identified report comment
   if a later revision changes it. Never edit unrelated discussion. Read the
   posted body back, compare it to the prepared payload, and record the URL in
   the report's receipt outside the comment-body section. A failed publication
   remains incomplete and is reported with its exact error; a PR alone does not
   satisfy the requested issue comment.

No external data service, dependency, maintained analysis tool, or product
behavior change is needed. The requested issue comment is the only external
publication beyond coordinator-required commits and pushes.

## Tests

No new product tests: the deliverable is an analysis of existing evidence.
Perform these focused acceptance checks against the report, rather than writing
tests that assert prose exists:

- Reproduce the existing analytics output for all five runs with
  `coord analytics --issue N --coord-runtime /Volumes/4TB-SOURCE/REPOS/4horsemen/coord-runtime`
  for `N = 177, 195, 184, 204, 206`. Keep coverage warnings. A read-only smoke
  invocation for #206 already works and reports 18.98 elapsed minutes, four
  phases, and 171.7 seconds for the recorded final check; this is historical
  evidence, not a test suite executed for #209.
- Independently recompute phase boundaries and pause intersections from the
  journal timestamps with a small inline Python/Node calculation documented in
  the report. Assert phase durations sum to terminal minus started time before
  rounding, pause intersections sum to run pause time, and every unpaused
  duration equals elapsed minus pauses. Exercise the observed #177 repeated R6
  rounds, #184 paused phases, #204 absence of pause events, and #206 solo gates.
- Check representative slow-action joins and overlapping runner intervals
  directly against cited event sequences. Every reported number must be
  reproducible or explicitly marked unavailable/estimated; no unsupported zeros.
- Confirm five-run coverage, every observed phase, source citations, actionable
  ranked recommendations, and a successful #209 comment URL/body readback.

For this plan-only action, validate required headings/nonempty sections and
source claims; evidence-only hooks require no product suite. For the later new
report file, the actual runtime configuration has no documentation allowlist or
coordinator-verification mode: the installed commit hook owns
`pnpm run check:fast` and the push hook owns `pnpm run test:e2e`. Do not manually
duplicate those commands immediately before commit/push. The coordinator's
frozen final command is `pnpm run check`; cite its recorded result separately
from checks performed by the agent. Do not change configuration to evade checks.

## Alternatives Rejected

- Implementing optimizations now would expand an analysis-and-proposal issue
  before the owner chooses which tradeoffs to accept.
- Building a new reporting CLI duplicates the existing analytics command for a
  one-time investigation. Any essential extra calculations belong in reproducible
  snippets in the report.
- Selecting by issue number, analyzing only completed consensus runs, or using
  filesystem modification times would change the requested five-run cohort.
- Comparing raw elapsed totals without pauses and profiles would misattribute
  owner holds or removed phases to agent speed.
- Posting every candidate report would flood the issue with competing proposals;
  use the uniquely selected reviser for one consolidated, repeatable publication.
- Delivering only a repository document or PR would omit the explicit issue
  comment requested by #209.

## Risks and Mitigations

- Historical coverage varies: #177/#195 have final verification logs but no
  terminal `.log` files in the inspected inventory; #184/#204/#206 also retain
  terminal logs. Report missing evidence without substituting another run.
- Pauses, task complexity, roster differences, and source-version changes make
  five runs a small observational sample. Distinguish measured delay, plausible
  cause, and proposed benefit; show elapsed and unpaused figures together.
- Runner timestamps are advisory and command overlap is not a reconstructed
  causal critical path. Clip/union intervals, retain schema warnings, and avoid
  claiming every overlapping test second was avoidable wall time.
- Source logs can contain machine paths and incidental private output. Publish
  only relevant sanitized excerpts with runtime-relative citations and enough
  event identity to audit; do not attach raw transcripts or credentials.
- Publication may be retried after an interrupted action. A stable marker,
  existing-comment inspection, a uniquely selected publisher, and body readback
  prevent duplicate comments and false completion claims.

## Conclusion

Deliver one evidence-backed report covering #177, #195, #184, #204, and #206,
and publish its consolidated proposal as a verified comment on issue #209.
Completion requires accurate per-phase measurements, qualified recommendations,
and the comment receipt; optimization implementation is subsequent work.

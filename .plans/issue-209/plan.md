# Issue 209 — Phase-length analysis and efficiency proposals

Issue 209 asks for an analysis of the last five issues run with coord, proposals that would shorten phases, and that proposal posted as a comment on the issue. This plan does not change how phases run. The implementation writes one proposal document and posts those same bytes as the GitHub comment.

## Exact File List to be changed or deleted

None. No source, test, hook, config, or existing document is modified.

## Exact file list to be created

- `docs/issue-209-phase-efficiency.md` — the proposal. The GitHub comment body is this file.

## Reuse and Scope

The five runs are the latest `start.json` `createdAt` values under `/Volumes/4TB-SOURCE/REPOS/4horsemen/coord-runtime`, excluding this in-progress issue. In createdAt order they are 206 (solo), 204, 184, 195, and 177 (all consensus). Issue 184 started after 195. Issue 172 is older and is not included. Issue 209 is not included.

Phase clocks already exist. Reuse `buildAnalytics` and `renderAnalytics` in `src/analytics.ts`, reached through `coord analytics` in `src/cli.ts` and `readAnalyticsRuntime` in `src/state.ts`. `derivePhases` times each phase from `started` and `gate-advanced`. `derivePausedMs` subtracts `paused` / `resumed` from the run only. The existing case "subtracts paused time, anchors retries at the first nudge, and keeps missing check duration nullable" in `test/analytics.test.ts` locks that run-level split. Phase `durationMs` still includes pause. The proposal must not describe that as agent work.

Also reuse the journal fields already written: `nudge-deferred` `details.code`, `hold-created` `details.reason`, `verification-run` `durationMs`, and the analytics verification block (`criticalPathWaitMs`, `byTrigger`, `reused`, `avoidedMs`). Terminal paths come from `terminalLogs` on `AgentRuntimePaths` in `src/paths.ts`. Read `docs/analytics.md` for what those fields mean. Do not edit it.

The new document is the only new file. The issue's deliverable is a written proposal, and a plan with no repository path cannot be selected. Putting the proposal in `docs/analytics.md` would mix a dated recommendation into the measurement reference.

The document must contain these sections:

- Runs — issue, profile, roster, analytics elapsed / paused / unpaused.
- Phase table — for every analytics phase: name, round, analytics duration, paused overlap, unpaused remainder, action count, state. Paused overlap uses the `derivePausedMs` pairing clipped to that phase: a second `paused` while one is open does not start another interval, a `resumed` with no open pause is ignored, and an open pause runs to the phase end. A null result is written as invalid, and that phase is not used as evidence.
- Waits and verification — transcribed from the analytics sections Agent wait, Agent response latency, Evidence publication latency, and Recorded verification. Do not recompute those medians.
- Deferrals and holds — counts of `nudge-deferred` codes and `hold-created` reasons.
- Logs — terminal logs exist for 184, 204, and 206. Use them only to check whether a `working` or `no-idle-sentinel` deferral happened while that pane was idle. Issues 177 and 195 have no terminal directory; say so. Do not quote large spans.
- Proposals — each kept item states the measured fact, the existing mechanism, the future change that would shorten a run, and that this issue does not implement it.

Evaluate these candidates and keep a candidate only when the tables support it:

1. Per-phase pause. If any phase's paused overlap is most of its analytics duration, propose that phase lines show paused time the way the run line already does. Name `derivePhases` and `renderAnalytics` as the later change.
2. Nudge-loop holds. If those long pauses come from `hold-created` reason `nudge-loop`, propose shortening them by naming the deferral code that consumed the nudge budget. Do not change nudge policy here.
3. Issue 177 lifecycle kinds `status` and `working`. If those kinds are absent on 184, 195, 204, and 206, record that the high-frequency lifecycle log is already gone. That is not a proposal.
4. Verification. Propose more receipt reuse only when an issue's critical-path verification wait is at least a quarter of its unpaused run and avoided time is small beside that wait. Otherwise say verification is not the phase-length problem.
5. Profile. If solo 206 has fewer phases and a shorter unpaused run than the consensus issues, propose that the owner start small issues as solo or reviewed. Do not propose removing consensus steps.
6. Implement and finalize. Rank phases by unpaused duration. Propose a test or final-check change only when the same phase is in the top two unpaused phases of at least two issues and the analytics final-check or verification lines show command time is most of that phase. Otherwise say the remainder is agent writing time and is outside this proposal.

## Tests

No new test, and no new case in the existing analytics test file. The journals and terminal logs are outside the clone, so a vitest case cannot see a wrong duration, and asserting the proposal text would freeze one machine's runtime into CI.

The implementer checks the document like this:

- Run `coord analytics --issue 177 --coord-runtime /Volumes/4TB-SOURCE/REPOS/4horsemen/coord-runtime`, and the same command for 184, 195, 204, and 206. Every duration and latency in the document must match that output. Usage and token sections may be omitted when coverage is unavailable.
- Recompute per-phase paused overlap from each issue's journal with the pairing above. The phase table's paused column must match.
- Keep only proposals whose cited numbers appear in those outputs or counts.
- Push the commit, then post the committed file with `gh issue comment 209 --repo gwhizoftv/4horsemen --body-file docs/issue-209-phase-efficiency.md`. The comment body is the file, with no extra preamble.

Issue 209's frozen start has no documentation profile, so the hook classifies the new document as a product change and runs `pnpm check:fast`. The hook owns that check. Do not run it again immediately before committing, and do not claim the coordinator's final `pnpm check`.

## Alternatives Rejected

- Implementing the shortenings in this issue. The issue asks for the proposal as a comment.
- Choosing the last five GitHub issues by number or close time. Issues such as 200, 199, and 197 have no journal left under this coord root, and 184 started after 195.
- Reading the older runtime at /Volumes/4TB-SOURCE/REPOS/coord/coord-runtime. Issue 209's start record records this workspace's coord root.
- Deriving phase durations from terminal logs. They are missing for two of the five issues and are not the phase clock.
- Adding the new document to a documentation allowlist. That edits config, which this issue does not ask for, and the frozen start would still classify the path as product.

## Risks and Mitigations

- A multi-hour phase can be a nudge-loop hold. The phase table shows paused overlap beside the analytics duration, and proposals cite unpaused time or the hold.
- `coord analytics` also reads transcripts and may report usage as unavailable. Phase times still come from the journal. The proposal does not wait on token totals.
- Commenting before the push leaves the comment without a reviewable pin. Push first, then comment the committed file.
- A later implementer could start changing idle detection or analytics while writing the doc. The file map contains only the new document.

## Conclusion

The implementation publishes measurements for issues 177, 184, 195, 204, and 206, proposes only the shortenings those measurements support, and posts that document as a comment on issue 209. Coordinator behavior stays as it is.

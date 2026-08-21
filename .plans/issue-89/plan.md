# Issue 89 plan — Phase 1: the four metrics the issue names, and nothing else

- Issue: https://github.com/gwhizoftv/coordination/issues/89 (body updated 2026-08-21T05:26Z)
- Author: Claude
- Branch: `issue-89/claude`
- Baseline: `origin/main` at `1bfc7f9`
- Inputs considered:
  - Updated issue body — **authoritative on scope**
  - `docs/analytics.md` (this clone, untracked) — issue-76 measured baseline, §3 gap list
  - Cursor, Codex, Antigravity `.plans/issue-89/plan.md` and the two discussions

## Scope comes from the issue, not from my inference

The updated issue body specifies the phases itself:

> 1. Enhance any metrics/analytics we need to have accurate **time, token count,
>    tool count, and phase count** for our protocol
> 2. Enhancements/improvements based on the metrics.
>
> …highly efficient and simple in our approach to design and implementation,
> without over building or over engineering.

That replaces the scope rule I had inferred in earlier drafts. Phase 1 admits an
item only if it is required to produce one of those four counts accurately.
Everything else is Phase 2 or later, and "without over building" is an explicit
constraint I am treating as a requirement rather than a style note.

### Where the four metrics stand today

| Metric | Source today | Gap |
| --- | --- | --- |
| **Phase count** | `gate-advanced` events, already journaled with `from`/`to`/`round` (`src/runLoop.ts:876`) | **None** — needs a reader |
| **Time** | Every journal row carries `at`; phase intervals and per-agent `nudged` → `intent-seen` waits derive from it | **None** — needs a reader |
| **Token count** | Vendor transcripts only; the coordinator records zero token telemetry | Journal identity to join on |
| **Tool count** | Vendor transcripts only, same records | Same join |

Two of four were never missing — `docs/analytics.md` §2.1 and §2.3 published
those tables by hand from issue-76's existing journal. They need a reader, not a
writer. **The whole gap is the transcript join**, which today is a wall-clock
approximation (§2.2) because `sessionId` and `transcript_path` never reach the
journal.

Closing that one gap yields tokens **and** tool counts from the same parse, since
tool-use records sit in the same transcript as the usage records.

Consequently Phase 1 does not touch `src/runLoop.ts`, `src/action.ts`, or
`src/state.ts`.

### Join at report time, not by journaling usage

Earlier drafts of this plan added a `token-usage` journal event written at each
`Stop`. **Cursor's plan is right that this is unnecessary**, and I have adopted
its approach: once `sessionId` and `transcriptPath` are in the journal, the
report can join transcripts at read time. That removes the new journal event, the
`journalEventSchema` enum change, and any write-path duplication of vendor data —
strictly simpler for the same output, and it works retroactively on any journal
that carries the identity fields.

## Exact File List to be changed or deleted

### Changed — Phase 1

- `src/agentEvent.ts` — extend the `agent-lifecycle` journal projection
  (`src/agentEvent.ts:291`) from `{vendor, event, kind, execution, health}` to
  also carry `sessionId` and `transcriptPath` when the normalized observation
  supplies them. The Claude hook payload already delivers `transcript_path` and
  the code reads `session_id` beside it (`src/agentEvent.ts:114`) — this is a
  projection change, not new plumbing. Additionally suppress the `appendJournal`
  call when an observation is status-only **and** byte-identical to the previous
  consecutive status tick for that agent, with lifecycle state and the watchdog
  still updating on every observation. The debounce is admitted to Phase 1
  because antigravity status ticks are 95% of lifecycle events and 80% of journal
  bytes (`docs/analytics.md` §3.6), which corrupts the phase and action counts
  Phase 1 exists to report.
- `src/agentLifecycle.ts` — carry optional `transcriptPath` on the normalized
  observation, alongside the `sessionId` it already has
  (`src/agentLifecycle.ts:60`).
- `src/cli.ts` — register `coord analytics --issue <n>` with `--json`; extend
  help text (command surface around `src/cli.ts:904`).
- `package.json` — bump `version` to whatever is strictly greater than
  `origin/main` at ship time. The non-`main` gate
  (`test/versionBump.test.ts:29`) enforces this on every push, so the exact
  number depends on what has already shipped from this branch — do not hard-code
  it here.
- `config.product.example.json` — update the pinned `"version"` (line 33) in
  lockstep with `package.json`.
- `test/agentEvent.test.ts`, `test/cli.test.ts` — see Tests.

**Not changed in Phase 1:** `src/runLoop.ts`, `src/action.ts`, `src/state.ts`,
`src/paths.ts`, `AGENTS.md`. Each appeared in an earlier draft of this plan;
none is required by the four metrics.

### Deleted

None. The `renderLog` removal (`docs/analytics.md` §3.7) and the tracked
`AGENTS.md` trim are both Phase 2 candidates — the trim in particular is a
*change whose effect Phase 1 is supposed to measure*, so shipping it inside
Phase 1 would destroy its own before-reading.

## Exact file list to be created

- `src/analytics.ts` — the reader. Journal-only sections always available:
  **phase count** and actions per phase from `gate-advanced` and
  `action-prepared`; **time** as phase wall-clock from `started` +
  `gate-advanced.at`, run total, and per-agent `nudged` → `intent-seen` waits.
  Transcript-joined sections when journaled identity permits: **token count** and
  **tool count** per phase per agent. Human summary by default; `--json` for
  before/after comparison. Every reported figure carries a coverage state —
  `complete`, `partial`, or `unavailable` — and a metric that was never recorded
  reports as `null`, never `0`.
- `src/transcriptRead.ts` — bounded, vendor-specific reader, isolated so
  vendor-shaped parsing is testable and replaceable. Given a `transcriptPath` and
  a time or session window, returns per-turn `{tokens: {input, output, cacheRead,
  cacheWrite}, toolCalls: n}`. Reads numeric usage fields and tool-use record
  *counts* only — never message content, never tool arguments or results.
  Returns `undefined` for a vendor exposing neither, which is normal: cursor and
  antigravity have no local usage store at all (`docs/analytics.md` §1.4).
- `test/analytics.test.ts`, `test/transcriptRead.test.ts` — see Tests.
- `test/support/fixtures/analytics-journal.jsonl` — issue-76-shaped fixture.
- `test/support/fixtures/transcript-claude.jsonl`,
  `test/support/fixtures/transcript-codex.jsonl` — small fixture tails carrying
  both usage records and tool-use records, in each vendor's shape.
- `docs/analytics.md` — promote the existing **untracked** file to a tracked
  measurement contract: the four metrics and their definitions, how to run
  `coord analytics`, per-vendor coverage (claude and codex report tokens and
  tools; cursor and antigravity report neither), the privacy boundary, and
  explicit non-goals. The ad-hoc Python reconstruction scripts are replaced by
  the CLI; the issue-76 measured tables stay as the baseline to beat, and the
  §3 items Phase 1 skips are recorded as deferred rather than lost.

## Tests

`pnpm check:fast` before every commit; `pnpm check` is the acceptance gate.

- `test/analytics.test.ts` — **new.** Phase count and actions per phase match
  hand-counted fixture values; phase durations match hand-computed minutes with
  the first phase measured from `started`; run total equals the sum of phases;
  per-agent waits reproduce known count/median/max; token and tool counts bucket
  to the correct phase and agent when a fixture transcript is joined; **a journal
  with no identity fields still reports phase count and time, omitting the token
  and tool sections rather than erroring**; a metric never recorded reports
  `null` and coverage `unavailable`, never `0`; `--json` parses and carries the
  same figures as the human summary.
- `test/transcriptRead.test.ts` — **new.** Claude and codex fixtures each yield
  expected token deltas **and** tool-call counts; a transcript with usage but no
  tool records reports tools as `0` while a vendor with no store at all reports
  `undefined` — the two cases must not collapse; a truncated or malformed final
  line returns `undefined` rather than throwing; **no message content, tool
  argument, or tool result appears in the returned object**, asserted by shape so
  a later field addition cannot leak text silently.
- `test/agentEvent.test.ts` — `sessionId` and `transcriptPath` appear in
  `agent-lifecycle` details when supplied, absent (not `null`) when not; **two
  identical consecutive status-only ticks append one journal row, not two**; a
  differing tick still appends; lifecycle state and the 45 s watchdog
  (`AGENT_OBSERVABILITY_WATCHDOG_MS`) update on suppressed ticks too.
- `test/cli.test.ts` — `coord analytics --issue <n>` exits 0 against a fixture
  runtime root and prints all four metric sections; `--json` emits parseable JSON
  on stdout and nothing else; the command appears in help; a missing journal
  exits non-zero with a clear message.

**Acceptance for Phase 1:** `coord analytics --issue 76` run against the
**existing** issue-76 runtime journal must reproduce the phase durations and
per-agent latency tables already published by hand in `docs/analytics.md` §2.1
and §2.3. If it cannot re-derive the baseline it replaces, it is not measuring
the right thing and Phase 2 must not proceed on its numbers.

## Alternatives Rejected

- **Journal a `token-usage` event at each `Stop`** (my own earlier drafts):
  rejected in favour of Cursor's report-time join. Journaling usage duplicates
  vendor data into the coordinator's write path and needs a
  `journalEventSchema` enum change; joining at read time needs neither and works
  on any journal carrying the identity fields.
- **Substitute action/bound-input bytes for tokens and tool calls** (Codex's
  plan, which explicitly rejects vendor token and tool-call adapters): a
  defensible engineering position — coverage really does differ by vendor — but
  it does not satisfy this issue, which names token count and tool count as
  Phase 1 deliverables. Bytes are a transport proxy; `docs/analytics.md`'s own
  non-goals say action bytes are not tokens. Partial vendor coverage is better
  reported honestly than replaced by a proxy.
- **`durationMs` on `gate-advanced`, `verify-result`, `final-check`**
  (Antigravity Phase 1, my earlier drafts): every one of these intervals is
  derivable from timestamps already present; `docs/analytics.md` §3.3 says the
  `gate-advanced` case is redundant outright. Coordinator verification is
  already known to be ~1.05 s median and is not a Phase 2 target.
- **`action-timing` delivery chain and `preparedAt`** (Antigravity Phase 1, my
  earlier drafts): diagnostics for *why* an agent was slow. Time and phase count
  are both measurable without them.
- **Verify-failure classification, artifact byte counts, roster/flags in
  `started`**: all useful, none needed for the four metrics, and all implementable
  later as read-time analysis over journals already written — so deferring costs
  a later commit and nothing else.
- **Ship the `AGENTS.md` trim or `renderLog` removal in Phase 1**: both are
  Phase 2 improvements. The trim is precisely a change Phase 1 should measure;
  landing it inside Phase 1 would erase its own baseline.
- **Ship turn-collapsing now** (Codex B/C, Antigravity Phase 2, Cursor Phase 2):
  the substance of Phase 2 and the largest available saving. It follows Phase 1
  by the issue's own ordering.

## Risks and Mitigations

- **`src/transcriptRead.ts` reads a vendor's private store.** The sharpest risk
  in Phase 1, admitted only because tokens and tool counts are unmeasurable
  otherwise and the issue requires both. *Mitigation:* bounded reads; numeric
  usage fields and tool-record **counts** only, never content, arguments, or
  results, asserted by shape; parse failure yields `undefined`, not an error; all
  vendor-shaped parsing confined to this one module so it can be replaced when a
  vendor exposes a supported usage API.
- **`transcriptPath` is a filesystem path into a vendor store, journaled into a
  file the owner may share.** *Mitigation:* record the path only; never copy
  transcript contents into the journal.
- **Two of four agents can report neither tokens nor tool calls.** *Mitigation:*
  coverage states on every figure, and `null` rather than `0` for
  never-recorded metrics, so a run with two silent vendors cannot read as a run
  that used no tokens. Directly asserted in `test/analytics.test.ts`. (This
  discipline is taken from Codex's plan, which handles it best.)
- **Debouncing status ticks hides a real state change.** *Mitigation:* suppress
  only on byte-identical consecutive status-only observations — never for
  `PreInvocation` / `PostInvocation` or any execution/health transition;
  lifecycle state and the watchdog keep updating.
- **Tool-call counting is not comparable across vendors**, since each defines a
  "tool call" differently. *Mitigation:* report per-vendor, never as a single
  cross-roster total; document each vendor's definition in `docs/analytics.md`.
  Phase 2 compares a vendor against itself before and after.
- **Fixture journals drift from real journal shape.** *Mitigation:* fixtures are
  validated through `journalEventSchema` inside the test, and the issue-76 replay
  in Tests is a second guard against fixture-only correctness.
- **Phase 1 delivers no speed-up.** Correct and intended — the issue asks for
  metrics first and improvements second.

## Conclusion

Phase 1 is three source files plus a reader, and it touches neither the run loop,
the action format, nor the journal schema.

That follows from one fact the updated issue makes decisive: of its four named
metrics, **two were never missing**. Phase count and time have been in every
journal we have written, which is how `docs/analytics.md` published those tables
by hand for issue-76. They needed a reader. The real gap is the transcript join —
and closing it delivers token count and tool count together, because usage
records and tool-use records live in the same transcript.

So the honest shape of Phase 1 is: put `sessionId` and `transcriptPath` into the
journal, stop the status-tick noise that corrupts the counts, and write
`coord analytics`. Everything else the four plans propose measuring explains
*why* a number moved; the issue asks only to measure the numbers, simply, without
over-building — and the deferred items can be added later against journals
already on disk.

The acceptance test is deliberately unforgiving: `coord analytics --issue 76`
must re-derive the hand-computed §2.1 and §2.3 tables from the journal we already
have, before Phase 2 is allowed to rely on any number it prints.

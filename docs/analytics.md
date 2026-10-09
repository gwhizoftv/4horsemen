# Four Horsemen analytics — what we can measure today, and what we cannot

## Verification measurements (#162)

`verification-run` records runner invocations and explicit skips separately from
artifact validation (`verify-result`). Each records trigger, phase, input identity
(index tree or commit range), selected class/reason, command, start/end time,
duration, exit code, and skip/cache reason.
Hook observations are advisory, written to ignored clone-local
`.coord/verification/<measurementId>.json` files and ingested idempotently into the
matching issue session's journal. Invalid/stale observations do not affect gates;
telemetry failures do not authorize skipping verification. Manual branches and
hooks unable to read a matching issue session report unavailable attribution and
do not queue records; they are not included in issue runner totals. Manually
invoked commands are not instrumented.

Ingestion drains at most 128 directory entries per agent/tick, discarding invalid,
stale, oversized, and unbound records rather than re-reading them forever. The
coordinator timestamps journal ingestion itself; runner timestamps remain advisory
details, with reversed/inconsistent intervals and excessive future skew rejected.
Replay IDs are loaded once per coordinator owner from the journal and retained in
memory, avoiding a full-journal scan per measurement; restart restores that set.

`coord analytics` reports recorded runner counts by phase, skips, aggregate
runner time, and non-overlapping verification wait (the union of recorded runner
intervals, so concurrent agents are not double-counted). These are observed costs,
not a reconstructed causal critical path or an invented issue-wide testing total.
An absence of records means unobserved coverage, not proof that no tests ran.
Existing `final-check` events remain available for old readers; they are not
counted again in the new totals. Failed and retried runners count individually.

Coordinator verification (#170) adds the `candidate` phase, an explicit
`cacheReason` (why a command ran: no cache declaration, receipt miss, …), the
attempt number, log path, receipt id and limiter `queueWaitMs` to each
`verification-run`. `verification-reused` and `verification-joined` record
commands satisfied without running, with the original run's duration, and
`candidate-check` records each gate outcome. The report adds runner counts and
time by trigger (`hook`, `candidate`, `final`), reused and joined counts, time
avoided (the original durations those results replaced) and total limiter queue
wait; queue wait is part of the non-overlapping verification wait.

The historical analysis below describes the older, pre-instrumentation baseline.

Preparation for issue **#89** ("Increase speed and efficiency, reduce token
usage, tool calling"). Issue 89 asks whether we can push work into the
coordinator, consolidate messaging, and add context files to cut token count and
tool calls. None of that is answerable without a baseline, so this document
does three things:

1. States exactly which timing and token facts the runtime records **today**,
   and where each one lives.
2. Shows **how the current numbers were constructed** — the joins are non-obvious
   and two of them are wall-clock guesses, which is itself a finding.
3. Lists **what is still missing**, ranked by how much it blocks issue 89.

Every number below is measured from the issue-76 consensus run
(`2026-08-20T18:12:56Z` → `19:17:24Z`, profile `consensus`, roster
`claude, codex, cursor, antigravity`), reconstructed from
`<coord-root>/issue-76/`. It is one run, so
treat the absolute values as a baseline to beat, not as a stable average.

---

## 1. Sources of truth that exist today

### 1.1 `journal.jsonl` — the only durable, append-only history

Schema: `src/state.ts:367` (`journalEventSchema`); writer: `src/state.ts:561`
(`appendJournal`); path: `src/paths.ts:146`.

Every record already carries `at` (RFC 3339 with offset), a monotonic
`sequence`, and optional `agent` / `actionId` / `submissionSha`. **Timestamps
are not missing from the journal.** Modern `final-check` rows additionally
carry the measured command `durationMs`; older rows retain an unavailable
duration rather than being interpreted as zero.

Issue-76 record counts:

| type | count | what it pins down |
| --- | ---: | --- |
| `agent-lifecycle` | 1119 | vendor hook traffic (95% is one agent — see §3.6) |
| `nudged` | 46 | coordinator → agent delivery attempt |
| `intent-seen` | 39 | agent wrote `complete` (SHA or response marker) |
| `verify-result` | 39 | coordinator accepted/rejected the submission |
| `action-prepared` | 37 | an `action.md` was written |
| `gate-advanced` | 13 | **phase boundaries** |
| `agent-observability-degraded` | 10 | watchdog fired (45s, `AGENT_OBSERVABILITY_WATCHDOG_MS`) |
| `final-check` | 2 | hermetic `checks` tier at the approved commit |
| `started` / `publication-pending` / `pr-created` | 1 each | run boundaries |

Format 4 also journals ballot events used by analytics:

| type | what it pins down |
| --- | --- |
| `response-accepted` | private ballot response archived (agent latency end) |
| `ballot-batch-pending` | evidence commit frozen; push not yet confirmed |
| `ballot-batch-published` | evidence branch fast-forward succeeded |
| `ballot-batch-failed` | push/reconcile failed (retries keep the same commit SHA) |
| `ballot-batch-invalidated` | unpublished batch superseded (roster/restart) |

`coord analytics` reports agent wait (`nudged` → `intent-seen`), agent response
latency (`nudged` → `response-accepted`), and coordinator evidence-publication
latency (`ballot-batch-pending` → `ballot-batch-published`) separately.
Publication retries are not counted as additional agent turns.

`gate-advanced` is the load-bearing event for all phase analytics. It records
`{from, to, round}` and nothing else, but with `at` that is enough to cut the
whole run into phases.

### 1.2 `cursors.json` — current state plus acceptance times

`agentCursorSchema` (`src/state.ts:256`) carries `updatedAt` per agent;
`acceptedSubmissionSchema` (`src/state.ts:280`) carries `acceptedAt` per accepted
submission. This is last-write-wins state, not history — it answers "when was
this step accepted" but not "how long did each attempt take".

### 1.3 `agent-lifecycle.json` — the richest timing we have, and the most perishable

`lifecycleActionSchema` (`src/agentLifecycle.ts:14`) already tracks the full
delivery chain per action:

```
orderedAt → injectedAt → retryableInjectionAt → acceptedAt → workflowCompleteAt
```

That is precisely the breakdown issue 89 needs to know whether nudge delivery or
agent thinking dominates. **It is overwritten on every new action** and only the
coarse `{vendor, event, kind, execution, health}` projection reaches the journal
(`src/agentEvent.ts:291`). The four-timestamp delivery chain is therefore
unrecoverable for any action but the current one.

### 1.4 Vendor transcripts — the only place token usage exists at all

The coordinator records **zero** token telemetry. Everything we know about token
cost comes from vendor-private stores:

| agent | store | usage available? |
| --- | --- | --- |
| claude | `~/.claude/projects/<slug>/<sessionId>.jsonl` | **Yes** — per assistant message: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, plus `timestamp` |
| codex | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` | **Yes** — `event_msg` / `token_count` with `total_token_usage` and `last_token_usage` (cumulative + delta), `cached_input_tokens`, `reasoning_output_tokens`, `model_context_window` |
| cursor | journaled `agent-usage` from managed `.cursor/hooks.json` (`postToolUse`, `afterAgentResponse`, optional token fields on `stop`) | **Yes when hooks supply counters** — normalized `{input, output, cacheRead, cacheWrite, reasoning}` fields round-trip from the journal and `conversation_id` / `generation_id` correlate to lifecycle turns; no `store.db` scrape |
| antigravity | — | **No local store found** |

Token analytics is currently possible for claude, codex, and cursor. Cursor
tokens come only from supported hooks; a session whose hooks did not supply
counters is explicitly `unavailable`, never a synthetic zero.

### 1.5 `render.log` — declared but never written

`src/paths.ts:170` defines `agentRuntimePaths().renderLog`. Nothing in `src/`
writes it. On disk, every `issue-76/agents/<agent>/` directory is empty. There
is no per-agent log, so "add timestamps to the logs" is, for this file,
"add the log".

---

## 2. How the current numbers were constructed

### 2.1 Phase durations — exact, from `gate-advanced` alone

Cut the run at each `gate-advanced.at`; the interval preceding a boundary
belongs to the phase named in `details.from`. The first phase starts at the
`started` event.

After Phase 1, reproduce the journal-only table with the supported reader:

```bash
coord analytics --issue 76 --coord-root /path/to/coord-runtime
```

Issue-76 result — **64.47 min wall clock** from `started` to the terminal
`gate-advanced` boundary. The live consensus workflow has **10 agent-facing
phases** (format 3); the three removed coordinator-derived phases below appear
only in this pre-change historical measurement:

| phase | minutes | share |
| --- | ---: | ---: |
| R1.join | 6.55 | 10.2% |
| R2.plan | 5.39 | 8.4% |
| R3.review | 4.38 | 6.8% |
| R3.plan-ballot | 1.05 | 1.6% |
| **R4.implement** | **19.27** | **29.9%** |
| **R5.compare** | **9.19** | **14.3%** |
| R5.compare-ballot | 2.01 | 3.1% |
| R6.revise | 5.49 | 8.5% |
| R6.ballot | 3.04 | 4.7% |
| obsolete deterministic publications (pre-format-3 aggregate) | 2.31 | 3.5% |
| R7.finalize | 5.78 | 9.0% |

Implement + compare are 44% of the run. Every phase is gated on the **slowest**
agent, so phase length is a max, not a sum — which is why §2.3 matters.

### 2.2 Token usage per phase — reconstructed by wall-clock join, claude only

There is no key linking a journal event to a vendor transcript. The join is
therefore: take every assistant message in the claude transcript store whose
`timestamp` falls inside the run window, and bucket it into the phase whose
`gate-advanced` interval contains it.

Historical issue 76 predates journaled session and turn identity, so the
supported command intentionally reports only its phase/time tables. A
post-Phase-1 run uses the same command and adds exact transcript-joined token
and tool sections when identity and stores are available.

Issue-76 result — **claude agent only**, 411 assistant messages, two sessions
(`8f7f6208…`, `d802b0de…`):

| phase | msgs | cache read | cache write | output |
| --- | ---: | ---: | ---: | ---: |
| R1.join | 15 | 422,142 | 67,411 | 3,527 |
| R2.plan | 76 | 6,103,727 | 409,706 | 58,557 |
| R3.review | 40 | 5,252,286 | 70,707 | 58,686 |
| R3.plan-ballot | 14 | 1,877,190 | 19,020 | 6,675 |
| **R4.implement** | 138 | **26,457,563** | 136,205 | 90,707 |
| **R5.compare** | 58 | **14,453,144** | 73,863 | 38,194 |
| R5.compare-ballot | 21 | 5,774,183 | 25,707 | 14,379 |
| R6.revise | 2 | 569,840 | 1,334 | 778 |
| R6.ballot | 24 | 6,969,033 | 22,785 | 13,317 |
| obsolete deterministic publications (pre-format-3 aggregate) | 23 | 4,724,846 | 21,522 | 12,398 |
| **total** | **411** | **72,603,954** | **848,260** | **297,218** |

Codex, for the same window, reports cumulatively via its final `token_count`
event: **37,147,795 total tokens**, of which **36,210,176 were cached input**
and 92,337 output (35,628 of that reasoning). Cursor and antigravity contribute
nothing measurable.

Three things fall straight out of this table:

- **Cache read is ~99% of all input.** 72.6M cache-read against 0.85M
  cache-write and 822 uncached input tokens for claude; 36.2M of 37.1M for
  codex. Prompt caching is working. The lever for issue 89 is therefore **not**
  "cache better" — it is **fewer turns** and **a smaller cached prefix**, because
  every turn re-reads the entire prefix.
- **Cost tracks turn count almost linearly.** 411 messages → 72.6M cache reads
  is ~177k tokens re-read per assistant turn, which is roughly the context size.
  Cutting tool-call round trips is the highest-leverage change.
- **R4.implement and R5.compare are 56% of claude's token spend** and 44% of wall
  clock. They are the same two phases. Optimize those first.

**This join is a wall-clock approximation.** It attributes any message in the
window to whichever phase was open, with no proof the session was working on
this issue. It also cannot separate two agents that share a vendor store. It is
good enough for ranking phases and wrong for billing.

### 2.3 Delivery and agent latency — exact, from `nudged` → `intent-seen`

Pair each `intent-seen` with the first outstanding `nudged` for the same
`(agent, actionId)`. Later nudges do not reset an unresolved wait, so a retry
cannot hide the stall that preceded it. Once the response is paired, a later
nudge for the same action may open a new interval. Ballot response latency uses
the same first-outstanding rule through `response-accepted`:

| agent | actions | median | max | total waited |
| --- | ---: | ---: | ---: | ---: |
| cursor | 8 | 64.9 s | 589.6 s | 17.2 min |
| antigravity | 9 | 31.6 s | 705.4 s | 16.4 min |
| claude | 10 | 181.1 s | 991.6 s | 43.5 min |
| codex | 12 | 130.8 s | 1152.8 s | 47.4 min |

Claude is the pacing agent at the median; Codex has the worst tail (19 min on
one action). Since gates wait for everyone, the 64.5-min run is bounded below by
the per-phase max of these, not the mean.

### 2.4 Coordinator-side verification — exact, and already cheap

`intent-seen` → `verify-result` over 37 pairs: **median 1.05 s**, max 48.1 s, 37
of 37 `ok`. Coordinator verification is not a bottleneck; the entire budget is
agent turnaround. Any issue-89 proposal that moves work *into* the coordinator
is trading against a component that currently costs ~1 s per action.

### 2.5 Final checks — measured command durations

The historical issue-76 `final-check` records predate duration capture and
therefore render `unavailable`. New rows record the nonnegative `durationMs`
measured around the hermetic check command itself; worktree setup/cleanup is
excluded. A missing or invalid duration remains `null`, never zero-filled.

---

## 3. Historical gaps found in the issue-76 baseline

These are the gaps observed before Phase 1. Phase 1 addresses only session/turn
identity, transcript reading, and the reporting command because those are the
minimum needed for the four issue-89 metrics. The other items are deferred.

### 3.1 No session identity in the journal — blocks all token attribution

`src/agentEvent.ts:291` builds `details` as
`{vendor, event, kind, execution, health}`. The normalized observation carries
`sessionId` and `turnId` (`src/agentLifecycle.ts:60`) and the lifecycle *state*
file stores them, but neither reaches the journal. Consequence: joining a
coordinator phase to a vendor transcript is only possible by wall clock (§2.2),
which is unattributable per-agent when a vendor store is shared, and silently
wrong when an agent is doing anything besides the current action.

**Fix:** add `sessionId` and `turnId` to the `agent-lifecycle` journal details.
Both already exist at the call site; this is a projection change, not new
plumbing.

### 3.2 No `preparedAt` on `action.md` — agents cannot self-measure

`renderAction` (`src/action.ts:24`) emits front matter of exactly
`actionId`, `agent`, `requiredPath`, and `parseAction` **rejects** any other key
(`src/action.ts:73`). An agent therefore cannot tell how stale its action is,
and cannot report its own start time. The journal knows (`action-prepared`), but
the agent does not.

**Fix:** allow one additional front-matter field, `preparedAt`, in both the
renderer and the allowlist.

### 3.3 Final-check duration was not recoverable

Historically, all three recorded only a completion instant. Durations are
recoverable for verification (pair with `intent-seen`) and for phases (pair
consecutive gates), but not for an individual final check.

**Issue-118 resolution:** `final-check.details.durationMs` is measured around
the existing `processRunner` call. The issue intentionally does not start a
broader duration-field campaign; recoverable verification and phase durations
remain projections.

### 3.4 The delivery chain is never journaled

§1.3: `orderedAt / injectedAt / retryableInjectionAt / acceptedAt /
workflowCompleteAt` exist per-action in `agent-lifecycle.json` and are discarded
on the next action. The §2.3 table therefore measures nudge→intent as one opaque
number, and cannot say how much of a 19-minute wait was delivery failure versus
agent work.

**Fix:** when an action reaches `workflowCompleteAt`, append one
`action-timing` journal event carrying the whole chain plus the nudge count.

### 3.5 No token telemetry anywhere in the coordinator

`grep -i "token\|usage\|cost" src/` returns only unrelated hits (path tokens,
plan tokens, a `Usage:` help string). Claude hook payloads include
`transcript_path`; the coordinator reads `session_id` from them
(`src/agentEvent.ts:114`) and ignores `transcript_path` entirely.

**Phase-1 resolution:** persist `sessionId` and `turnId`, then resolve the
session beneath the configured vendor root. Do not trust or journal a
hook-supplied transcript path and do not add a new token journal event.

### 3.6 The journal is 80% noise from one agent

Of 1119 `agent-lifecycle` events, **1062 (95%) are antigravity**, and they
collapse to **8 distinct payloads** once `at` and `sequence` are removed:
`status-line/working` alone repeats 396 times, with `PreInvocation` and
`PostInvocation` at 293 each. Antigravity accounts for **264,278 of 329,159
journal bytes (80%)**; claude, cursor and codex together produced 57 events.

This is a real cost: `readJournal` (`src/state.ts:515`) parses and Zod-validates
every line, and the file is 305 KB after a single 64-minute issue.

**Fix:** the observer already computes `result.changed`; the antigravity path is
reporting a change on every status-line tick. Either debounce identical
consecutive payloads, or exclude pure `status` observations from the journal
while still letting them update lifecycle state and the watchdog.

### 3.7 `render.log` has no writer

§1.5. Either write it (with per-line timestamps from the start) or delete the
path from `AgentRuntimePaths`. A declared-but-empty log is worse than neither,
because it reads as "logging exists" during exactly this kind of investigation.

### 3.8 No reporting command

Every table in this document was produced by an ad-hoc script against private
runtime paths. There is `coord doctor` (`src/cli.ts:904`) and
`renderIssueReport`, but nothing that answers "where did this issue spend its
time and tokens".

**Fix:** `coord analytics --issue <n>` that prints §2.1, §2.3, §2.4 from the
journal alone, and §2.2 when transcript paths are available. Journal-only mode
must work with zero vendor cooperation.

---

## 4. Efficiency levers this baseline already exposes

These are findings, not proposals — issue 89 can act on them, and the
instrumentation above is what will prove whether the action worked.

**The prompt prefix carries two copies of the protocol.** `AGENTS.md` in this
clone is 8,967 bytes and states the protocol twice. The split is exact:

| region | lines | bytes | origin |
| --- | --- | ---: | --- |
| tracked file | 1–137 | 5,348 | committed in this repo, at `HEAD` |
| managed overlay | 138–241 | 3,618 | written by `coord install` |

The overlay is byte-identical to
`$installRoot/templates/product/AGENTS.protocol.md`, so it is the canonical
copy. The tracked half is a drifted earlier revision of the same text:
`## Plans and reviews` through `## Checks that actually run`, the six plan
headings, the plan-review headings, the code-review headings and the comparison
headings all appear in both halves.

The mechanism is not an accident of editing. `writeCloneAgentsProtocol`
(`src/agentsProtocol.ts:59`) overlays its marker-delimited block onto whatever
`AGENTS.md` already contains, and `applyDelimitedBlock` correctly manages only
the text between its own markers. It has no way to know that the tracked file
outside those markers already restates the same protocol. This repository is
unusual in hitting it — coordination is both the product and the driver, so its
own tracked `AGENTS.md` is a copy of the template it ships.

The two halves disagree. The tracked copy opens "This file is the protocol.
Follow it when writing coordinator artifacts"; the overlay opens with the
mode-aware version that restricts the protocol to actions with a published
`action.md` and forbids fabricating artifacts in manual mode. The tracked copy
also carries a repository-specific `verify.precommit` paragraph the overlay
drops. The stale half is read first.

`CLAUDE.md` pulls the whole file in with `@AGENTS.md`, so every session loads
both halves, and at 72.6M cache reads across 411 turns the redundant 3.6 KB is
re-read on every turn. The fix is to trim the tracked `AGENTS.md` down to the
human-facing intro and let the overlay supply the protocol — a change to the
committed file, not to the overlay, and not something to do by editing the
`skip-worktree` copy in a clone.

**Cache read dominates, so turn count is the cost.** §2.2: 99% of input is
cache-read. Reducing tool calls reduces turns; reducing turns reduces the number
of times the ~177k-token prefix is re-read. A "context file for initial
searches" (issue 89's own suggestion) is worth exactly the number of
search turns it removes — which §2.2's per-phase message counts can now measure
directly, before and after.

**Two phases own the budget.** R4.implement and R5.compare: 44% of wall clock,
56% of claude's tokens, 196 of 411 turns. Consolidating messaging in the other
eleven phases optimizes the 44%.

**Coordinator work is nearly free.** §2.4: median verification is 1.05 s against
agent medians of 38–249 s. Moving work into the coordinator is a good trade on
these numbers, and the analytics above are what will keep it a good trade.

---

## 5. Phase-1 four-metric contract

Run:

```bash
coord analytics --issue <n> --product <path>
# or
coord analytics --issue <n> --coord-root <path>
```

The reader never changes workflow state, fetches Git, or writes vendor files.
It reports four metrics:

- **Phase count** — named workflow intervals, including the active `R1.join`
  interval before the first `gate-advanced`. Revision rounds and retries remain
  distinct intervals. Actions prepared in each interval are shown separately.
- **Time** — the run begins at `started.at`; completed phase intervals end at
  their `gate-advanced.at`. An unfinished final interval is labelled
  `in-progress`. An end before its start reports `invalid`, never a negative
  duration. The headline retains elapsed `durationMs` and adds `pausedMs` from
  merged `paused` → `resumed` intervals plus `unpausedMs = elapsed - paused`.
  Per-agent waits and ballot response latency retain the first outstanding
  nudge for `(agent, actionId)` until the matching endpoint; the displayed
  median uses the upper middle value.
- **Token count** — `input`, `output`, `cacheRead`, `cacheWrite`, and
  `reasoning` when the vendor reports it. Claude uses de-duplicated per-message
  `usage`. Codex uses `last_token_usage` deltas and never sums cumulative
  `total_token_usage`.
- **Tool count** — invocation attempts, not results. Claude counts distinct
  `tool_use` content blocks. Codex counts tool-shaped `item_completed` records;
  it does not count completion/result records a second time. Tool counts remain
  per vendor and are never combined across the roster.

### Exact attribution

`agent-lifecycle` journal rows carry `agent`, top-level `actionId`, and Phase 1
adds `sessionId` and `turnId` to `details`. `prompt-submitted` and `stopped`
boundaries are journaled even when they do not change lifecycle state, so every
attempted action can be checked for identity. An action belongs to the interval
containing its `action-prepared` record.

- Claude transcripts are located at
  `~/.claude/projects/<project-slug>/<sessionId>.jsonl`. Usage and tool records
  inherit their turn by walking `parentUuid` to the nearest `user` record and
  reading its `promptId`.
- Codex transcripts are located beneath
  `~/.codex/sessions/YYYY/MM/DD/*-<sessionId>.jsonl`. Current `token_count`
  records do **not** carry `turn_id` or consistently carry `ordinal`; token
  deltas are assigned when their timestamp lies inside a complete,
  same-session coordinator `prompt-submitted` → `stopped` window. If overlapping
  windows all share one vendor `sessionId`/`turnId`, the most recently started
  action receives the record as an explicitly `partial` shared-turn fallback;
  overlaps across different turn ids remain unassigned. Transcript records that
  already carry a turn id use the same rule when that turn maps to multiple
  coordinator actions: they are never silently assigned to the first action as
  exact coverage.
  Tool counts use `item_completed.turn_id`; `Extension` is a tool item, while
  `EnteredReviewMode` and `ExitedReviewMode` are controls. `custom_tool_call`
  alone is not treated as exact because it has no supported top-level turn key.

The coordinator resolves these paths beneath configured vendor roots; it never
opens a path supplied by a hook. The parser snapshots the file's initial byte
length and reads no appended bytes.

The complete coordinator window is the supported Codex token route. Other
records without an exact turn key may use the same window only as a labelled
`partial` fallback. Records matching neither an exact turn nor exactly one
complete window are reported as `unassigned`; they are never silently folded
into a phase. Missing identity on any attempted action and any measured
unassigned record lower coverage.

### Coverage

Token and tool coverage are tracked independently so an unknown tool item
cannot erase valid token measurements. Every transcript-backed metric carries
one of:

- `complete` — the supported file was read to a stable final newline;
- `partial` — a fallback was used, a record was unassigned, the file
  grew/ended truncated, or some metric records were malformed;
- `unsupported` — the file contains no supported records for that metric;
- `unavailable` — the session/store is missing or unreadable, or Cursor hooks
  supplied no token counters for that session.

Absent data is `null`/`unavailable`, never zero. Valid rows remain visible under
`partial` coverage when a sibling record is malformed. A readable supported
transcript with usage records but no tool records has a real tool count of zero.
A cross-roster token total appears only when every active agent has complete
token coverage and no measured token record is unassigned. There is never a
cross-roster tool total because vendor invocation semantics differ.

Historical journals without `sessionId` remain useful: the command reports
phase count, time, and agent wait, and omits token/tool sections rather than
failing. `coord analytics` also has a read-only path for completed runtime
formats 2 and 3; it normalizes supported journal rows only in memory, prints
legacy provenance and a count of skipped unknown event kinds, and never writes
or migrates state. The normal start/cursors/journal readers remain strict, so
run/resume of the same legacy files still fails closed.

## 6. Deferred from Phase 1

The following may be evaluated later only when the metrics justify them:
`preparedAt`, duration fields beyond `final-check`, delivery-chain events,
antigravity status debouncing, a `render.log` writer/removal, JSON or aggregate
dashboards, context indexes, protocol trimming, and any workflow-step or
message consolidation. None is required to measure phase count, time, tokens,
or tools accurately, so none belongs in this instrumentation change.

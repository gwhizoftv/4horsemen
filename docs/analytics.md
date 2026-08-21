# Coordination analytics — what we can measure today, and what we cannot

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
`/Volumes/4TB-SOURCE/REPOS/coord/coord-runtime/issue-76/`. It is one run, so
treat the absolute values as a baseline to beat, not as a stable average.

---

## 1. Sources of truth that exist today

### 1.1 `journal.jsonl` — the only durable, append-only history

Schema: `src/state.ts:367` (`journalEventSchema`); writer: `src/state.ts:561`
(`appendJournal`); path: `src/paths.ts:146`.

Every record already carries `at` (RFC 3339 with offset), a monotonic
`sequence`, and optional `agent` / `actionId` / `submissionSha`. **Timestamps
are not missing from the journal.** What is missing is *duration* and *identity*
on individual records — see §3.

Issue-76 record counts:

| type | count | what it pins down |
| --- | ---: | --- |
| `agent-lifecycle` | 1119 | vendor hook traffic (95% is one agent — see §3.6) |
| `nudged` | 46 | coordinator → agent delivery attempt |
| `intent-seen` | 39 | agent wrote `complete` with a SHA |
| `verify-result` | 39 | coordinator accepted/rejected the submission |
| `action-prepared` | 37 | an `action.md` was written |
| `gate-advanced` | 13 | **phase boundaries** |
| `agent-observability-degraded` | 10 | watchdog fired (45s, `AGENT_OBSERVABILITY_WATCHDOG_MS`) |
| `final-check` | 2 | hermetic `checks` tier at the approved commit |
| `started` / `publication-pending` / `pr-created` | 1 each | run boundaries |

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
| cursor | `~/.cursor/chats/<hash>/<id>/store.db` (SQLite `blobs`) | **No** — scanned every blob for `usage` / `inputTokens` / `cacheRead` / `totalTokens`: zero matches |
| antigravity | — | **No local store found** |

So token analytics is currently possible for two of four agents, by reading
files the coordinator neither writes nor references.

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

```bash
python3 - <<'EOF'
import json, datetime
J = '/Volumes/4TB-SOURCE/REPOS/coord/coord-runtime/issue-76/journal.jsonl'
ev = [json.loads(l) for l in open(J)]
T  = lambda e: datetime.datetime.fromisoformat(e['at'].replace('Z', '+00:00'))
prev = T(ev[0])
for g in (e for e in ev if e['type'] == 'gate-advanced'):
    print(f"{g['details']['from']:24s} {(T(g)-prev).total_seconds()/60:6.2f} min")
    prev = T(g)
EOF
```

Issue-76 result — **64.50 min wall clock**:

| phase | minutes | share |
| --- | ---: | ---: |
| R1.join | 6.55 | 10.2% |
| R2.plan | 5.39 | 8.4% |
| R3.review | 4.38 | 6.8% |
| R3.plan-ballot | 1.05 | 1.6% |
| R3.publish-selection | 1.11 | 1.7% |
| **R4.implement** | **19.27** | **29.9%** |
| **R5.compare** | **9.19** | **14.3%** |
| R5.compare-ballot | 2.01 | 3.1% |
| R5.reviser-auth | 0.61 | 0.9% |
| R6.revise | 5.49 | 8.5% |
| R6.ballot | 3.04 | 4.7% |
| R6.declare | 0.59 | 0.9% |
| R7.finalize | 5.78 | 9.0% |

Implement + compare are 44% of the run. Every phase is gated on the **slowest**
agent, so phase length is a max, not a sum — which is why §2.3 matters.

### 2.2 Token usage per phase — reconstructed by wall-clock join, claude only

There is no key linking a journal event to a vendor transcript. The join is
therefore: take every assistant message in the claude transcript store whose
`timestamp` falls inside the run window, and bucket it into the phase whose
`gate-advanced` interval contains it.

```bash
python3 - <<'EOF'
import json, glob, os, datetime, collections
D = os.path.expanduser('~/.claude/projects/-Volumes-4TB-SOURCE-REPOS-coord-coordination-claude')
J = '/Volumes/4TB-SOURCE/REPOS/coord/coord-runtime/issue-76/journal.jsonl'
T = lambda s: datetime.datetime.fromisoformat(s.replace('Z', '+00:00'))
ev = [json.loads(l) for l in open(J)]
bounds = [(T(ev[0]['at']), None)] + [(T(g['at']), g['details']['to'])
                                     for g in ev if g['type'] == 'gate-advanced']
def phase(t):
    name = [e for e in ev if e['type'] == 'gate-advanced'][0]['details']['from']
    for ts, n in bounds[1:]:
        if t >= ts: name = n
    return name
per = collections.defaultdict(collections.Counter)
lo, hi = bounds[0][0], T(ev[-1]['at'])
for f in glob.glob(D + '/*.jsonl'):
    for line in open(f):
        try: d = json.loads(line)
        except ValueError: continue
        ts, us = d.get('timestamp'), (d.get('message') or {}).get('usage')
        if not ts or not us: continue
        t = T(ts)
        if lo <= t <= hi:
            per[phase(t)].update({k: v for k, v in us.items() if isinstance(v, int)})
            per[phase(t)]['msgs'] += 1
for p, c in per.items(): print(p, dict(c))
EOF
```

Issue-76 result — **claude agent only**, 411 assistant messages, two sessions
(`8f7f6208…`, `d802b0de…`):

| phase | msgs | cache read | cache write | output |
| --- | ---: | ---: | ---: | ---: |
| R1.join | 15 | 422,142 | 67,411 | 3,527 |
| R2.plan | 76 | 6,103,727 | 409,706 | 58,557 |
| R3.review | 40 | 5,252,286 | 70,707 | 58,686 |
| R3.plan-ballot | 14 | 1,877,190 | 19,020 | 6,675 |
| R3.publish-selection | 13 | 1,868,847 | 15,513 | 7,729 |
| **R4.implement** | 138 | **26,457,563** | 136,205 | 90,707 |
| **R5.compare** | 58 | **14,453,144** | 73,863 | 38,194 |
| R5.compare-ballot | 21 | 5,774,183 | 25,707 | 14,379 |
| R5.reviser-auth | 8 | 2,263,279 | 5,249 | 3,853 |
| R6.revise | 2 | 569,840 | 1,334 | 778 |
| R6.ballot | 24 | 6,969,033 | 22,785 | 13,317 |
| R6.declare | 2 | 592,720 | 760 | 816 |
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

Pair each `(agent, actionId)` with its first `nudged` and its `intent-seen`:

| agent | actions | median | max | total waited |
| --- | ---: | ---: | ---: | ---: |
| cursor | 8 | 64.9 s | 589.6 s | 17.2 min |
| antigravity | 9 | 37.9 s | 725.6 s | 28.2 min |
| claude | 10 | 181.1 s | 991.6 s | 43.5 min |
| codex | 12 | 248.8 s | 1152.8 s | 55.5 min |

Codex is the pacing agent at the median and the worst tail (19 min on one
action). Since gates wait for everyone, the 64.5-min run is bounded below by the
per-phase max of these, not the mean.

### 2.4 Coordinator-side verification — exact, and already cheap

`intent-seen` → `verify-result` over 37 pairs: **median 1.05 s**, max 48.1 s, 37
of 37 `ok`. Coordinator verification is not a bottleneck; the entire budget is
agent turnaround. Any issue-89 proposal that moves work *into* the coordinator
is trading against a component that currently costs ~1 s per action.

### 2.5 Final checks — only endpoints, no durations

Two `final-check` records, `pnpm run check`: exit 1 at `19:14:23`, exit 0 at
`19:17:18`. The gap between them (2.9 min) includes a rejection, a re-push, and a
re-run — the record itself has no duration field, so a single check's cost cannot
be isolated. See §3.3.

---

## 3. What is missing

Ordered by how much each blocks issue 89.

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

### 3.3 No durations on `verify-result`, `final-check`, or `gate-advanced`

All three record only a completion instant. Durations are recoverable for
verification (pair with `intent-seen`) and for phases (pair consecutive gates),
but **not** for individual final checks, which are the most expensive
coordinator-side operation in the run.

**Fix:** add `durationMs` to `final-check.details` (measured around
`this.processRunner` at `src/runLoop.ts:911`), and to `verify-result.details`.
`durationMs` on `gate-advanced` is redundant but makes the journal readable
without a join.

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

**Fix, cheapest first:**
1. Capture `transcript_path` alongside `sessionId` in the lifecycle observation.
   That alone converts §2.2 from a wall-clock guess into an exact join for claude.
2. Add an optional `token-usage` journal event, appended at `Stop`, carrying the
   delta since the previous stop. Vendors that cannot report usage simply never
   emit it — the schema should treat absence as normal, not degraded.

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

## 5. Minimal instrumentation set

If only four changes ship, these four make every table in §2 exact instead of
inferred, and none of them changes workflow authority:

1. `sessionId`, `turnId`, and `transcriptPath` in `agent-lifecycle` journal
   details (§3.1, §3.5).
2. `durationMs` on `final-check` and `verify-result` (§3.3).
3. One `action-timing` event carrying the delivery chain at action completion
   (§3.4).
4. Debounce identical antigravity lifecycle payloads out of the journal (§3.6).

`journalEventSchema` (`src/state.ts:367`) already has a permissive
`details: z.record(z.string(), z.unknown())`, so items 1–2 need no schema
version bump. Item 3 adds one enum member to `type`, which does.

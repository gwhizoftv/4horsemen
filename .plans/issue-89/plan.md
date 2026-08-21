# Issue 89 plan — Phase 1: the four metrics the issue names, and nothing else

- Issue: https://github.com/gwhizoftv/coordination/issues/89 (body updated 2026-08-21T05:26Z)
- Author: Claude
- Branch: `issue-89/claude`
- Baseline: `origin/main` at `1bfc7f9`
- Revision: incorporates the three peer reviews at `origin/issue-89/{cursor,codex,antigravity}`

## Scope comes from the issue

> 1. Enhance any metrics/analytics we need to have accurate **time, token count,
>    tool count, and phase count** for our protocol
> 2. Enhancements/improvements based on the metrics.
>
> …highly efficient and simple in our approach to design and implementation,
> without over building or over engineering.

Phase 1 admits an item only if it is required to produce one of those four
counts accurately. "Without over building" is treated as a requirement.

### Where the four metrics stand

| Metric | Source today | Gap |
| --- | --- | --- |
| **Phase count** | `gate-advanced` events (`src/runLoop.ts:876`) | **None** — needs a reader |
| **Time** | Every journal row carries `at` | **None** — needs a reader |
| **Token count** | Vendor transcripts only | Journal identity to join on |
| **Tool count** | Same transcripts, same records | Same join |

Two of four were never missing: `docs/analytics.md` §2.1 and §2.3 published those
tables by hand from issue-76's journal. The whole gap is the transcript join, and
closing it yields tokens **and** tool counts from one parse.

### Resolve transcripts by session, not by a journaled path

Earlier drafts journaled a `transcriptPath` taken from the hook payload. Codex's
review showed that is both incomplete and unnecessary:

- **Incomplete.** Codex's normalization (`src/agentEvent.ts:92-109`) carries
  `session_id` and `turn_id` but **no transcript path**, so a real codex run
  would always report usage unavailable while a fixture passed.
- **Unnecessary.** Both vendors already normalize `sessionId`
  (`src/agentEvent.ts:95` for codex, `:114` for claude), and both store
  transcripts at documented, session-addressed locations
  (`docs/analytics.md` §1.4): claude at
  `~/.claude/projects/<slug>/<sessionId>.jsonl`, codex under
  `~/.codex/sessions/YYYY/MM/DD/`.

So Phase 1 journals **`sessionId` only** and resolves the file by vendor locator
under a configured root. This is one less journaled field, gives codex real
coverage instead of fixture-only coverage, and means the coordinator never opens
a path supplied by a hook payload.

### The join algorithm, stated once

Two implementers must not pick different joins. The algorithm is:

1. `agent-lifecycle` journal rows already carry `agent` and, when present,
   top-level `actionId` (`src/agentEvent.ts:295`). Phase 1 adds `sessionId`.
2. An action's **turn window** runs from the `prompt-submitted` lifecycle row
   bearing that `actionId` to the next `stopped` row for the same agent and
   session.
3. An action's **phase** is the `gate-advanced` interval containing its
   `action-prepared` event.
4. A transcript record is attributed to an action when its timestamp falls inside
   that action's turn window in that session — and therefore to that action's
   phase.
5. Records in the session that fall in **no** action window are reported as
   `unassigned`. They are never folded into a phase and never silently dropped.

No `turnId` is journaled: `actionId` is already on the lifecycle row and is the
identity the report needs.

## Exact File List to be changed or deleted

### Changed

- `src/agentEvent.ts` — add `sessionId` to the `agent-lifecycle` journal
  `details` projection (`src/agentEvent.ts:291`), which today is
  `{vendor, event, kind, execution, health}`. The value is already on the
  normalized observation for both vendors; the top-level `actionId` is already
  journaled. This is the only write-path change in Phase 1.
- `src/cli.ts` — register `coord analytics --issue <n> [--product <path> |
  --coord-root <path>]`, with strict flag validation and the normal issue-runtime
  resolution used by existing commands; extend help text.
- `docs/analytics.md` — **Changed, not created.** The file is already tracked at
  `613e3e8`. Edit in place: add the four-metric contract (definitions below), the
  per-vendor transcript locator and tool-record filter, the coverage rules, and
  the deferred list. Keep the issue-76 measured tables — they are the acceptance
  oracle. Replace the ad-hoc Python with the CLI.
- `package.json` — bump `version` to strictly greater than `origin/main` at ship
  time; the non-`main` gate (`test/versionBump.test.ts:29`) enforces this on
  every push, so do not hard-code a number here.
- `config.product.example.json` — update the pinned `"version"` (line 33) in
  lockstep.
- `test/agentEvent.test.ts`, `test/cli.test.ts`, `test/install.test.ts` — see
  Tests. **`test/install.test.ts:163` and `test/cli.test.ts:100` hard-code the
  version literal and fail the moment `package.json` moves**; both must be
  updated in the same commit or `check:fast` blocks it.

**Not changed:** `src/runLoop.ts`, `src/action.ts`, `src/state.ts`,
`src/agentLifecycle.ts`, `src/paths.ts`, `AGENTS.md`. No journal enum member, no
schema version bump, no action-format change.

### Deleted

None.

## Exact file list to be created

- `src/analytics.ts` — the reader. Journal-only sections, always available:
  **phase count** and actions per phase; **time** as phase wall-clock, run total,
  and per-agent `nudged` → `intent-seen` waits. Transcript-joined sections when
  `sessionId` is present: **token count** and **tool count** per phase per agent,
  per the join above. Every figure carries a coverage state; a metric never
  recorded reports `null`, never `0`.
- `src/transcriptRead.ts` — vendor locator and bounded parser. Takes a vendor,
  `sessionId`, and a configured root (injected in tests); resolves the session
  file under that root; reads at most the file's initial byte length; returns
  `{values, coverage, reason}` — never a bare `undefined`.
- `test/analytics.test.ts`, `test/transcriptRead.test.ts` — see Tests.
- `test/support/fixtures/analytics-journal.jsonl` — issue-76-shaped journal
  **including** `sessionId` and `actionId` on lifecycle rows.
- `test/support/fixtures/transcript-claude.jsonl`,
  `test/support/fixtures/transcript-codex.jsonl` — sanitized tails in each
  vendor's real shape, carrying usage records and tool records.

## Metric definitions (frozen)

These go verbatim into `docs/analytics.md`; the report must not deviate.

- **Phase count** — named workflow gate intervals from `gate-advanced`, counting
  revision rounds and retries as distinct intervals. Actions per phase are
  reported separately, from `action-prepared`.
- **Time** — the run window is `started.at` through the terminal `gate-advanced`
  boundary; an in-progress run is labelled as such. Every interval is validated
  monotonic: if end precedes start (clock adjustment, malformed timestamp) the
  interval reports `invalid`, never a negative number.
- **Token count** — components `input`, `output`, `cacheRead`, `cacheWrite`, plus
  `reasoning` where the vendor reports it. Taken from **per-turn values only**:
  claude's per-message `usage`, and codex's `last_token_usage` delta — **never**
  codex's cumulative `total_token_usage`, which would multiply the total.
  Records are de-duplicated by vendor record id.
- **Tool count** — **invocation attempts only, never results.** Claude: content
  blocks where `type === "tool_use"`, counted per block and not per assistant
  message. Codex: tool-call events, excluding their result events. Reported
  **per vendor**; never summed into a cross-roster total, because the vendors
  count different things and the total would track roster mix rather than
  efficiency.
- **Coverage** — per agent, one of `complete`, `partial` (a growing or
  final-truncated file), `unsupported` (a schema the parser does not know), or
  `unavailable` (no store, or unreadable). Two of four agents have no local usage
  store at all (`docs/analytics.md` §1.4). No cross-roster token or tool total is
  printed unless coverage is `complete` for every active agent; otherwise the
  report shows per-agent rows with their coverage.

## Tests

`pnpm check:fast` before every commit; `pnpm check` is the acceptance gate.

- `test/analytics.test.ts` — **new.** Phase count and actions per phase match
  hand-counted fixture values; phase durations match hand-computed minutes with
  the first phase measured from `started`; run total equals the sum of phases; an
  interval whose end precedes its start reports `invalid`, not a negative number;
  per-agent waits reproduce known count/median/max; token and tool counts bucket
  to the correct phase and agent through the documented join; a transcript record
  outside every action window is reported `unassigned`, not folded into a phase;
  **a journal with no `sessionId` still reports phase count and time and omits
  the token and tool sections rather than erroring**; a never-recorded metric
  reports `null` with coverage `unavailable`, never `0`; no cross-roster total is
  printed when any active agent's coverage is short of `complete`.
- `test/transcriptRead.test.ts` — **new.** Claude and codex fixtures each yield
  expected per-turn token deltas and tool-call counts; **codex's cumulative
  `total_token_usage` is not summed** (a fixture with two turns proves the total
  is the delta sum, not the cumulative sum); tool **results** are not counted as
  calls; duplicate records de-duplicate by id; a vendor with usage but no tool
  records reports tools `0` while a vendor with no store reports `unavailable` —
  the two must not collapse; an unreadable file (`ENOENT`, `EACCES`) is caught
  locally and returns `unavailable` rather than throwing, so running the report
  on a machine that lacks the vendor store cannot crash the CLI; a growing or
  final-truncated file returns `partial`, and an interior malformed record
  returns `partial` or `unsupported` — never `complete`.
- `test/agentEvent.test.ts` — `sessionId` appears in `agent-lifecycle` details
  when the observation supplies it and is absent (not `null`) when it does not,
  for both vendors; the existing top-level `actionId` is unaffected.
- `test/cli.test.ts` — `coord analytics --issue <n>` exits 0 against a fixture
  runtime root and prints all four metric sections; both `--product` and
  `--coord-root` resolution paths work; unknown flags are rejected; the command
  appears in help; a missing journal exits non-zero with a clear message. Plus
  the version literal at line 100.
- `test/install.test.ts` — the installed-version assertion at line 163.

### Acceptance, in three parts

The peer reviews were right that one replay cannot validate everything, because
the historical issue-76 journal has no `sessionId` in it.

- **(a) Historical replay.** `coord analytics --issue 76` against the existing
  issue-76 runtime journal reproduces the phase durations and per-agent latency
  tables in `docs/analytics.md` §2.1 and §2.3. This validates phase count and
  time against a hand-computed oracle the reader did not author.
- **(b) Fixture pipeline.** The fixture journal — which *does* carry `sessionId`
  and `actionId` — plus the two vendor transcript fixtures validates the token
  and tool tables and the join.
- **(c) One live run.** No Phase 2 token or tool claim may rest on Phase 1 until
  one real post-ship run has produced a report with `complete` coverage for at
  least claude and codex. Issue 76 cannot validate the new join, and a fixture
  cannot prove the locator finds a real vendor file.

## Alternatives Rejected

- **Journal `transcriptPath` from the hook payload** (my earlier drafts): codex
  payloads carry no such field, so codex coverage would be fixture-only, and it
  would have the coordinator open a payload-supplied path. Session-addressed
  vendor locators fix both.
- **Journal `turnId`** (Codex review, finding 3): its goal — binding a transcript
  record to an exact action — is already met, because `agent-lifecycle` rows
  carry top-level `actionId` (`src/agentEvent.ts:295`). The action turn window
  gives the same binding with no new field.
- **Debounce antigravity status ticks in Phase 1** (my earlier drafts; all three
  reviews object): the noise is real — 95% of lifecycle events, 80% of journal
  bytes — but it does **not** affect any of the four metrics, which come from
  `gate-advanced`, `action-prepared` and `nudged`/`intent-seen`. It also adds
  stateful behaviour to the lifecycle and watchdog path. Deferred to Phase 2, to
  be justified by Phase 1's own numbers.
- **`--json` in Phase 1** (Cursor review, finding 5): deferred. Phase 2 compares
  a small number of runs and a human summary suffices; a report schema is
  scope the issue did not ask for.
- **Substitute action/bound-input bytes for tokens and tool calls** (Codex's
  plan): a defensible position on vendor coverage, but the issue names token
  count and tool count as Phase 1 deliverables, and bytes are a transport proxy.
  Partial coverage reported honestly beats a proxy.
- **`durationMs` on `gate-advanced` / `verify-result` / `final-check`,
  `action-timing`, `preparedAt`, artifact byte counts, verify-failure
  classification** (Antigravity's plan; my earlier drafts): every one of these
  intervals is derivable from timestamps already journaled, and none is needed
  for the four metrics.
- **Content-handling and path-confinement hardening in Phase 1**: deferred at the
  owner's direction. Largely moot now that the coordinator resolves transcripts
  by session id under a configured root instead of opening a payload-supplied
  path, and the reader extracts numeric fields and record counts by construction.
  Recorded in `docs/analytics.md` as a Phase 2 item.
- **Ship any Phase 2 improvement now** — `AGENTS.md` trim, `renderLog` removal,
  clerical-step collapse, combined ballots, context capsules: all follow the
  metrics by the issue's own ordering. The `AGENTS.md` trim in particular is a
  change Phase 1 exists to measure; landing it inside Phase 1 would erase its own
  baseline.

## Risks and Mitigations

- **The vendor locator does not find a real transcript**, so the report is
  fixture-correct and useless in production. This is the main risk of resolving
  by session id. *Mitigation:* acceptance part (c) — one live run must produce
  `complete` coverage for claude and codex before any Phase 2 token claim.
- **Cumulative usage is summed as if it were per-turn**, inflating codex totals
  by a large factor. *Mitigation:* the definition names `last_token_usage`
  explicitly, and `test/transcriptRead.test.ts` proves a two-turn fixture totals
  the deltas, not the cumulative values.
- **A vendor store is missing or unreadable on the machine running the report.**
  *Mitigation:* caught locally, returns `unavailable`; asserted so the CLI cannot
  crash.
- **Absent data reads as zero**, biasing a Phase 2 comparison favourably.
  *Mitigation:* four coverage states, `null` never `0`, and no cross-roster total
  unless coverage is complete. (Discipline taken from Codex's plan.)
- **Tool counts are compared across vendors** and move with roster mix rather
  than efficiency. *Mitigation:* per-vendor reporting only; the definition
  forbids a cross-roster total; Phase 2 compares a vendor against itself.
- **A session does non-issue work inside a gate window**, so records are
  attributed to a phase they do not belong to. *Mitigation:* the join uses the
  action turn window, not the whole gate; records outside every window report as
  `unassigned` rather than being absorbed.
- **Clock adjustment produces a negative interval.** *Mitigation:* monotonic
  validation; report `invalid`.
- **Fixture journals drift from real journal shape.** *Mitigation:* fixtures are
  validated through `journalEventSchema` in the test, and acceptance (a) runs
  against a real historical journal.
- **Phase 1 delivers no speed-up.** Correct and intended: the issue asks for
  metrics first, improvements second.

## Conclusion

Phase 1 is two new source files, one added field in an existing journal
projection, and a CLI registration.

That shape follows from three facts. Two of the four metrics — phase count and
time — have been in every journal we have written, which is how
`docs/analytics.md` published them by hand for issue-76; they need a reader, not
a writer. The remaining gap is the transcript join, and both vendors already
normalize the `sessionId` that keys it, so nothing new needs to be plumbed.
And `agent-lifecycle` rows already carry `actionId`, so the join binds to an
exact action without journaling a turn identity.

The three peer reviews converged on this plan and improved it in four concrete
ways: resolve transcripts by session locator rather than a payload path (which
also gives codex real rather than fixture-only coverage), state the join
algorithm so two implementers cannot diverge, split acceptance because the
historical journal cannot validate a join it predates, and drop the status-tick
debounce that no metric depends on. Each of those made Phase 1 smaller.

What remains non-negotiable is acceptance (a): the reader must re-derive the
hand-computed §2.1 and §2.3 tables from the journal we already have. Two of the
four metrics were always measurable; a reader that disagrees with the numbers
already published is measuring something else, and every Phase 2 decision would
inherit the error.

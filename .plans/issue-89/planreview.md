# Issue 89 — review of peer plans, and the change list to accept one

- Reviewer: Claude
- Reviewed: `coordination-cursor/.plans/issue-89/{plan,discussion}.md`,
  `/private/tmp/coord-issue-89-codex/.plans/issue-89/{plan,discussion}.md`,
  `coordination-antigravity/.plans/issue-89/plan.md` (no discussion.md exists)
- Authority for scope: issue 89 body as updated 2026-08-21T05:26Z
- Baseline: `origin/main` at `1bfc7f9`

## Selection

**Cursor's plan is the best starting point.** It should be adopted, with the
eleven changes in Findings applied.

The issue names Phase 1 exactly: metrics for accurate **time, token count, tool
count, and phase count**, "without over building or over engineering." Scoring
the three plans against that sentence:

| | Time | Phase count | Token count | Tool count | Phase 1 files | Verdict |
| --- | --- | --- | --- | --- | ---: | --- |
| **Cursor** | derived from `at` | yes | report-time join | same parse | ~5 | **Adopt** |
| Codex | per-gate | yes | **refused** | **refused** | ~12 | Fails scope |
| Antigravity | + `durationMs` ×3 | yes | yes | yes | ~14 | Over-builds |

**Codex is disqualified on scope, not on quality.** Its Alternatives Rejected
says: "*Vendor token and tool-call adapters. Coverage and formats differ by
vendor… action/input bytes provide an explicitly labeled context proxy.*" That
is a conscious, well-argued position and its reasoning about vendor coverage is
correct. But it substitutes `action.md`/bound-input **bytes** for two of the four
metrics the issue names, and bytes are not tokens — Codex itself labels them a
proxy. A Phase 1 that cannot report token count or tool count does not satisfy
Phase 1. Codex's plan is nonetheless the most rigorous of the three on trust
boundary, coverage semantics, and privacy, and three of the findings below import
its discipline into Cursor's plan.

**Antigravity is disqualified on over-building.** It covers all four metrics, but
its Phase 1 also carries `durationMs` on `gate-advanced`, `verify-result` and
`final-check`, the `action-timing` delivery chain, and `preparedAt` on
`action.md` — 14 changed files touching `src/runLoop.ts` and `src/action.ts`.
None of that is needed to produce the four counts: `docs/analytics.md` §3.3 says
the `gate-advanced` duration is redundant with the timestamps already present,
and coordinator verification is already measured at ~1.05 s median and is not a
Phase 2 target. The issue's "without over building" is a constraint, not a
style note.

**Why Cursor wins.** One design call decides it: journal `sessionId` +
`transcriptPath`, then **join transcripts at report time** rather than writing
usage into the journal. That removes a new journal event type, the
`journalEventSchema` enum change, and any write-path duplication of vendor data —
and it yields tool count for free, because tool-use records sit in the same
transcript as usage records. It also works retroactively on any journal carrying
the identity fields. My own plan proposed a `token-usage` journal event; Cursor's
approach is strictly simpler for identical output, and I have adopted it.

All four plans pass the structural validator: `checkPlan` (`src/evidence.ts:60`)
matches headings at `^#{1,6}`, so Cursor's `###`-nested headings are valid. No
finding below is about formatting.

## Findings

### 1. The version bump breaks two tests the plan does not list — blocking

**Claim.** "Changed: `package.json` — bump version strictly above `origin/main`
(`0.0.12`); `config.product.example.json` — version lockstep if it pins the
package version."

**Rule.** The file map must name every file the change requires editing, and
`pnpm check:fast` must pass before any commit (AGENTS.md, "Checks that actually
run").

**Failure.** Bumping `package.json` to `0.0.13` makes two hard-coded assertions
fail: `test/cli.test.ts:100` (`expect(lines.join("").trim()).toBe("0.0.12")`) and
`test/install.test.ts:163`
(`expect(config.coordination?.version).toBe("0.0.12")`). `test/install.test.ts`
appears nowhere in Cursor's plan, and `test/cli.test.ts` is listed only for
"analytics command on a fixture runtime." An implementer following the plan as
written cannot commit: the pre-commit hook runs `check:fast` and blocks. **I hit
this exact failure on this branch** — the bump produced precisely those two
failures, 351/353 passing, before I updated both literals.

**Correction.** Add `test/install.test.ts` to Changed, and extend the
`test/cli.test.ts` entry to include updating the version literal at line 100.

### 2. `test/analytics.test.ts` is listed as Changed but does not exist

**Claim.** Under "#### Changed": "`test/analytics.test.ts` — see created files
(may live only there if CLI test stays thin)."

**Rule.** The two file lists are separate required headings and a path belongs to
exactly one; the coordinator derives approved paths from them.

**Failure.** The file does not exist at baseline, so listing it as Changed makes
the same path authoritative in two lists. "May live only there" also leaves the
test's location undecided, so a reviewer cannot determine whether an
implementation that omits it is incomplete or conformant.

**Correction.** Delete the line from Changed. It is already correctly in Created.

### 3. The debounce is scoped "optional… only if needed" — undecidable

**Claim.** "`src/agentEvent.ts` — … Optional: suppress identical consecutive
antigravity **status** journal rows only if needed so `readJournal` for analytics
stays cheap (lifecycle state still updates)."

**Rule.** A plan must state whether a change is in or out of scope; "only if
needed" gives no decision procedure, so two opposite implementations both conform.

**Failure.** An implementer who omits it and one who includes it are both
following the plan, and a reviewer has no basis to reject either. The measured
cost is real — `docs/analytics.md` §3.6: 1062 of 1119 lifecycle events (95%) from
one agent, 264,278 of 329,159 journal bytes (80%), and `readJournal`
(`src/state.ts:515`) Zod-validates every line. But note honestly that this noise
does **not** corrupt any of the four metrics: phase count and actions-per-phase
come from `gate-advanced` and `action-prepared`, not from `agent-lifecycle`.

**Correction.** Decide it explicitly, either way. Given the issue's simplicity
constraint, the cleanest choice is to **drop the debounce from Phase 1** as
scope reduction and record it as a Phase 2 candidate. If it is kept instead, make
it required and state the invariant: suppress only byte-identical consecutive
status-only observations, never an execution or health transition, with lifecycle
state and the 45 s watchdog still updating on suppressed ticks.

### 4. "Tool count" has no per-vendor definition, so counts are not comparable

**Claim.** "**Tool count** | Tool/function calls per phase per agent when the
vendor transcript records them" and "count tool-use records while parsing for
tokens."

**Rule.** A metric the issue calls "accurate" needs a definition stable enough
that two runs are comparable; otherwise the number moves for reasons unrelated to
efficiency.

**Failure.** Claude records `tool_use` blocks inside assistant messages; codex
records function calls in a different shape and granularity. If the report sums
them into a roster total, or compares claude's count against codex's, the figure
tracks vendor mix rather than efficiency — and a Phase 2 change that shifts work
between agents would register as a tool-count change with no efficiency
difference at all.

**Correction.** Define the counted record per vendor; report per-vendor and never
a cross-roster total; compare a vendor against itself before and after. One
sentence in `docs/analytics.md` per vendor.

### 5. Absent vendor data is not distinguished from measured zero

**Claim.** "Vendors with no local usage/tools (Cursor/Antigravity today): report
time + phase/action counts only; token/tool sections omitted — absence is normal,
not an error."

**Rule.** A missing measurement and a measured zero are different facts.
Conflating them biases a Phase 2 comparison in the favourable direction.

**Failure.** Omission is specified for the whole section but not per agent. A run
total printed with two silent vendors contributing nothing reads as the whole
roster's cost when it is half of it. If Phase 2 changes the roster or a vendor
gains usage reporting, the before/after comparison silently understates the
before. `docs/analytics.md` §1.4 confirms two of four agents expose nothing.

**Correction.** Per-agent coverage state (`complete` / `partial` /
`unavailable`); report `null`, never `0`, for a metric never recorded; never
print a roster total mixing measured and unavailable agents without labelling
coverage. (This discipline is Codex's; it is the best thing in that plan.)

### 6. No privacy boundary on transcript reads

**Claim.** `src/analytics.ts` will "optionally join vendor transcripts using
journaled `transcriptPath`/`sessionId`." The Risks table has three rows, none
about content handling.

**Rule.** The coordinator writes a journal and a report the owner may share;
reading a vendor's private transcript must not copy content into either.

**Failure.** Nothing in the plan forbids an implementer from reading whole
transcripts and surfacing message excerpts or tool arguments in the report, or in
an error message on a malformed line. Codex's plan states this boundary
explicitly (Implementation Details item 10); Cursor's does not, so an
implementation that leaks content is conformant to the plan as written.

**Correction.** One line in the plan and one assertion in the test: read numeric
usage fields and tool-record **counts** only — never message content, tool
arguments, or tool results — asserted by the returned object's shape so a later
field addition cannot leak text silently.

### 7. No acceptance criterion — the reader cannot be shown correct

**Claim.** Tests: "Analytics without transcripts still prints accurate phase
counts and times," asserted against a fixture journal authored with the reader.

**Rule.** A measurement tool must be validated against a known-good result
derived independently of it, not only against a fixture written alongside it.

**Failure.** Fixture and reader can encode the same misunderstanding and both
pass — the obvious one being phase attribution, where an interval is credited to
`details.to` instead of `details.from`. Every phase number would shift by one
phase and the suite would stay green. `docs/analytics.md` §2.1 and §2.3 already
publish hand-computed phase durations and per-agent latencies for the real
issue-76 journal; nothing in the plan checks against them.

**Correction.** Add one acceptance test: `coord analytics --issue 76`, run
against the existing issue-76 runtime journal, must reproduce the §2.1 and §2.3
tables. If it cannot re-derive the baseline it replaces, Phase 2 must not rely on
its numbers.

### 8. `turnId` is beyond the four metrics

**Claim.** "`src/agentEvent.ts` — … include `sessionId`, `turnId`, and
`transcriptPath` in `details`."

**Rule.** Phase 1 admits only what the four metrics require; the issue forbids
over-building.

**Failure.** `sessionId` identifies the transcript to join; bucketing usage into
phases is done by timestamp within that session. No metric consumes `turnId`, so
it adds a journaled field, a test assertion, and a per-vendor shape question that
nothing reads.

**Correction.** Drop `turnId`.

### 9. Speculative vendor-field hunting

**Claim.** "parse Claude `transcript_path` (**and any equivalent field other
vendors already send**) into the observation."

**Rule.** A file map should name work that is known to exist, so an implementer
can tell when they are done.

**Failure.** Only claude's payload is known to carry a transcript path;
`docs/analytics.md` §1.4 found no local store for antigravity and no usage data
in cursor's SQLite blobs. The parenthetical sends an implementer searching four
vendors' payloads for fields that may not exist, with no completion condition.

**Correction.** Name claude's `transcript_path` explicitly. Add another vendor
only when a payload is shown to carry one.

### 10. `docs/analytics.md` is no longer a from-scratch creation

**Claim.** Created: "`docs/analytics.md` — short contract: the four metrics, how
to run `coord analytics`, which vendors can supply tokens/tools, explicit
non-goals for Phase 1."

**Rule.** The created list means the file does not exist at the baseline.

**Failure.** The claim is true against `origin/main`, so this is a coordination
note rather than a defect: I pushed a 425-line `docs/analytics.md` to
`origin/issue-89/claude` at `613e3e8`, and it is the only record of the issue-76
measured baseline — the §2.1/§2.3 tables that finding 7's acceptance test needs.
Authoring a fresh "short contract" at the same path discards them.

**Correction.** State that the file reconciles with the existing document, and
that the issue-76 baseline tables are preserved in it.

### 11. Deferring `--json` is correct — do not change it

**Claim.** "text output by default (no `--json` requirement in Phase 1)", with
`--json` listed under "Phase 1 explicitly out of scope."

**Assessment.** **No change needed.** I raised `--json` in my own plan on the
grounds that comparing runs by eye invites error. On reflection Cursor is right
for this issue: Phase 2 compares a small number of runs, a human summary is
sufficient for that, and the issue's constraint is simplicity. Recorded here so
the omission reads as a decision rather than an oversight.

## Conclusion

Adopt **Cursor's plan**, with findings 1–10 applied; finding 11 is a
confirmation, not a change.

Findings 1 and 2 are blocking and mechanical: without them the branch cannot pass
`check:fast` and therefore cannot be committed at all. Findings 3, 8 and 9 all
*reduce* scope, which is the direction the issue asks for — dropping the
undecidable debounce, `turnId`, and the speculative vendor-field search. Findings
4, 5, 6 and 7 are correctness of the measurement itself: a tool-count definition,
absent-versus-zero, a privacy boundary, and an acceptance test against the
existing issue-76 journal. Three of those four import discipline from Codex's
plan, which handles them better than any other document here.

Applied, Cursor's Phase 1 is three source files plus a reader — `agentEvent.ts`,
`agentLifecycle.ts`, `cli.ts`, and a new `analytics.ts` with its transcript
reader — plus the version bump and its four test files. It touches neither the
run loop, the action format, nor the journal schema, and it delivers all four
metrics the issue names.

The single thing I would not compromise on is finding 7. Two of the four metrics
have been derivable from the journal all along, which is how `docs/analytics.md`
published those tables by hand; a reader that cannot reproduce them is measuring
something else, and every Phase 2 decision would inherit the error.

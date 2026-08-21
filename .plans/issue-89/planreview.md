# Issue 89 peer plan review

Reviewed against the updated issue body at 2026-08-21T05:26:17Z and the
repository rule to keep Phase 1 simple: measure accurate protocol time, token,
tool, and phase counts first; choose Phase 2 improvements from those results.

Published inputs:

- Antigravity plan: `9e7cc636936adb8c0e852fd9fb738566f8b8353b`
- Claude plan: `613e3e8c163b35b2fd2574b415737a5847a80559`
- Cursor plan and discussion: `d9905eaec4e6ffac9e74b011264ee74f39b113e7`

Only Cursor published `.plans/issue-89/discussion.md`; the Antigravity and Claude
refs contain `plan.md` only.

## Comparison

### 1. Claude — best initial plan, revise before acceptance

Claude has the best starting architecture and scope. It notices that phase count
and phase time are already derivable from `started`, `gate-advanced`,
`action-prepared`, and their timestamps, so Phase 1 needs a reader rather than
new duration events. It also keeps Phase 2 changes out of the metrics ship,
provides human and JSON output, separates vendor-shaped transcript parsing, and
uses explicit `complete`/`partial`/`unavailable` coverage instead of substituting
bytes for tokens. Those choices most directly satisfy the updated issue without
building a general observability platform.

The plan is not yet complete or safe enough to implement unchanged. The
findings below are the complete revision list needed for acceptance.

### 2. Cursor — correct direction, less complete

Cursor reaches the same narrow report-time transcript-join design, but it is a
weaker implementation contract: `--json` is omitted, vendor parsing is not
isolated, the transcript locator/security boundary is unspecified, debouncing
is optional, and `test/analytics.test.ts` appears in both changed and created
file lists. Claude incorporates Cursor's strongest simplification while adding
coverage rules, fixtures, a separate transcript reader, and a replay acceptance
test.

### 3. Antigravity — reject as the starting plan

Antigravity combines Phase 1 with protocol deduplication, action-packet changes,
a repository index/query service, context files, a submit command, automatic
artifact repair, five coordinator-owned steps, paired-step redesign, and
coordinator-owned cleanup. That violates the issue's explicit two-phase order
and simplicity constraint. It also proposes changing clone-local `AGENTS.md`,
which this repository's protocol forbids, classifies nonexistent
`src/actionPreparation.ts` as changed, omits several state/evidence files its
workflow redesign would require, and does not derive its claimed reduction from
37 actions to about 16. It is an idea backlog, not an acceptably bounded Phase 1
plan.

## Findings

### 1. [P1] Publish the acceptance oracle the plan relies on

**Plan claim:** Claude lines 9, 37-40, 73, 95, 117, 123-129, and 161-165 rely on
an untracked `docs/analytics.md`, including its issue-76 tables and numbered
sections, as both design evidence and the Phase 1 replay oracle.

**Rule:** Every input and expected value required to implement or accept the
selected plan must be available from a published, immutable source. A selected
plan cannot depend on a file that exists only in one peer's working tree.

**Concrete failure:** An implementer or reviewer checking out
`613e3e8c163b35b2fd2574b415737a5847a80559` cannot read the cited document,
know the expected §2.1/§2.3 values, reproduce the asserted vendor coverage, or
determine whether `coord analytics --issue 76` passes the acceptance test.
Different agents can therefore implement and approve different metric
semantics while all claiming conformance.

**Smallest correction:** Publish `docs/analytics.md` on the selected origin ref
before implementation, or move every binding definition and exact issue-76
expected value needed for acceptance into `plan.md` and the named fixture.
Remove all references to unpublished clone-local paths. The published document
must state which measurements were derived from the issue-76 journal and which
vendor claims were established separately.

### 2. [P1] Replace the arbitrary transcript path with a confined vendor locator

**Plan claim:** Claude lines 53, 63-67, 111-117, and 202-211 propose journaling
`transcriptPath` from a hook payload and later giving that path to
`src/transcriptRead.ts`; the mitigation is only to bound the read and avoid
copying content.

**Rule:** Owner-side code must not open an arbitrary path supplied by an agent or
hook. Transcript lookup must be confined to an explicitly trusted vendor data
root, reject symlinks and non-regular files, and have a fixed byte/line bound.
Every vendor for which the report claims coverage must also have a real locator,
not only a fixture parser.

**Concrete failure:** A forged or malformed lifecycle payload can journal an
absolute path outside the vendor store, a symlink, FIFO, device, or very large
file. Running `coord analytics` would then read or block on that target with the
owner's privileges. Separately, current Codex normalization carries
`session_id` and `turn_id` but no transcript path (`src/agentEvent.ts:92-109`),
so the proposed Codex fixture can pass while a real Codex run always reports
usage unavailable.

**Smallest correction:** Make `src/transcriptRead.ts` accept a vendor,
`sessionId`, trusted home/data roots, and a session time hint. Resolve Claude
and Codex files under their documented/configured owner-local stores; for a
hook-supplied Claude path, canonicalize it and require it to remain under the
expected Claude project root, preferably storing only a validated relative
locator. Resolve Codex by session ID rather than assuming a payload path. Reject
symlinks, non-regular files, out-of-root paths, and files beyond the documented
bound. Inject the roots in tests. Add confinement, symlink, FIFO/non-regular,
missing-session, and oversize tests to `test/transcriptRead.test.ts`.

### 3. [P1] Bind transcript records to the exact coordinator action and turn

**Plan claim:** Claude lines 39-44 and 102-115 say a session/path join yields
per-phase, per-agent token and tool counts, but the changed-file description at
lines 63-67 journals only `sessionId` and `transcriptPath`. The reader is allowed
to use a time or session window.

**Rule:** Per-phase token and tool metrics must join through stable action and
turn identity. Wall-clock proximity or session identity alone is insufficient,
and cumulative usage snapshots and tool records must be deduplicated before
aggregation.

**Concrete failure:** One vendor session can contain owner prompts, repeated
coordinator actions, retries, background work, or side-chain records. Bucketing
the whole session or a timestamp window can charge one action's tokens/tools to
another phase. Summing cumulative token snapshots or counting both a tool call
and its result can double-count usage while still producing plausible totals.

**Smallest correction:** Add `turnId` to the `agent-lifecycle` journal projection
alongside `sessionId`, preserving the existing top-level `actionId`. Define one
join as the prompt-submitted-to-stop turn for that exact action. In
`src/transcriptRead.ts`, deduplicate assistant responses and tool invocations by
stable vendor IDs, count calls but not results, use per-turn usage or deltas
rather than summing cumulative totals, and return unassigned records separately.
If a vendor cannot correlate a record to the bound action/turn, mark that slice
partial instead of using a time-only guess. Add overlapping-session, retry,
cumulative-usage, duplicate-record, tool-result, and side-chain fixtures.

### 4. [P1] Freeze the four metric definitions and coverage rules

**Plan claim:** Claude lines 30-44, 102-117, and 135-150 promise phase, time,
token, and tool counts, while lines 212-224 acknowledge that two agents expose
neither usage store and tool-call meanings differ by vendor.

**Rule:** A metrics plan must define exactly what is counted, its interval, and
when a total is valid. An unavailable vendor must never be treated as zero or be
silently omitted from a protocol-wide total used to select Phase 2.

**Concrete failure:** Implementations can disagree on whether a "phase" is a
workflow step, gate interval, or revision; whether run time ends at final gate or
publication; whether cached input is included again in input total; whether
failed tool attempts count; and whether a two-vendor token subtotal is displayed
as the four-agent protocol total. Before/after reports then look comparable but
measure different things.

**Smallest correction:** Make the published `docs/analytics.md` contract define:

- phase count as named workflow gate intervals, including revision rounds and
  retries, with actions per phase reported separately;
- workflow time from `started.at` through the terminal `gate-advanced` boundary,
  and in-progress/abandoned windows explicitly labeled;
- token components (`input`, `output`, `cacheRead`, `cacheWrite`, and any
  reasoning component), the vendor-specific source field for each, and a total
  formula that does not double-count cache/cumulative values;
- tool count as invocation attempts only, never results, reported per vendor;
- coverage denominators by active agent and bound action/turn; and
- no cross-roster token/tool total unless coverage is complete. Phase 2 may
  compare only the same vendor/coverage cohort before and after.

The JSON schema must carry the metric definition/version and coverage reason,
not only a nullable number.

### 5. [P1] Preserve partial data and a consistent transcript snapshot

**Plan claim:** Claude lines 144-150 say a truncated or malformed final
transcript line returns `undefined`; lines 206-208 say parse failure yields
`undefined`, not an error.

**Rule:** Accurate reporting must distinguish "no store", "unsupported schema",
"partial/truncated read", and a complete zero. A reader of a live append-only
file must also operate on a fixed snapshot boundary.

**Concrete failure:** One malformed trailing record can discard otherwise valid
usage, or a parser can skip a bad record and still label an undercount complete.
An in-progress transcript that grows during the read can produce tokens from one
snapshot and tools from another. Either result can select the wrong Phase 2
optimization.

**Smallest correction:** Return a structured result containing values, coverage,
and reason/warnings rather than bare `undefined`. Read at most the regular
file's initial byte length; label an in-progress/growing or truncated file
partial; tolerate only a final incomplete line as partial; treat an interior
malformed record or unknown usage schema as unsupported/partial. Test each state
and assert that none can render as complete or zero.

### 6. [P2] Remove status-tick debouncing from Phase 1

**Plan claim:** Claude lines 68-74, 151-155, 217-220, and 243-245 include
Antigravity status-event debouncing because duplicate rows allegedly corrupt
phase and action counts.

**Rule:** Phase 1 may change only what is required to measure the four issue
metrics. The analytics reader can count `gate-advanced` and `action-prepared`
without modifying lifecycle delivery behavior.

**Concrete failure:** Debouncing adds stateful behavior to the hot lifecycle and
watchdog path, creates new regression surface, and can suppress an observation
needed for recovery. The existing duplicate lifecycle rows increase journal
size but do not alter the count of gate/action event types, so the extra change
provides no required metric.

**Smallest correction:** Delete debouncing from the changed-file map,
implementation, tests, risks, and conclusion. Stream/filter the existing journal
in `src/analytics.ts`. Treat journal-volume reduction as a separately measured
Phase 2 candidate only if Phase 1 shows it matters.

### 7. [P1] Complete the exact file map and real pipeline acceptance tests

**Plan claim:** Claude lines 80-87 and 133-165 say the version bump plus
analytics/unit fixtures and an issue-76 replay are sufficient; the conclusion
calls Phase 1 "three source files plus a reader."

**Rule:** The plan's file map must name every required repository change, and
acceptance must exercise the same hook-payload-to-journal-to-transcript-to-report
path used in production for every vendor whose token/tool coverage is claimed.

**Concrete failure:** Bumping `package.json` and
`config.product.example.json` without changing the literal install assertion in
`test/install.test.ts` fails `pnpm check:fast`. More importantly, isolated
transcript fixtures can pass while the actual journal omits `turnId`, the Codex
resolver cannot locate a session, or CLI context resolution is wrong. The
issue-76 replay cannot catch token/tool wiring because its historical journal
contains no transcript join identity.

**Smallest correction:** Add `test/install.test.ts` to the changed file list and
update its installed-version assertion. Specify the exact CLI as
`coord analytics --issue <n> [--product <path> | --coord-root <path>] [--json]`
and test both resolution paths and strict flag handling. Add an end-to-end
fixture test that sends sanitized real-shaped Claude and Codex lifecycle payloads
through `handleAgentEvent`, reads the resulting journal, resolves a confined
session transcript, and verifies phase attribution plus token/tool counts.
Keep the issue-76 replay for historical phase/time validation, but add a
post-Phase-1 live/manual canary for each claimed vendor because issue 76 cannot
validate the new join. The final exact map should be:

**Changed:**

- `src/agentEvent.ts`
- `src/agentLifecycle.ts` only if the chosen validated locator must traverse the
  normalized observation
- `src/cli.ts`
- `package.json`
- `config.product.example.json`
- `test/agentEvent.test.ts`
- `test/cli.test.ts`
- `test/install.test.ts`

**Created:**

- `src/analytics.ts`
- `src/transcriptRead.ts`
- `test/analytics.test.ts`
- `test/transcriptRead.test.ts`
- the sanitized journal/Claude/Codex fixtures named in the plan
- the published `docs/analytics.md`

No other Phase 1 product files, status debounce, action format, run-loop,
journal schema, context system, or Phase 2 workflow change is required.

## Conclusion

**Verdict: revise Claude's plan, then use it as the initial Phase 1 plan.** It is
the only peer plan that combines the updated issue's strict four-metric scope
with a sufficiently testable report-time join and honest coverage states.
Cursor confirms the same core direction but is less complete; Antigravity is far
outside the requested simplicity boundary.

Claude's plan becomes complete and correct after seven bounded changes: publish
the missing analytics contract, confine and complete vendor transcript
resolution, correlate by action/session/turn with deduplication, freeze metric
and coverage semantics, preserve partial snapshot state, remove status
Debouncing, and complete the file/test map with a real pipeline canary. Those
revisions do not expand Phase 1; they make the selected minimal design safe,
reproducible, and accurate enough for Phase 2 decisions.

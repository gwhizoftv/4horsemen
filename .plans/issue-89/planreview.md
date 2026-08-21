# Issue 89 Plan Review: Analytics & Efficiency Foundation

- Reviewer: Antigravity
- Issue: [#89 — Increase speed and efficiency, reduce token usage, tool calling](https://github.com/gwhizoftv/coordination/issues/89)
- Branch: `issue-89/antigravity`
- Baseline: `origin/main` (`1bfc7f9`)
- Reviewed Artifacts:
  - Claude: [`coordination-claude/.plans/issue-89/plan.md`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-claude/.plans/issue-89/plan.md) (`613e3e8c`) and [`coordination-claude/docs/analytics.md`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-claude/docs/analytics.md)
  - Codex: [`/private/tmp/coord-issue-89-codex/.plans/issue-89/plan.md`](file:///private/tmp/coord-issue-89-codex/.plans/issue-89/plan.md) (`4868a0d9`) and discussion
  - Cursor: [`coordination-cursor/.plans/issue-89/plan.md`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-cursor/.plans/issue-89/plan.md) (`d9905ea`) and discussion

---

## Comparative Assessment & Best Starting Point

### Summary of Peer Plans

1. **Claude's Plan (`613e3e8c`):**
   - Focuses strictly on Phase 1 to capture the 4 required metrics (**time**, **token count**, **tool count**, **phase count**).
   - Adopts Cursor's read-time transcript join in `coord analytics`, avoiding write-time journal pollution or schema version bumps.
   - Adds `sessionId` and `transcriptPath` into `agent-lifecycle` journal details in `src/agentEvent.ts`.
   - Debounces consecutive identical Antigravity status ticks in `src/agentEvent.ts` (cutting 80% of journal noise).
   - Creates an isolated `src/transcriptRead.ts` reader that extracts numeric tokens and tool counts without leaking prompt or message text.
   - Leaves `src/runLoop.ts`, `src/action.ts`, and `src/state.ts` untouched.
   - Promotes `docs/analytics.md` as the documented baseline contract.

2. **Codex's Plan (`4868a0d9`):**
   - Proposes a heavy coordinator-native metrics platform (`coord report --efficiency`) measuring mirror blob sizes and coordinator operation durations.
   - Explicitly rejects vendor transcript adapters, substituting action and bound-input bytes as a proxy for tokens.
   - Touches `src/mirror.ts`, `src/runLoop.ts`, and `src/state.ts`.
   - *Assessment:* Over-engineered and fails to satisfy Issue #89's explicit requirement to measure model token usage and tool calling.

3. **Cursor's Plan (`d9905ea`):**
   - Proposes the minimal 4-metric slice with read-time transcript joins in `src/analytics.ts`.
   - Leaves status debouncing and `--json` export optional.
   - *Assessment:* Excellent conceptual direction, but Claude's latest plan refines and formalizes this into an exact, tested specification.

### Initial Verdict

**Claude's plan ([`coordination-claude/.plans/issue-89/plan.md`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-claude/.plans/issue-89/plan.md) at `613e3e8c`) is the best starting point.** It strikes the exact balance required by the updated Issue #89 text: highly efficient, simple, and strictly scoped to the four metrics (time, tokens, tools, phases) without over-building.

---

## Findings

### Finding 1: Per-Agent Status Debouncing State
- **Plan Claim:** `src/agentEvent.ts` — *"suppress the `appendJournal` call when the observation is status-only and byte-identical to the previous consecutive status tick for that agent."*
- **Rule That Must Hold:** Status debouncing tracking state must be strictly partitioned **per-agent** (e.g. `Map<string, string>`).
- **Concrete Failure:** If the tracking state is stored in a single global variable, alternating status ticks from multiple active agents (e.g. Antigravity emits status, then Codex emits status, then Antigravity emits status) will never match the immediately preceding single global value, causing zero debouncing to occur during multi-agent runs and leaving the journal 80% bloated with redundant ticks.
- **Smallest Correction:** Store the last status-line signature in a `Map<string, string>` keyed by `agentId` (or within the agent's in-memory `LifecycleStateEntry`), ensuring identical consecutive ticks for each individual agent are correctly debounced regardless of interleaving from peers.

---

### Finding 2: Safe Transcript Isolation and Content Leakage Boundary
- **Plan Claim:** `src/transcriptRead.ts` — *"reads only the tail of the vendor file and returns the numeric usage delta (input, output, cacheRead, cacheWrite) and tool-call counts... no message content, tool argument, or tool result appears in the returned object."*
- **Rule That Must Hold:** The transcript reader must parse only JSON structural tokens and numeric fields, validating returned objects with an explicit strict schema that rejects string content fields, and must handle trailing incomplete JSON lines gracefully.
- **Concrete Failure:** When an agent CLI is actively writing to a transcript file concurrently, the last line in the JSONL store is frequently partially written. If the reader attempts `JSON.parse` on the tail without ignoring a partial trailing line, `transcriptRead` will throw syntax errors, causing `coord analytics` to fail or report missing data for active sessions.
- **Smallest Correction:** Process complete newline-terminated lines from the tail; catch and skip incomplete final lines; validate the returned summary using a strict schema (`z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), toolCalls: z.number() }).strict()`).

---

### Finding 3: Graceful Handling of Missing or Inaccessible Vendor Stores
- **Plan Claim:** `src/analytics.ts` — *"a journal with no identity fields still reports phase count and time, omitting the token and tool sections rather than erroring; a metric never recorded reports null and coverage unavailable, never 0."*
- **Rule That Must Hold:** File access errors (such as `ENOENT`, `EACCES`, or missing transcript paths on external machines) must be caught locally inside `transcriptRead` and translated to `{ coverage: "unavailable", metrics: null }`.
- **Concrete Failure:** If `transcriptPath` is recorded from machine A, and `coord analytics --issue <n>` is executed on machine B (or inside a CI test container without access to the local home directory), unchecked filesystem reads will throw unhandled exceptions and crash the CLI command.
- **Smallest Correction:** Wrap transcript file opens in `try/catch`, returning `{ coverage: "unavailable" }` whenever the file is unreadable. Assert this explicitly in `test/analytics.test.ts`.

---

### Finding 4: Clock Skew and Monotonic Phase Intervals
- **Plan Claim:** `src/analytics.ts` — *"phase durations from started + gate-advanced intervals, and the run total."*
- **Rule That Must Hold:** Phase intervals must be computed monotonically; if clock adjustments or malformed ISO timestamps produce a negative duration, the interval must fail closed or report invalid interval rather than silent negative seconds.
- **Concrete Failure:** If system clock adjustments occur between gate transitions, computing `(t_gate2 - t_gate1)` can yield negative durations, corrupting wall-clock totals and percentage breakdowns in the terminal table.
- **Smallest Correction:** Validate that `t_end >= t_start` for all intervals. If `t_end < t_start`, log an explicit duration anomaly warning and report the gate interval as invalid/unavailable.

---

### Finding 5: Tool Call Definition Consistency Across Vendors
- **Plan Claim:** `src/transcriptRead.ts` — extracts tool-call counts from Claude and Codex transcripts.
- **Rule That Must Hold:** Tool counting logic must match each vendor's specific JSON schema:
  - **Claude:** Count message content blocks where `type === "tool_use"`.
  - **Codex:** Count `event_msg` entries representing tool calls / executions.
- **Concrete Failure:** Claude transcripts record assistant messages that contain both text blocks and tool use blocks; counting entire assistant turns rather than specific `"tool_use"` content blocks will miscount tool calls as message turns.
- **Smallest Correction:** For Claude transcripts, iterate `message.content` array and count items where `block.type === "tool_use"`. For Codex transcripts, count events where `type === "tool_call"` or tool execution payloads. Document each vendor's exact filter in `docs/analytics.md`.

---

## Conclusion

**Claude's plan (`613e3e8c`) is the best starting point for Phase 1.** It is tight, disciplined, avoids touching the run loop or state schemas, and delivers the four required metrics (time, token count, tool count, and phase count) using simple read-time joins.

With the 5 minor refinements detailed in Findings 1–5 (per-agent debouncing map, trailing-line tolerance in transcript tails, safe file access boundaries, monotonic interval guards, and exact tool-use block filtering), Claude's plan is **complete, correct, and ready to implement immediately**.

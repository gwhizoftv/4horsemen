# Code review: Codex implementation for issue 89 Phase 1

- Reviewed head: `origin/issue-89/codex` @ `025bbd5683faa44566698ddc68cace98f26a205f`
- Baseline: `origin/main` @ `1bfc7f9e9a094e8611bb3b85f70714a5c870d602`
- Contract: selected Claude plan @ `99b4e7cea2c48155864f75d2b9020110364f566a`
- Scope: Phase 1 phase/time/token/tool analytics, transcript joins, CLI, fixtures,
  documentation, and the `0.0.13` ship bump
- Reviewer: Codex

## Findings

### [P1] Parse the real Codex `token_count` shape

**Path:** `src/transcriptRead.ts:303-310`. **Rule:** Codex token rows must join
using fields that the supported local store actually emits; otherwise coverage
must fail closed rather than presenting the fixture-only path as exact.
**Failure:** current CLI rollouts put `turn_id` on `task_started` and
`item_completed`, but not on any `token_count`; therefore the exact join at line
310 never fires, every token row needs the temporal fallback, completed turns
are at best `partial`, and an active/missing-stop turn remains wholly
unassigned. Current Codex App rollouts also omit `ordinal`, so line 303 marks an
otherwise valid token stream `unsupported`. The fixture invents both fields and
cannot expose either production failure. **Test:** use a sanitized rollout with
`task_started.turn_id` followed by `token_count` records containing only
`info`/`rate_limits`/`type` and no ordinal; require non-zero phase tokens with an
honest coverage state.

### [P1] Classify live Codex item variants without nulling valid tokens

**Path:** `src/transcriptRead.ts:330-333`. **Rule:** ordinary supported item
variants must either be classified as tool/non-tool or degrade only the metric
whose schema is unknown; a tool classifier must not erase independently parsed
tokens. **Failure:** real rollouts emit `item.type: "Extension"` for tool calls
such as `kind: "web.search"`, plus control items including
`EnteredReviewMode`/`ExitedReviewMode`. All hit this unknown branch, set the
whole transcript to `unsupported`, and cause analytics to replace every valid
token and tool phase with `null`. **Test:** add one `Extension` tool row and one
review-mode control row beside a valid `token_count`; require the tool to count,
the control not to count, and token coverage to survive.

### [P1] Require identity coverage for every attempted action

**Path:** `src/analytics.ts:312-316`. **Rule:** an agent may be `complete` only
when every attempted issue action either has a journaled session/turn binding or
is explicitly reported as incomplete. **Failure:** `hasSessionIdentity` checks
only whether any agent action has identity, and each agent later reads sessions
derived only from the successful bindings. If one of several prompt hooks omits
identity (especially after a restart), that action and possibly its entire
session disappear while the agent can still report `complete` and a low total
from its other actions. **Test:** give one agent two nudged actions but identity
for only one; require `partial`/`unavailable` coverage rather than complete
zeroes for the missing action's phase.

### [P1] Refuse totals while measured tokens remain unassigned

**Path:** `src/analytics.ts:408-417`. **Rule:** a cross-roster total may print
only when it accounts for every measured token or clearly refuses the total
(`docs/analytics.md:433-449`). **Failure:** the reduction sums only phase buckets
and ignores `agent.unassigned`, while unassigned rows do not lower agent
coverage. The branch's own fixture records 13 unassigned Claude input tokens
and 10 unassigned Codex input tokens, yet asserts a confident total of 23—the
report presents 23 while 46 input tokens were measured. **Test:** retain that
fixture and require `tokenTotal === null` whenever any active agent has
non-empty unassigned token usage (or include that usage explicitly in a
separately labelled total).

### [P1] Emit the active R1 interval before the first gate

**Path:** `src/analytics.ts:159-162`. **Rule:** every unfinished final interval
must be represented as `in-progress`, including the initial `R1.join` interval
before any `gate-advanced` event (`docs/analytics.md:395-398`). **Failure:** with
no gates, `finalGate` and `activeName` are null, so `phases` is empty; action
usage becomes unassigned and the complete-coverage reduction prints a
zero-filled cross-roster token total even though the live R1 turn has already
spent tokens. **Test:** build a started journal with an R1 action/turn but no
gate and require one in-progress `R1.join` phase with its usage, not an empty
phase list and zero total.

### [P2] Pair each retry wait with its own nudge

**Path:** `src/analytics.ts:232-246`. **Rule:** each latency sample must span one
delivery attempt, or an action-level metric must emit only one final sample.
**Failure:** `firstNudge` is never consumed; when verification rejects an intent
and the coordinator re-nudges the same `(agent, actionId)`, the second
`intent-seen` is measured from the original nudge while the first sample is
also retained. Issue 76 contains this exact pattern for Codex and Antigravity,
so count and median/max include overlapping waits and overstate the retry.
**Test:** `nudged(0) -> intent(10) -> nudged(20) -> intent(25)` should produce
attempt waits 10 and 5 (or one documented 25), not 10 and 25.

### [P2] Carry an R6 phase's round from its entry gate

**Path:** `src/analytics.ts:147-153`. **Rule:** revision phases must retain the
round in which the interval ran. **Failure:** completed phases take `round` from
the gate that exits the phase. In a two-round run, the gate
`R6.declare -> R6.revise` carries round 2, so the round-1 declare interval is
labelled round 2; the final `R6.declare -> R7.finalize` carries `null`, so the
last declare loses its round entirely. **Test:** close two R6 cycles and assert
the three intervals in each cycle remain labelled rounds 1 and 2 respectively.

### [P2] Include revision rounds in usage labels

**Path:** `src/analytics.ts:473-475`. **Rule:** per-phase token/tool output must
distinguish repeated revision-round intervals just as the time section does.
**Failure:** `PhaseUsageAnalytics` carries `round`, but both usage render loops
print only `phase.phase`; a multi-round report therefore emits multiple
indistinguishable `R6.revise`, `R6.ballot`, and `R6.declare` rows, so the reader
cannot tell which round consumed the tokens/tools. **Test:** render two R6 rounds
and require `round 1`/`round 2` in both token and tool rows.

## Verdict

**Changes required.** The journal-only issue-76 phase table reproduces and the
focused suite passes, but the core Codex token/tool path does not support the
live store shapes used by ordinary sessions. The remaining coverage and
in-progress defects can also publish confident totals over omitted usage, so
the Phase 1 numbers are not yet safe inputs to Phase 2 decisions.

Validation performed during review:

- `pnpm vitest run --config vitest.config.ts test/transcriptRead.test.ts test/analytics.test.ts test/agentEvent.test.ts test/cli.test.ts` — 50 passed.
- `node dist/main.js analytics --issue 76 --coord-root /Volumes/4TB-SOURCE/REPOS/coord/coord-runtime` — phase/time oracle reproduced.
- Live Claude and Codex transcript probes — Claude parses complete; current
  Codex samples reproduce findings 1 and 2.

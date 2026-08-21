# Issue 89 Implementation Plan: Speed, Efficiency, Token & Tool Optimization

- Issue: [#89 — Increase speed and efficiency, reduce token usage, tool calling](https://github.com/gwhizoftv/coordination/issues/89)
- Author: Antigravity
- Branch: `issue-89/antigravity`
- Baseline: `origin/main` (`1bfc7f9`)
- Inputs considered:
  - Updated Issue #89 description (two-phase simple and efficient approach)
  - Claude's telemetry analysis in [`coordination-claude/docs/analytics.md`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-claude/docs/analytics.md)
  - Cursor's design discussion in [`coordination-cursor/.plans/issue-89/discussion.md`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-cursor/.plans/issue-89/discussion.md)
  - Codex's turn reduction and context proposal in [`coordination-codex/.plans/issue-89/discussion.md`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-codex/.plans/issue-89/discussion.md)

---

## Executive Summary & Two-Phase Design

In alignment with the updated Issue #89 framing, the implementation is structured into two clean, focused phases designed to maximize efficiency and simplicity without over-engineering:

- **Phase 1: Accurate Telemetry & Analytics Baseline:**
  Enhance metrics and observability to capture accurate **time**, **token count**, **tool/turn count**, and **phase boundaries** across the protocol, unified under a new `coord analytics` CLI.
- **Phase 2: Targeted Enhancements & Turn Reductions Based on Metrics:**
  Execute high-leverage efficiency improvements: deduplicate prompt prefixes (`AGENTS.md`), supply self-contained `action.md` work packets, provide a concise codebase context capsule (`.coord/context.md`), automate deterministic clerical steps, and combine paired review/ballot turns (reducing consensus actions from 37 to ~16).

---

## Detailed Two-Phase Roadmap

### Phase 1: Enhanced Metrics, Analytics & Telemetry (Phase 1)
Deliver the minimal, exact instrumentation needed to measure time, tokens, tool/turn counts, and phases:

1. **Exact Time & Duration Tracking:**
   - Add `durationMs` to `gate-advanced.details` (exact phase wall-clock time).
   - Add `durationMs` to `verify-result.details` and `final-check.details` (coordinator overhead).
   - Track the complete delivery chain (`orderedAt` → `injectedAt` → `acceptedAt`) and duration in `action-timing` details ([`src/agentLifecycle.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/agentLifecycle.ts), [`src/runLoop.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/runLoop.ts)).
   - Add optional `preparedAt` ISO 8601 timestamp to `action.md` front-matter for agent self-measurement ([`src/action.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/action.ts)).

2. **Accurate Token & Tool/Turn Count Attribution:**
   - Populate `sessionId`, `turnId`, and `transcriptPath` in `agent-lifecycle` journal details ([`src/agentEvent.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/agentEvent.ts)).
   - Enables exact joins between coordinator phases and vendor transcript stores (Claude and Codex) to measure cache-read, cache-write, output tokens, and tool call turns per phase.

3. **Phase Count Tracking & Journal Noise Debouncing:**
   - Debounce repetitive identical status ticks (`status-line/working`) in [`src/agentEvent.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/agentEvent.ts). Keep in-memory lifecycle state and the watchdog updated while preventing 80% duplicate journal bloat (~260 KB per run).

4. **`coord analytics` Reporting CLI:**
   - Implement `coord analytics --issue <n> [--coord-root <path>] [--json]` in [`src/analytics.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/analytics.ts) and [`src/cli.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/cli.ts).
   - Reports phase durations and percentage share, turnaround latency distribution, verification overhead, token breakdown (input, output, cached), and tool/message counts.

---

### Phase 2: Workflow Enhancements & Turn Reductions Based on Metrics (Phase 2)
Apply concrete, high-leverage enhancements guided by the Phase 1 baseline:

1. **Prefix & Protocol Deduplication:**
   - Deduplicate [`AGENTS.md`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/AGENTS.md): trim tracked product text to human-facing intro and project constraints. The single canonical source for the coordination protocol is the managed block injected by `writeCloneAgentsProtocol` (`<!-- coordination protocol — coord install -->`), saving ~3.6 KB (~1,000 tokens) on every single turn (~400k tokens per consensus run).
   - Supply self-contained `action.md` work packets with inlined `git show <sha>:<path>` inspection commands for bound peer inputs to prevent exploratory git searches.

2. **Codebase Context Capsule:**
   - Create curated [`.coord/context.md`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/.coord/context.md) declaring high-level architecture, entry points, and authoritative check commands (`pnpm check:fast`, `pnpm check`) to eliminate repetitive discovery turns.
   - Generate baseline codebase sketch (`coord-runtime/issue-<n>/codebase-sketch.json`) with fast query helpers (`coord context search|tests-for`).

3. **Eliminate Clerical Turns & Combine Paired Steps:**
   - Coordinator-owned deterministic transitions: `R1.join` (verified via lifecycle session handshake), `R3.publish-selection`, `R5.reviser-auth`, `R6.declare`, and `R7.finalize` executed directly by coordinator logic.
   - Combine Plan Review + Plan Ballot (`R3.review`) into `.plans/issue-<n>/review.md` with structured findings and vote block.
   - Combine Implementation Comparison + Comparison Ballot (`R5.compare`) into `.code-reviews/issue-<n>/comparison.md` with structured comparison and verdict block.
   - Reduces consensus agent actions from 37 down to ~16 (>55% reduction).

4. **Submission Ergonomics & Safe Auto-Repair:**
   - Implement `coord submit --action <uuid>` helper to atomically verify commits and write `complete`.
   - Auto-repair harmless clerical verification mismatches (such as `automationDigest` recalculation on unchanged valid commits).

---

## Exact File List to be changed or deleted

### Changed Files

1. [`AGENTS.md`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/AGENTS.md)
   - Trim tracked product text to eliminate redundant protocol duplication against the managed overlay block (~3.6 KB / ~1,000 tokens trimmed per turn).
   - Clarify that after `R1.join`, agents should rely on `action.md` as the self-contained work authority.

2. [`package.json`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/package.json)
   - Pre-1.0 version bump reflecting the new analytics and efficiency feature set.

3. [`src/action.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/action.ts)
   - Support optional `preparedAt` timestamp in front-matter rendering (`renderAction`) and parser allowlist (`parseAction`).
   - Generate exact `git show <sha>:<path>` reading commands for all bound peer inputs in the action body.

4. [`src/actionPreparation.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/actionPreparation.ts)
   - Integrate bound input excerpts and context hints into action preparation.

5. [`src/agentEvent.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/agentEvent.ts)
   - Pass `sessionId`, `turnId`, and `transcriptPath` into lifecycle journal details.
   - Debounce consecutive identical `status-line/working` payloads so repetitive ticks do not bloat `journal.jsonl`.

6. [`src/agentLifecycle.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/agentLifecycle.ts)
   - Track full delivery timing chain (`orderedAt`, `injectedAt`, `acceptedAt`, `workflowCompleteAt`).

7. [`src/cli.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/cli.ts)
   - Route new subcommands:
     - `coord analytics --issue <n> [--coord-root <path>] [--json]`
     - `coord submit --action <uuid> [--commit <sha>]`
     - `coord context search|tests|symbols`
   - Update CLI help documentation.

8. [`src/finalization.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/finalization.ts)
   - Support coordinator-owned finalization cleanup commit and checks when enabled by workflow profile/policy.

9. [`src/machine.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/machine.ts)
   - Update transition state machine to support combined steps (`R3.review-and-ballot`, `R5.compare-and-ballot`) and coordinator-computed transitions (`R3.publish-selection`, `R5.reviser-auth`, `R6.declare`).

10. [`src/orderScaffold.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/orderScaffold.ts)
    - Provide pre-filled Markdown scaffolds for plans, reviews, and comparisons directly in `action.md` or as scaffold siblings.

11. [`src/paths.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/paths.ts)
    - Add runtime paths for `codebaseSketch` (`coord-runtime/issue-<n>/codebase-sketch.json`) and `analyticsReport` (`coord-runtime/issue-<n>/analytics.json`).

12. [`src/runLoop.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/runLoop.ts)
    - Record `durationMs` on `gate-advanced`, `final-check`, and `verify-result` journal events.
    - Execute coordinator-owned deterministic transitions without agent nudges.
    - Auto-repair harmless mechanical verification failures.

13. [`src/steps.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/steps.ts)
    - Add definitions and evidence validators for combined review/ballot and comparison/ballot artifacts.

14. Existing Test Suites:
    - [`test/action.test.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/test/action.test.ts)
    - [`test/agentEvent.test.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/test/agentEvent.test.ts)
    - [`test/cli.test.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/test/cli.test.ts)
    - [`test/machine.test.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/test/machine.test.ts)
    - [`test/runLoop.test.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/test/runLoop.test.ts)
    - [`test/steps.test.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/test/steps.test.ts)

### Deleted Files
- None (all changes are additive, backward-compatible, or in-place refactorings).

---

## Exact file list to be created

1. [`src/analytics.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/analytics.ts)
   - Core analytics engine parsing `journal.jsonl` and vendor transcripts (Claude, Codex).
   - Computes exact phase durations, turnaround latency distributions, verification overhead, debounced tick counts, tool call counts, and token attribution.
   - Exports `renderAnalyticsReport(issue, paths, format)` for CLI and JSON output.

2. [`test/analytics.test.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/test/analytics.test.ts)
   - Unit and fixture tests verifying calculation of phase intervals, delivery latency pairs, verification durations, token attribution from transcript fixtures, and JSON/table rendering.

3. [`src/codebaseContext.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/codebaseContext.ts)
   - Deterministic repository indexer generating `codebase-sketch.json` and query helpers (`coord context ...`).

4. [`test/codebaseContext.test.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/test/codebaseContext.test.ts)
   - Unit tests for repository indexing, deterministic JSON output, and CLI query commands.

5. [`src/submit.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/src/submit.ts)
   - Implementation of `coord submit --action <uuid> [--commit <sha>]`.

6. [`test/submit.test.ts`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/test/submit.test.ts)
   - Unit tests for atomic submission verification and error reporting.

7. [`.coord/context.md`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/.coord/context.md)
   - Curated repository capsule declaring core driver architecture, entrypoints, and test commands.

8. [`.plans/issue-89/plan.md`](file:///Volumes/4TB-SOURCE/REPOS/coord/coordination-antigravity/.plans/issue-89/plan.md)
   - This implementation plan file.

---

## Tests

### 1. Phase 1 Analytics & Telemetry Unit Tests
- `test/analytics.test.ts`:
  - Verify calculation of phase durations from synthetic journal logs.
  - Verify turnaround time pairing (`nudged` → `intent-seen`).
  - Verify transcript token extraction and phase attribution for Claude and Codex formats.
  - Verify tool turn counts and message volume metrics.
  - Verify JSON and human-readable formatting of `coord analytics`.
  - Verify graceful fallback to journal-only metrics when vendor transcript files are absent.
- `test/agentEvent.test.ts`:
  - Test debouncing of identical consecutive status-line events.
  - Test inclusion of `sessionId`, `turnId`, `transcriptPath` in `agent-lifecycle` journal details.
- `test/action.test.ts`:
  - Test parsing and rendering with `preparedAt` field.
  - Test input inspection command generation in action body.

### 2. Phase 2 Efficiency & State Machine Tests
- `test/codebaseContext.test.ts`:
  - Verify repo indexing on test fixture directory and query subcommands.
- `test/submit.test.ts`:
  - Verify atomic creation of `complete` token file.
- `test/machine.test.ts` & `test/runLoop.test.ts`:
  - Test execution of coordinator-owned steps and combined review/ballot validation.
  - Verify end-to-end consensus workflow completes with reduced action count (~16 actions).
  - Verify `durationMs` event emission on gates, checks, and verifications.

### 3. Fast Verification & Acceptance
- Run `pnpm check:fast` (linting, type checking, unit tests).
- Run `pnpm check` (full build, fast checks, and e2e integration tests).

---

## Alternatives Rejected

1. **Over-Engineering Live Streamed Token Events:**
   - *Rejected:* On-demand transcript joins during `coord analytics` using `transcriptPath` and `sessionId` provide exact token metrics per phase without complicating runtime journal writing or requiring runtime schema version bumps.

2. **Dumping Full Codebase Indexes into Prompt Prefixes:**
   - *Rejected:* Inserting huge codebase indexes into `action.md` inflates the prompt prefix, directly conflicting with the prefix-reduction goal. A concise capsule + on-demand query helpers is far leaner.

3. **Replacing Tmux with ACP / Direct App-Server Integration:**
   - *Rejected:* Out of scope and contrary to keeping design simple without over-engineering.

4. **Dropping Multi-Agent Diversity in Consensus Profile:**
   - *Rejected:* We optimize turn count and clerical friction rather than eliminating independent implementations.

---

## Risks and Mitigations

| Risk | Impact | Mitigation Strategy |
| --- | --- | --- |
| **Telemetry Parser Drift across Vendor Versions** | Vendor transcript formats (Claude/Codex) might change structure in future releases. | Make vendor transcript token extraction non-blocking. If transcript parsing encounters unknown fields, fall back gracefully to journal-only metrics without failing commands. |
| **Antigravity Status Debouncing Dropping Vital State** | Over-aggressive debouncing might suppress real lifecycle state changes. | Only debounce consecutive identical status events where `kind`, `execution`, and `health` have not changed. Any transition to working, waiting, or completed immediately emits. |
| **Combined Review+Ballot Format Confusion** | Reviewers might fail to supply a clear structured vote in `review.md`. | Provide explicit markdown scaffold with clear heading markers; validate both findings and ballot in a single check. |
| **Auto-Repair Overreach** | Coordinator auto-repair might inadvertently mask semantic defects. | Strictly restrict auto-repair to known clerical/mechanical fields (such as `automationDigest` recalculation on unchanged artifacts). |

---

## Conclusion

This plan matches the updated two-phase framing of Issue #89:
- **Phase 1** delivers exact time, token, tool/turn count, and phase telemetry through a lightweight `agent-lifecycle` journal enrichment, Antigravity debouncing, and a unified `coord analytics` CLI.
- **Phase 2** leverages those metrics to execute targeted, high-impact enhancements: deduplicating `AGENTS.md`, providing a concise codebase capsule, automating clerical transitions, and consolidating paired review/ballot steps—slashing consensus actions from 37 to ~16 (>55% reduction) and saving millions of tokens per run.

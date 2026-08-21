# Issue 89 plan — metrics then improvements (simple)

- Issue: https://github.com/gwhizoftv/coordination/issues/89
- Baseline: `origin/main` at `1bfc7f9`
- Issue body (updated): two phases, keep design/implementation simple — no overbuilding:
  1. Metrics needed for accurate **time**, **token count**, **tool count**, and **phase count**
  2. Enhancements/improvements **based on** those metrics
- Also considered: Claude `docs/analytics.md`, Codex + Cursor issue-89 discussions (ideas only; issue text wins on scope)

## Binding scope

| Phase | Goal | Rule |
| --- | --- | --- |
| **1** | Accurate protocol metrics | Only instrumentation + report needed for the four counts below |
| **2** | Efficiency improvements | Chosen and judged using Phase 1 numbers; separate plan/PR after Phase 1 |

Phase 1 does **not** include AGENTS trim, clerical step collapse, ballot merges, context files, verify-failure classification, delivery-chain journals, or `preparedAt`. Those are Phase 2 candidates (or unrelated), measured after Phase 1 exists.

## Phase 1 — Four metrics only

What “accurate” means for this protocol:

| Metric | Definition | Source today | Gap to close |
| --- | --- | --- | --- |
| **Phase count** | How many workflow phases ran (and actions per phase) | `gate-advanced`, `action-prepared` already in journal | Report them; no new events |
| **Time** | Wall-clock per phase and total run; per-agent wait (first `nudged` → `intent-seen`) | Timestamps already on journal rows | Report them; derive durations from `at` (do **not** add redundant `durationMs` fields unless a duration cannot be derived) |
| **Token count** | Input/output/cache tokens per phase per agent when the vendor exposes them | Claude/Codex transcripts only; coordinator stores none | Journal `sessionId` + `transcriptPath` (and `turnId` when present) on `agent-lifecycle` so the report can join without wall-clock guessing |
| **Tool count** | Tool/function calls per phase per agent when the vendor transcript records them | Same transcripts | Same join; count tool-use records while parsing for tokens |

Vendors with no local usage/tools (Cursor/Antigravity today): report time + phase/action counts only; token/tool sections omitted — absence is normal, not an error.

### Exact File List to be changed or deleted

#### Changed

- `src/agentEvent.ts` — when journaling `agent-lifecycle`, include `sessionId`, `turnId`, and `transcriptPath` in `details` when the normalized observation has them; parse Claude `transcript_path` (and any equivalent field other vendors already send) into the observation. Optional: suppress identical consecutive antigravity **status** journal rows only if needed so `readJournal` for analytics stays cheap (lifecycle state still updates). No new journal event types required for the four metrics.
- `src/agentLifecycle.ts` — optional `transcriptPath` on `LifecycleObservation` if that is the cleanest way to pass the path through to the journal projection.
- `src/cli.ts` — add `coord analytics --issue <n>` and help text.
- `package.json` — bump version strictly above `origin/main` (`0.0.12`).
- `config.product.example.json` — version lockstep if it pins the package version.
- `test/agentEvent.test.ts` — details carry session/turn/transcript when present; omitted when absent.
- `test/cli.test.ts` — analytics command on a fixture runtime.
- `test/analytics.test.ts` — see created files (may live only there if CLI test stays thin).

#### Deleted

- None required for Phase 1 metrics. (Do not spend Phase 1 on removing `renderLog`.)

### Exact file list to be created

- `src/analytics.ts` — build a report from `journal.jsonl`, then optionally join vendor transcripts using journaled `transcriptPath`/`sessionId`:
  - **phase count** + actions per phase (`gate-advanced` / `action-prepared`);
  - **time**: phase wall-clock (from `started` + `gate-advanced.at`), per-agent nudge→intent waits;
  - **tokens** / **tools**: per phase when a transcript join succeeds; clearly labeled by vendor;
  - text output by default (no `--json` requirement in Phase 1).
- `test/analytics.test.ts` — fixture journal (+ tiny fake transcript) covering phase/time always, tokens/tools when joined.
- `docs/analytics.md` — short contract: the four metrics, how to run `coord analytics`, which vendors can supply tokens/tools, explicit non-goals for Phase 1.

Keep `.plans/issue-89/discussion.md` as discussion only.

### Tests

1. `pnpm check:fast` before commits.
2. Coordinator acceptance: `pnpm check`.
3. Assert:
   - Journal projection includes identity/transcript fields when present.
   - Analytics without transcripts still prints accurate phase counts and times.
   - Analytics with a fixture transcript prints token and tool counts bucketed by phase.
   - Version > `origin/main`.

### Phase 1 explicitly out of scope

- `preparedAt` on `action.md`
- New journal types (`action-timing`, `token-usage`) — join at report time instead of duplicating usage into the journal
- `durationMs` on verify / final-check / gate (derive from existing `at`)
- `failureClass` on verify rejects
- Byte counts on `action.md` / bound inputs
- AGENTS.md trim, clerical collapse, ballot merge, context/retrieval
- Feature flags / A/B harness

## Phase 2 — Improvements based on metrics (not implemented in this plan’s code slice)

After Phase 1 ships, use `coord analytics` on real runs to pick and prove changes. Candidates from the discussions (owner shortlists later):

- Smaller protocol prefix (e.g. trim duplicated tracked `AGENTS.md`)
- Move clerical steps into the coordinator
- Combine review+ballot / compare+ballot
- Context files / maps to cut initial searches

Each Phase 2 change must name which of the four metrics it expects to move and by how much on a comparable issue profile.

## Alternatives Rejected

- **Full Claude §3 instrumentation set in Phase 1.** Issue asks for the metrics needed for Phase 2, simply — not a complete observability product.
- **Journal `token-usage` events.** Redundant if `transcriptPath` is journaled and analytics joins at report time.
- **Delivery-chain `action-timing`.** Useful for nudge debugging; not required to count phase time/tokens/tools/phases for Phase 2 decisions.
- **Require tokens/tools from all four agents.** Not available today; would over-engineer Phase 1.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Wall-clock transcript join still wrong without session id | Journal `sessionId` + `transcriptPath`; bucket by session, not only time window |
| Tool counts differ by vendor schema | Per-vendor parsers; document coverage in `docs/analytics.md` |
| Huge transcripts slow CLI | Bounded parse; journal-only path always works |

## Conclusion

Phase 1 is a thin metrics slice: journal enough identity to join transcripts, and one `coord analytics` command that reports **phase count, time, tokens, and tools**. Phase 2 is where efficiency work lives, chosen and validated from those numbers — matching the updated issue 89 text without overbuilding.

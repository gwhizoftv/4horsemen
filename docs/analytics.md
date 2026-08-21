# Coordination analytics — measurement contract (issue 89 Phase 1)

Issue **#89** Phase 1 ships `coord analytics --issue <n>` for four metrics only:
**time**, **token count**, **tool count**, and **phase count**. Keep this file as
the contract; do not invent additional report fields without a new plan.

## Four metrics (frozen)

- **Phase count** — named workflow gate intervals from `gate-advanced`, counting
  revision rounds and retries as distinct intervals. Actions per phase are
  reported separately, from `action-prepared`.
- **Time** — the run window is `started.at` through the terminal `gate-advanced`
  boundary; an in-progress run is labelled as such. Every interval is validated
  monotonic: if end precedes start the interval reports `invalid`, never a
  negative number. Per-agent waits are first `nudged` → `intent-seen`.
- **Token count** — components `input`, `output`, `cacheRead`, `cacheWrite`, plus
  `reasoning` where the vendor reports it. Taken from **per-turn values only**:
  Claude per-message `usage`, and Codex `last_token_usage` delta — **never**
  Codex `total_token_usage`. Records de-duplicate by vendor record id.
- **Tool count** — **invocation attempts only, never results.** Claude: content
  blocks where `type === "tool_use"`. Codex: `item_completed` tool items (not
  `custom_tool_call`, which lacks `turn_id`). Reported **per vendor**; never
  summed into a cross-roster total unless every active agent has `complete`
  coverage.
- **Coverage** — per agent: `complete`, `partial`, `unsupported`, or
  `unavailable`. Missing metrics report `null`, never `0`.

## Transcript join

The coordinator journal stores `sessionId` and `turnId` on `agent-lifecycle`
details (plus existing top-level `actionId`). Transcripts are resolved by vendor
locator under `~/.claude` / `~/.codex` (injectable in tests):

- Claude: `projects/<slug>/<sessionId>.jsonl` (`slug` from clone path with `/` → `-`)
- Codex: search `sessions/YYYY/MM/DD/*<sessionId>*.jsonl`

Attribution is by **turn identity** (Codex `turn_id`; Claude `promptId` via
`parentUuid` walk to a `user` record). Timestamp windows are a `partial`
fallback only. Unmatched records report as `unassigned`.

## CLI

```bash
coord analytics --issue <n> [--product <path> | --coord-root <path>]
```

Journal-only mode always prints phases and waits. Token/tool sections appear when
`sessionId` is present and a transcript can be joined.

## Deferred (not Phase 1)

Antigravity status-tick debounce; `--json` report schema; `preparedAt`;
`durationMs` journal fields; `action-timing`; action/input byte proxies;
`AGENTS.md` trim; clerical step collapse; ballot merges; context capsules;
path-confinement hardening beyond session locators.

---

# Historical baseline — issue-76 (acceptance oracle for phase/time)

Absolute values are a baseline to beat, not a stable average.

## Issue-76 phase durations (§2.1)

**64.50 min wall clock**:

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

## Issue-76 agent waits (§2.3)

| agent | actions | median | max | total waited |
| --- | ---: | ---: | ---: | ---: |
| cursor | 8 | 64.9 s | 589.6 s | 17.2 min |
| antigravity | 9 | 37.9 s | 725.6 s | 28.2 min |
| claude | 10 | 181.1 s | 991.6 s | 43.5 min |
| codex | 12 | 248.8 s | 1152.8 s | 55.5 min |

Acceptance (a): `coord analytics --issue 76` against the preserved issue-76
journal must reproduce the phase minutes above. Token/tool joins require a
journal that carries `sessionId` (fixture pipeline or post-ship run).

## Vendor stores

| agent | store | usage available? |
| --- | --- | --- |
| claude | `~/.claude/projects/<slug>/<sessionId>.jsonl` | Yes |
| codex | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` | Yes |
| cursor | local chat DB | No usable usage fields found |
| antigravity | — | No local store found |

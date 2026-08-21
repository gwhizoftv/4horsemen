# Issue 89 plan review

- Reviewer: Cursor (`issue-89/cursor`)
- Issue: https://github.com/gwhizoftv/coordination/issues/89
- Issue scope (authoritative): two phases, simple, no overbuilding —
  (1) accurate **time**, **token count**, **tool count**, **phase count**;
  (2) enhancements based on those metrics.
- Peer artifacts reviewed (origin tips):
  - Claude plan `613e3e8` — `.plans/issue-89/plan.md` (+ `docs/analytics.md`; no `discussion.md`)
  - Codex plan `4868a0d` — `.plans/issue-89/plan.md` + `.plans/issue-89/discussion.md`
  - Antigravity plan `9e7cc63` — `.plans/issue-89/plan.md` (no `discussion.md`; discussions cited were Cursor/Codex)

## Initially best

**Claude’s plan at `613e3e8` is the best starting point.**

It alone matches the updated issue: Phase 1 is only what makes the four named
metrics accurate; it does not pre-commit a Phase 2 workflow rewrite; it avoids
`runLoop` / action-format / journal-schema churn; it rejects byte proxies as a
substitute for tokens/tools; and it joins vendor transcripts at report time
instead of inventing a parallel usage journal.

Codex’s plan (and discussion) are strong on measurement discipline and a clear
Phase-2 scorecard, but Phase 1 **explicitly refuses** token and tool adapters and
measures action/input bytes instead — that does not satisfy the issue’s Phase 1
deliverables. Antigravity’s plan names the right Phase 1 metrics, then expands
Phase 1 with redundant `durationMs` / `action-timing` / `preparedAt` and folds a
large Phase 2 (context indexer, clerical automation, combined ballots, submit
helper, machine changes) into the same file map — that expands scope.

## Findings

### Finding 1 — Claude Phase 1 § debounce justification

**Plan claim:** Antigravity status-tick debounce is required in Phase 1 because
lifecycle noise “corrupts the phase and action counts Phase 1 exists to report.”

**Rule:** An item is in Phase 1 only if it is required for accurate time, token
count, tool count, or phase count (issue body; Claude’s own scope rule). Phase
count and time are derived from `gate-advanced` / `started` / `action-prepared` /
`nudged`→`intent-seen`, not from `agent-lifecycle` volume.

**Failure if followed as written:** Implementers treat debounce as mandatory
instrumentation for metric correctness, adding write-path complexity the issue
did not ask for, while the four metrics remain correct without it.

**Correction:** Drop debounce from Phase 1, or restate it as an optional
journal-hygiene note that is **not** required for the four metrics. Prefer drop
for maximum simplicity.

### Finding 2 — Claude `src/analytics.ts` / `src/transcriptRead.ts` phase join

**Plan claim:** Journaling `sessionId` + `transcriptPath` converts token/tool
attribution from a wall-clock guess into an exact join; the reader buckets
tokens and tools per phase per agent.

**Rule:** “Accurate” token and tool counts per phase must state the join key.
`sessionId` selects the right transcript; it does not by itself assign a
transcript turn to `R4.implement` versus `R5.compare`.

**Failure if followed as written:** Two implementers pick different joins
(session-only; wall-clock inside session; require `actionId` on lifecycle) and
Phase 2 before/after numbers are not comparable.

**Correction:** Specify one algorithm in the plan: after filtering by
`sessionId` (and path), bucket each transcript record into the open
`gate-advanced` interval using the record’s timestamp; document that residual
error if a session does non-issue work inside a gate window; do not claim
stronger exactness than that unless `actionId` is also journaled (out of scope
unless proven necessary).

### Finding 3 — Claude Tests / issue-76 acceptance

**Plan claim:** `coord analytics --issue 76` against the **existing** issue-76
journal must reproduce `docs/analytics.md` §2.1 and §2.3 before Phase 2 may rely
on its numbers.

**Rule:** Historical issue-76 journals lack `sessionId` / `transcriptPath`.
Token and tool sections cannot be validated on that journal alone.

**Failure if followed as written:** Reviewers treat “acceptance” as requiring
token/tool tables from issue-76 and block a correct Phase 1, or implementers
reintroduce wall-clock-only token joins to force a green check.

**Correction:** Split acceptance: (a) issue-76 journal → phase count, time, and
per-agent waits match §2.1 / §2.3; (b) fixture journal **with** identity fields +
fixture transcripts → token and tool tables; (c) one post-ship run before Phase 2
token/tool claims.

### Finding 4 — Claude Exact file list to be created / `docs/analytics.md`

**Plan claim:** Create `docs/analytics.md` by promoting an untracked prep file.

**Rule:** Exact create/change lists must match repository state at the plan tip.
On `origin/issue-89/claude` (`613e3e8`), `docs/analytics.md` is already tracked.

**Failure if followed as written:** Implementers open a duplicate path or skip
updating the already-committed contract.

**Correction:** Move `docs/analytics.md` to **Changed** (edit in place to match
the four-metric contract and deferred list), not Created.

### Finding 5 — Claude Phase 1 CLI `--json`

**Plan claim:** `coord analytics` includes `--json` for before/after comparison.

**Rule:** Issue Phase 1 asks for accurate metrics, simply. Human output plus a
stable text table is enough to meet scope; `--json` is convenience.

**Failure if followed as written:** Minor scope creep (schema bikeshedding)
before the four numbers exist.

**Correction:** Make `--json` optional follow-on, or keep it only if the plan
states a minimal fixed top-level shape in one short bullet (no versioned report
platform). Prefer defer for simplicity.

### Finding 6 — Codex plan Phase 1 (not selected, blocking if chosen)

**Plan claim:** Measure gate time, logical actions, action/input bytes; do not
add vendor token/tool adapters; treat turn removal as the structural
token/tool saving.

**Rule:** Issue Phase 1 requires accurate **token count** and **tool count**.

**Failure if followed as written:** Shipped “analytics” never reports tokens or
tools; Phase 2 cannot be judged on the metrics the issue names.

**Correction:** Do not use Codex as the Phase 1 base. Keep its coverage/`null`
discipline and “no fabricated usage” rule as amendments to Claude (already
partly adopted).

### Finding 7 — Antigravity plan file map (not selected, blocking if chosen)

**Plan claim:** One plan ships Phase 1 telemetry and Phase 2 clerical collapse,
combined ballots, context indexer, `coord submit`, scaffolds, and machine
changes (actions 37 → ~16).

**Rule:** Issue orders metrics first, improvements second, without overbuilding.
A plan’s Exact File Lists are the implementation allowlist.

**Failure if followed as written:** Implementers change workflow semantics before
the four metrics exist, with no separate measured baseline.

**Correction:** Do not use Antigravity as the base. If any Phase 2 idea is kept
later, it needs its own plan after Phase 1 reports.

### Finding 8 — Codex / Cursor discussions vs selected plan

**Discussion claim (Codex/Cursor):** Phase 2 should collapse clerical steps and
combine review+ballot / compare+ballot; context files may help searches.

**Rule:** Discussions are non-binding; the issue forbids expanding Phase 1 into
those designs.

**Failure if followed as written:** Selected plan gains Phase 2 file-map items
“because the discussion recommended them.”

**Correction:** Claude already defers them — keep that. Do not import Codex’s
pre-selected Phase 2 scorecard (bytes, `2N+3` actions) into Phase 1 acceptance.

## Changes required to accept Claude’s plan as complete and correct

Apply these edits to Claude’s plan (or an adopted copy) before treating it as
implementation-ready. No other peer plan should be the base.

1. **Keep** Phase 1 core: journal `sessionId` + `transcriptPath` on
   `agent-lifecycle`; `src/analytics.ts` reader; `src/transcriptRead.ts` for
   tokens **and** tool-call counts; `coord analytics --issue`; version bump;
   tests; no `runLoop` / `action` / journal-enum changes.
2. **Remove or demote** antigravity status debounce per Finding 1.
3. **Specify** the transcript→phase bucketing algorithm per Finding 2.
4. **Split** issue-76 vs fixture acceptance per Finding 3.
5. **Reclassify** `docs/analytics.md` as Changed per Finding 4.
6. **Defer** `--json` (or pin a one-line schema) per Finding 5.
7. **State definitions** once, matching the issue:
   - phase count = `gate-advanced` (and actions via `action-prepared`);
   - time = wall-clock from journal `at` (phases + nudge→intent waits);
   - token count = vendor usage fields when joinable;
   - tool count = tool-use **record counts** in the same transcript parse
     (per-vendor; never a fabricated cross-roster total; never `intent-seen`
     relabeled as tools).
8. **Keep** Phase 2 out of the Exact File Lists (already true) — AGENTS trim,
   clerical collapse, ballot merges, context capsules remain post-metrics.
9. **Adopt** Codex’s `null` + coverage discipline for missing vendor usage
   (Claude already includes this; do not drop it).
10. **Do not** add Codex byte instrumentation, Antigravity `durationMs` /
    `action-timing` / `preparedAt`, or any workflow machine changes to reach
    “complete.”

After those edits, Claude’s plan is complete and correct for issue 89 Phase 1
under simplicity and scope constraints.

## Conclusion

Initially best: **Claude `613e3e8`**. Reject Codex as Phase 1 base (no
tokens/tools). Reject Antigravity as base (Phase 1 extras + Phase 2 mega-map).
Accept Claude only after the ten corrections above — primarily: fix the debounce
rationale/scope, define the phase join, split acceptance, and keep the file map
strictly to the four metrics.

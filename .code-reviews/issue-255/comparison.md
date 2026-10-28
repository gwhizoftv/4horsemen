# Issue 255 implementation comparison

## Comparison

Reviewed the coordinator-exported source and tests at these exact implementation pins:

- Muse: `cb89b2d10600833586af4201dbb68adf53320142` (`worktrees/muse-cb89b2d1`).
- Claude: `5dbe2f46a3a15eb79689715c8e50894586e09d8f` (`worktrees/claude-5dbe2f46`).
- Codex: `166878e2904afb5a1c28164920bf04ed3948c4a3` (`worktrees/codex-166878e2`).

The worktree paths above are relative to the issue-255 runtime. All three retain
timestamped samples through aggregation, resolve the normal shared-turn case,
preserve measured usage on fallback, and separate token coverage from tool
coverage. Claude is the strongest starting point, but none of these pins is
ready to approve because the live-token path misses a supported bounded window.

### Findings

1. **[P2] All three — `src/analytics.ts:723` (Muse),
   `src/analytics.ts:735` (Claude), `src/analytics.ts:721` (Codex):** a live
   unkeyed token record must use the same proven shared-turn timestamp slice
   as its keyed equivalent when a later sibling prompt supplies the upper
   bound. Each implementation first requires a recorded stop in the unkeyed
   candidate filter, so an unstopped shared turn never reaches the new
   resolver. With R1/R2 prompts at 02s/12s, the same session/turn identity,
   and no stop event, a token record at 08s is unassigned even though the
   first action's slice is bounded by the prompt at 12s. Adding only the
   record's `turn_id` makes that record reach R1. In the focused probe,
   unkeyed records carrying 10 and 20 input tokens at 08s/15s left both phase
   buckets at zero and all 30 input tokens unassigned in every candidate;
   the corresponding keyed records reached buckets `[10, 20]`. The first
   record alone demonstrates the defect without requiring an open final
   action to be considered exact. Extend the existing shared-turn test with
   no stop and an unkeyed record before the next sibling prompt; require
   that record to reach R1 exactly while retaining conservative handling of
   unrelated identities and genuinely unbounded records.

2. **[P2] Muse — `src/analytics.ts:172`; Codex —
   `src/analytics.ts:170`:** a shared-turn record with a unique action and
   a known containing phase interval must not lose exact phase attribution
   solely because the final action lacks a stop event. These helpers reject
   every last unstopped action, including records inside a finite reported
   phase. In the probe, R2 begins at 10s, its action starts at 12s, and the
   terminal gate closes the phase at 30s. Keyed token/tool records at 15s
   have one bounded phase owner, yet Muse and Codex mark both metrics
   partial and suppress the roster token total. Claude uses the phase bound
   and reports complete coverage for the same keyed input. Test the record
   inside that phase together with one beyond its end: the former should
   resolve exactly, while the latter must remain non-exact. This is distinct
   from finding 1, which blocks even an earlier next-prompt-bounded slice.

3. **[P2] Muse — `src/analytics.ts:167`; Codex —
   `src/analytics.ts:173`:** ambiguity between action identities must not
   make the reported phase ambiguous when every eligible owner belongs to
   the same phase. With one R1 prompt at 02s, two R2 prompts tied at 12s,
   and a common stop at 22s, a keyed token/tool record at 15s can only belong
   to R2. Muse rejects tied starts and Codex requires exactly one action
   owner, so both produce partial token/tool coverage and a null roster
   token total. Claude checks the owners' phase indices and reports complete
   coverage with the same `[10, 20]` phase input counts and total 30. Add
   this same-phase tie assertion alongside the existing earlier-record /
   later-tie regression; ties spanning different phases must remain partial.

### Scope, reuse, and coverage

| Candidate | Scope and reuse | Focused coverage and remaining gap |
| --- | --- | --- |
| Muse | Uses the five approved product paths, existing aggregation/assignment helpers, and existing test files. Adds no product file or dependency. The local four-phase fixture helpers are specific to this regression. Its resolver also changes shared-turn behavior for other vendors; a Codex guard would keep the behavioral scope closer to this issue. | Covers the normal four-phase live-token/keyed-tool split and a late tool record. Does not cover the missing-stop live path or same-phase ties. |
| Claude | Uses the same five paths and existing test support, with no new product file or dependency. Reuses `phaseIndexAt` for a finite phase bound and compares phase indices for ties. Like Muse, its resolver is not restricted to Codex; narrowing that condition would avoid an unnecessary vendor behavior change. | Covers the four-phase split, residual late tools, later tied prompts, and an unstopped final action. The unstopped test uses keyed token records, so it misses finding 1. |
| Codex | Uses the same five paths, extends `sharedCodexJournal`, and adds no product file or dependency. Explicit Codex guards retain the prior attribution path for other vendors. | Covers four phases, a prompt-boundary sample, late tools, a missing timestamp, later tied prompts, and preservation of custom-tool uncertainty. It still rejects a uniquely determined phase in findings 2 and 3 and misses the unkeyed no-stop case. |

The five product paths are `src/transcriptRead.ts`, `src/analytics.ts`,
`test/transcriptRead.test.ts`, `test/analytics.test.ts`, and
`docs/analytics.md`. All candidates update the documentation's obsolete
always-partial shared-turn description. No unrelated product refactor is
needed to address the findings. The additional vendor scope in Muse and
Claude is a scope observation, not a separately demonstrated regression.

### Verification evidence

Read existing issue journal results rather than rerunning the product suites:

| Candidate submission | Recorded `pnpm run check:fast` | Recorded `pnpm run test:e2e` |
| --- | --- | --- |
| Muse | Journal sequence 168, exit 0 | Sequence 170, exit 0 |
| Claude | Sequence 202, exit 0 | Sequence 204, exit 0 |
| Codex | Sequence 209, exit 0 | Sequence 211, exit 0 |

These are explicitly labeled advisory hook observations in
`issue-255/journal.jsonl`, not coordinator-owned final verification. Muse's
later documentation-only submission recorded an explicit empty documentation
profile at sequences 196 and 198. Artifact acceptance at sequences 200, 206,
and 213 is not an additional product test pass.

For this review, ran a targeted Node probe against each bound checkout's
actual `buildAnalytics` code, transpiled into ignored scratch space. It used
the same journal and transcript inputs for all candidates and checked a
normal stopped case, unkeyed and keyed no-stop cases, and tied same-phase
prompts. The normal case was complete for all three; the failing cases are
reported above. Probe assertions passed and its observed results are retained
locally at `.codex/tmp/issue-255-review/results.json`. This probe investigates
the findings; it is not a substitute for the existing suites or final checks.

## Verdict

Prefer Claude's `5dbe2f46a3a15eb79689715c8e50894586e09d8f` as the revision
base because its helper already handles finite phase bounds and phase-unique
ties. Request revision before approval: make the live unkeyed path consult
eligible shared-turn slices without discarding next-prompt/phase-bounded
actions first, and add the focused no-stop live-token regression. Keep the
identity and timestamp ambiguity checks and partial fallback intact. Muse
and Codex additionally need findings 2 and 3 resolved if selected instead.

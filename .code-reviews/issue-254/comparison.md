# Issue 254 implementation comparison

Protocol version: 1. Reviewed the exact coordinator-bound product pins and their exported worktrees:

| Agent | Implementation pin |
| --- | --- |
| claude | `d754062d6cb5625d85192bb08f4ebc15ee30fc1d` |
| muse | `8146353438a00ba7a5bd380db682d8ddba88776e` |
| codex | `1a454ab38abbf96baa19960dfd8938d0530165e8` |
| antigravity | `e94da6c745f4664780e16639d79a3d4ea7089f03` |

## Comparison

No blocking findings or production correctness defects. All four implement the selected plan with the same behavior:

- `src/agentLifecycle.ts:567` retains containment on same-session exit and clears it only on a replacement session. Session correlation, retired-session rejection, tool cleanup, schemas, and the coverage evaluator remain intact.
- `src/issueReport.ts:94` (Claude: line 95) excludes completed issues from live agent uncertainty. The existing `needsAction` precedence remains, so unresolved issue-level obligations can still produce `[ACTION]`.
- `src/issueReport.ts:233` (Claude: line 235) passes no live binding for completed reports while still using `containmentCoverage` to validate recorded evidence. Unfinished reports retain the disk-binding comparison. Missing or uncorroborated historical evidence is not promoted to active coverage.

The complete lifecycle source file is byte-identical across the four pins. The complete report source files also match after removing Claude's two explanatory comments. Those comments explain why completed reporting ignores live readiness and later policy bytes; there is no behavioral divergence.

Each candidate changes the same four product/test files named in the selected plan: `src/agentLifecycle.ts`, `src/issueReport.ts`, `test/agentLifecycle.test.ts`, and `test/issueReport.test.ts`. The other coordinator-listed changed paths are planning/review/readiness evidence. No candidate adds product files, dependencies, schema fields, fixtures on disk, helpers, or unrelated refactors. All reuse the existing lifecycle test and the report's `start()`/`complete()` fixtures. Each adds one focused report case, including an actual `SessionEnd` transition, degraded completed health, and an unfinished-report control.

Test comparison:

| Candidate | Assessment |
| --- | --- |
| claude | Restores the known vendor version before both exit forms; preserves the existing replacement-session test. The report test covers the reviewed post-exit rendering requirement and resets health to healthy before the live binding control. The explanatory production comments are useful and within scope. |
| muse | Covers explicit and omitted exit IDs with full preservation and active-coverage assertions, plus replacement-session invalidation. The report test uses a later exit timestamp. Its live per-agent assertion checks binding invalidation, but the header assertion has the health confound described below. |
| codex | Covers both exit forms and tests replacement invalidation with a known-version probe. The report case restores healthy state before checking the live header and per-agent coverage. It follows the selected plan's existing in-memory fixtures, without the additional filesystem setup proposed in its earlier unselected plan. |
| antigravity | Tests a replacement session directly from the ended entry, explicitly covering exit followed by replacement. The omitted-ID exit checks preservation; the explicit-ID exit also checks active coverage. Its report assertions include both hook and shim values, with the same nonblocking live-header confound as Muse. |

One nonblocking coverage finding applies to two candidates:

- **[P3] `test/issueReport.test.ts:253` in Muse `8146353438a00ba7a5bd380db682d8ddba88776e`, and `test/issueReport.test.ts:256` in Antigravity `e94da6c745f4664780e16639d79a3d4ea7089f03`.** **Rule:** the unfinished-report control should establish that a healthy agent with a stale live binding makes the top-level report warn. **Concrete failure:** both tests leave the entry degraded from the preceding completed-health assertion, so `entry.health !== "healthy"` already makes the header `[WARN]`; removing only the top-level containment check would still satisfy these tests while a real healthy agent with stale policy could lose its header warning. The per-agent unverified assertion still protects the separate detail path, and the actual production code is correct. **Smallest test correction:** restore `health: "healthy"` before rendering the unfinished report, as Claude and Codex already do.

Existing verification evidence was read from `/Volumes/4TB-SOURCE/REPOS/4horsemen/coord-runtime/issue-254/journal.jsonl` and correlated with the accepted implementation records in `cursors.json`. Each precommit `index:` identity matches its bound product commit's tree; each prepush range ends at that candidate's accepted readiness submission:

| Candidate | `pnpm run check:fast` journal sequence | `pnpm run test:e2e` journal sequence | Recorded result |
| --- | --- | --- | --- |
| claude | 166 | 172 | Both exit 0 |
| muse | 164 | 173 | Both exit 0 |
| codex | 167 | 174 | Both exit 0 |
| antigravity | 165 | 179 | Both exit 0 |

These are recorded advisory hook observations, not coordinator final-suite results. In the earlier Codex implementation action, I also directly observed the focused tests fail before the fix and all 27 pass afterward, plus successful hook lint/typecheck, 865 fast tests, 268 system tests, and 2 e2e tests. No product suite was rerun for this comparison: there is no production finding requiring another run, and the test-isolation observation follows directly from the fixtures and short-circuit condition. Final coordinator checks remain separate.

## Verdict

All four pins are acceptable. Prefer Claude `d754062d6cb5625d85192bb08f4ebc15ee30fc1d` as the implementation basis: it combines the minimal shared fix, useful explanatory comments, and a healthy-agent live-binding control. Codex is equally correct with equivalent focused coverage. Muse and Antigravity need no production revision; their small test-isolation improvement is optional.

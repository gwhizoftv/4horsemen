# Issue 181 — implementation comparison

## Comparison

Reviewed the exact coordinator-exported worktrees for all four bound product
pins, using the action's changed-path lists rather than recomputing them:

| Agent | Bound implementation pin |
| --- | --- |
| Cursor | `8524928479df04db525ad9ea81bd0c989093d72e` |
| Codex | `c9708f8f091dd21e57240bbb1a15a9b3532aec12` |
| Antigravity | `88babdba642d1290e80089e30fbe881557613f6b` |
| Claude | `24fbca708b391f9322ab0435f4f9c40de3e8ed56` |

### Correctness

**No blocking implementation defect found in the inspected changes.** All four
now follow the selected narrow plan, not the broader lifecycle proposals in
some of the original plans:

- Their footer pattern recognizes the observed agents/shortcuts prefix while
  retaining the older shortcuts and context footer forms.
- Each recognizes an anchored, whole-line completed-turn duration with optional
  clock/rule decoration and skips at most one such line immediately after the
  latest sentinel.
- The skip is in `linesAfterCodexSentinel`, shared by `codexTail` and
  `codexNudgeSubmitted`, so it fixes both pre-send proof and post-submit
  acceptance. It is not an initial-readiness-only workaround.
- Owner drafts, unknown intervening lines, live-turn chrome, gate checks, and
  lifecycle/receipt revalidation retain their existing behavior. The source
  from `compactText` through the end of `src/tmux.ts` is identical across the
  four bound worktrees, including the send and fallback-submit logic.
- None changes `src/agentEvent.ts`, `src/agentLifecycle.ts`, or
  `src/runLoop.ts`. The unsafe omitted-`fullyIdle` default and incomplete
  unknown-lifecycle gate expansion identified during plan review were not
  implemented.

### Scope, reuse, and focused coverage

All four change the same three product paths: `src/tmux.ts`,
`test/tmux.test.ts`, and `docs/readiness-policy.md`. The remaining changed paths
listed by the coordinator are issue coordination evidence. No new product
files, dependencies, parser framework, or unrelated refactor was introduced.
All reuse `paneLines`, the existing composer/tail helpers, the ANSI composer
fixture, and the stateful parameterized nudge test. The latter exercises both
ready-file and sentinel proof, Vim Normal/Insert, owner edits between keys,
lifecycle races, and early `C-j` acceptance without an extra `C-m`.

**Codex — slightly preferred.** Its behavior matches Claude and Cursor, with
additional small assertions in the existing test at
`test/tmux.test.ts:759–795`: an ANSI-dimmed summary, the older ruled summary,
both footer forms with and without summaries, two summaries, arbitrary trailing
prose after a valid-looking duration, a newer transcript item, and an unknown
footer. These directly protect the boundaries being changed; they add no new
test harness or slow workflow scenario. Its policy paragraph also explains the
whole-line/single-summary rule and the shared submission check. The earlier
plan's larger run-loop regression was not added.

**Claude — also a strong choice.** It is the shortest test-file change and
includes the important arbitrary-prose negative case
(`test/tmux.test.ts:779–793`), legacy-footer coverage, and the shared stateful
delivery assertions. The summary-above-sentinel expectation raised in plan
review is correctly implemented as `idle-sentinel` at lines 784–785. Its
documentation explicitly distinguishes the file-backed path from sentinel
proof. It lacks some of Codex's additional near-miss assertions, but no
corresponding code defect was found.

**Cursor — acceptable.** It implements the same observed-character patterns and
single-summary skip as Claude/Codex, and includes the summary-above-sentinel
correction. It adds an optional footer argument and a second footer fixture to
the existing `codexPane` helper to exercise compatibility. This remains small,
justified test support. The missing-footer and lifecycle-expansion issues in
its original plan are resolved by following the selected plan.

**Antigravity — acceptable, but broader than necessary.** At
`src/tmux.ts:130–133`, both patterns accept either `·` or `•` in separator
positions; the other three use the exact observed characters. The rest of the
parser behavior is equivalent. Its tests cover the observed layout, legacy
footer, missing sentinel, dialog/prose vetoes, and both delivery sources, but
do not directly exercise the extra separator alternatives. This is a minor
scope/coverage distinction, not a demonstrated unsafe send or blocking bug.
The implementation drops the originally proposed lifecycle-default and
logging changes.

### Existing verification evidence

Read `coord-runtime/issue-181/journal.jsonl` and the accepted implementation
records in `cursors.json`. The product worktree tree IDs below match the
successful precommit `inputIdentity: index:<tree>` receipts. Each agent also
has an exit-0 pre-push `pnpm run test:e2e` receipt for the outgoing range ending
at its accepted implementation-signal submission.

| Agent | Product tree matched to precommit receipt | `pnpm run check:fast` successful receipt (UTC) | `pnpm run test:e2e` successful receipt (UTC) |
| --- | --- | --- | --- |
| Cursor | `f27e0db2b9d0e17ac8bcf4b6a1d1c5da8794ca6f` | 2026-10-08 22:16:23.743 | 2026-10-08 22:17:05.072 |
| Codex | `a7855d70a31916d6045f83a17d8e48c54baa2c58` | 2026-10-08 22:18:09.764 | 2026-10-08 22:18:52.955 |
| Antigravity | `973be48682eb818b6e7362fdb038be36e97d67d8` | 2026-10-08 22:18:44.337 | 2026-10-08 22:19:45.301 |
| Claude | `ed44807abfcc9f8f75960bb7956f208d93a36173` | 2026-10-08 22:20:57.575 | 2026-10-08 22:21:20.469 |

Claude also has an earlier exit-1 `check:fast` receipt at 22:16:27.035 for the
same tree, followed by the successful retry shown above. The receipt does not
establish the earlier failure's cause, so this review does not infer one.

These are existing hook observations, not coordinator final-check results or
new suite runs by this comparison action. During my preceding implementation
action, I directly observed the three pre-fix tmux failures, then 58 passing
tmux tests, 182 passing run-loop tests, successful lint/typecheck, and successful
mandatory hooks (681 fast, 181 system, and 2 e2e tests). No product suite was
rerun merely for this comparison; no new suspected defect required an
investigative test. Final acceptance still belongs to coordinator verification
at the approved pin.

### Recommendation

All four implementations are viable. Prefer **Codex
`c9708f8f091dd21e57240bbb1a15a9b3532aec12`** for its focused boundary coverage
without extra product scope; **Claude
`24fbca708b391f9322ab0435f4f9c40de3e8ed56`** is a close alternative with the
same narrow behavior. No implementation needs a correctness revision based on
this review.

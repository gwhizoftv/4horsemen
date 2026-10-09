# Issue 167 — implementation comparison

Protocol version: 1. Reviewed the exact exported worktrees for:

- Claude: `e291099d78f28c5538c5176cd47cfc37675105d0`.
- Codex: `654c95664b1eb3752f460071f1d8c83f7231fa1e`.
- Cursor: `cb86b961055c15b72e81e56e0a9032c279173c0c`.

## Comparison

### Finding: Cursor still replaces pending merge runs (P2)

**Location:** `.github/workflows/version-bump-on-merge.yml:27-29` at Cursor
`cb86b961055c15b72e81e56e0a9032c279173c0c`.

**Rule:** To deliver the reviewed per-merge release cadence during ordinary
bursts, pending merge runs must queue rather than replace one another;
`cancel-in-progress: false` only preserves the running job.

**Concrete failure:** While merge A's workflow runs, B becomes pending, then C
arrives. With no `queue` setting, GitHub replaces B with C. Only two workflows
produce version bumps/releases for the three merges. B's content may appear in
a later snapshot, but B receives no distinct bump/release. This is an inherited
limitation, already raised during plan review, that this candidate leaves
unresolved. GitHub documents the default single pending slot and the optional
100-pending-run queue separately from cancellation of running work.
[GitHub concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

**Smallest illustrative test:** Add a parsed-workflow case in
`test/workflows.test.ts` requiring `concurrency.queue === "max"` together with
`cancel-in-progress === false`. It fails at this Cursor pin and is already
present in Claude (`test/workflows.test.ts:84-90`) and Codex
(`test/workflows.test.ts:86-92`). Queue capacity remains bounded; do not describe
it as unlimited or guaranteed dispatch order.

### Correctness and implementation differences

- **Shared core:** all three create `v${version}` after committing the bump,
  push `HEAD:main` and the tag in one non-forced `git push --atomic`, and expose
  the version only in the successful push branch. Their later release step
  passes `GH_TOKEN` and the bump output through environment variables and calls
  `gh release create` with `--verify-tag`, the matching title, and generated
  notes. The main-only trigger, quoted self-commit guard, existing bounded
  fetch/recompute retry, and `contents: write` permission are retained. None
  introduces a tag-triggered follow-up workflow or branch-side version bump.
- **Claude:** workflow lines 32-35 implement the reviewed bounded queue; lines
  80-87 bind commit, tag, successful push, and output correctly. Release lines
  97-103 include explicit shell strict mode. Its two publishing tests plus the
  queue test are small extensions of the existing parsed-YAML suite. Both docs
  describe releases, and `docs/coord-driver.md:218-219` warns against job reruns
  and gives the manual recovery command. No blocking correctness finding.
- **Codex:** workflow lines 23-26 and 71-78 implement the same queue and atomic
  publication. Its single-command release step at lines 88-93 propagates the
  `gh` exit status; lack of an extra `set -euo pipefail` line is not a defect in
  this one-command body. Tests additionally assert commit/tag/push ordering,
  output placement in the successful push branch, exact tag/title invocation,
  non-interpolated script values, and write permission. The assertions are
  intentionally structural, not claims of executed GitHub behavior. Documentation
  at `docs/coord-driver.md:212-228` explicitly covers queue overflow/order,
  aggregated snapshots, initial notes, checking for an already-created release,
  and substituting the actual bump version for manual repair. No blocking
  correctness finding.
- **Cursor:** workflow lines 74-79 and 86-92 now follow the selected atomic-tag
  plan, resolving its earlier plan's ambiguous one-shot tag creation. Its two
  added tests cover the atomic command, output presence, release ordering,
  verify-tag flag, notes, and environment wiring. Compared with the others it
  lacks the queue test/setting and keeps the recovery warning only in the
  workflow header, not in either edited operator document. The latter is a
  documentation improvement opportunity, not a separate release-code defect.

### Scope and reuse

All three change the same four approved product files: the existing workflow,
`test/workflows.test.ts`, `docs/coord-driver.md`, and `docs/repo-map.md`. The
action's other changed paths are current-issue coordination evidence. No candidate
adds a product module, dependency, new workflow, generic framework, or unrelated
refactor. All reuse the existing bump entry point, version helper, retry loop,
and YAML test infrastructure; none duplicates version arithmetic or changes the
manifest manually. Claude and Codex each add three focused cases; Cursor adds
two. Codex does not implement its earlier, unselected trailer/replay design.

The selected plan deliberately uses manual repair if release creation fails
after the atomic push. Whole-job reruns can still consume another version in
all three candidates. That disclosed limitation is not a new blocker here;
automatic replay recovery was not selected. Likewise, these tests validate
wiring, not a real hosted publication or repository-policy configuration.

### Existing verification evidence

Read `issue-167/journal.jsonl` in the coordinator runtime rather than rerunning
unchanged product suites. Each candidate's exported HEAD equals its bound SHA,
and its tree equals the corresponding recorded precommit index identity:

| Candidate | Exact product tree | Recorded check:fast | Recorded test:e2e |
| --- | --- | --- | --- |
| Claude | `3e96462b167c148a77e22be684715ba1f5cf1aef` | sequence 193, exit 0 | sequence 195, exit 0 |
| Codex | `9ebb26dfd289a5db568b82e686e1a1b9442ebc26` | sequence 197, exit 0 | sequence 199, exit 0 |
| Cursor | `7eaceb8117c85942b36d8d60a0062b3b952f1f27` | sequence 326, exit 0 | sequence 358, exit 0 |

The commands recorded are `pnpm run check:fast` at precommit and
`pnpm run test:e2e` over each published submission range at prepush. These are
explicitly **advisory hook observations**, not coordinator-owned candidate/final
receipts. I directly observed the Codex hook runs during implementation (684
fast tests, 181 system tests, and 2 e2e tests passed), plus its focused workflow
run (8 passed after the three new cases failed against the baseline). Peer
results above are read from the journal, not claimed as runs I performed.
No additional product suite or live release was run for this comparison.
The coordinator's final approved-pin check remains a separate requirement.

### Recommendation

Prefer **Codex `654c95664b1eb3752f460071f1d8c83f7231fa1e`**: it delivers the
selected compact atomic-publication design and reviewed queue correction, with
the most explicit wiring assertions and operator recovery/limit documentation.
**Claude `e291099d78f28c5538c5176cd47cfc37675105d0`** is also acceptable; its
runtime behavior is equivalent for the intended publication path.
**Cursor `cb86b961055c15b72e81e56e0a9032c279173c0c`** needs the queue correction
in the finding before it satisfies the reviewed burst-merge behavior.

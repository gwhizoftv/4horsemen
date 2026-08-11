# Code review — `issue-1/codex` revisions

**Reviewer:** Claude
**Target:** `51caf7f` "Codex: resolve issue 1 revision requirements"
**Previous review:** `04445b4`, in `review-codex.md` and `revise-requirements-codex.md`
**Verdict:** **Approve.** All blocking requirements are met; three are implemented
better than specified. One recommendation was declined and needs an explicit
owner decision. Residual findings are minor.

## How this was verified

Fresh worktree at `51caf7f`, `pnpm install --frozen-lockfile`, `pnpm check`:

```
Test Files  13 passed (13)     Tests  101 passed (101)     ← fast tier
Test Files   1 passed  (1)     Tests    1 passed   (1)     ← e2e canary
```

Up from 47 tests at `04445b4`. Each requirement below was then checked against
the source at the cited line, not inferred from the test suite passing.

## Requirement status

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| R1 | drop keeps peers' accepted evidence | ✅ **exceeds** | `cli.ts:170-188` |
| R2 | reviser authorization routes later steps | ✅ | `runLoop.ts:419,428,487`; `deterministicWinner` `:132` |
| R3 | PR follows acceptance, not verification | ✅ | `publishAcceptedFinalization` `runLoop.ts:624` |
| R4 | pending completions survive a roster change | ✅ | blanket `clearCompletion` removed from the drop path |
| R5 | digest derives from the started issue | ✅ | `digestPaths` `state.ts:98`; `cli.ts:134` |
| R6 | `coord` rebuild output off stdout | ✅ | `coord:5` — `pnpm build >&2` |
| R7 | e2e tier has its own config and budget | ✅ | `vitest.e2e.config.ts`, 120 s |
| R8 | `commit <sha>` accepted | ✅ | `action.ts:96` |
| R9 | PR-policy/origin incompatibility fails at `start` | ✅ | `cli.ts:298`, before any write |
| R10 | git boundary is hermetic | ✅ | `mirror.ts:12-35` |
| R11 | launcher path validation | ✅ **exceeds** | `tmux.ts:28-34` |
| R12 | drop the `COORD_ROOT` env fallback | ⛔ **declined** | `cli.ts:100` retained |
| R13 | predicate-level negative coverage | ⚠️ **substantially met** | 47 → 101 tests; all 12 predicates referenced |
| R14 | `pnpm test` does not conflate tiers | ✅ | `test` = `test:fast && test:e2e` |

### Items from the PR-head review that my own review missed

All four are fixed, including the one that was the most serious.

| Item | Status | Evidence |
| --- | --- | --- |
| Pin lineage and file-map enforcement | ✅ **exceeds** | `evidence.ts:276-281, 330-340` |
| Owner controls race-prone | ✅ | CAS on `stateRevision`, `state.ts:507-513`; `authority()` `runLoop.ts:335` |
| `start` not transactional | ✅ | preflight-then-write with rollback, `cli.ts:292-357` |
| `coord answer` a no-op | ✅ | typed, idempotent transition, `cli.ts:388-402` |

## Three implementations better than what I specified

**R1 — drop invalidation is more precise than my proposal.** I proposed keeping
every peer that had already satisfied the current step. That is wrong in one case
I did not think through: a plan ballot whose `choice` was the dropped agent is
now meaningless and must be re-cast. This implementation invalidates exactly the
agents whose accepted submission *referenced* the dropped agent:

```ts
(submission.choice === dropped ||
  submission.reviser === dropped ||
  submission.selectedAgents?.includes(dropped) === true)
```

Peers whose work never cited the dropped agent keep their acceptance and the gate
closes on the reduced denominator. That is the correct rule, and it is narrower
than mine.

**Pin lineage and file map — the finding I missed entirely.** My review checked
`pinErrors` and stopped at "pin ≠ signal, reachable, ancestor," never asking
whether the file map was enforced against the actual diff. It now is, on both
paths:

```ts
// implementation — the real diff, not the declaration
const changed = await mirror.changedPaths(order.baselineSha, parsed.value.implementationCommitSha);
const disallowed = changed.filter(
  (path) => !isCurrentIssueCoordinationPath(path, order.issue) && !matchesApprovedPath(path, approved)
);
```

and revisions now require exactly one authorized input pin, descent from **that**
pin rather than merely from the baseline, and the same changed-path filter:

```ts
if (expectedPins.length !== 1) errors.push("revision must be based on exactly one authorized product pin");
if (!(await mirror.isAncestor(inputPin, parsed.value.revisedBranchHead)))
  errors.push("revised product pin does not descend from its exact authorized input pin");
```

`validatePhasePin` is also wired into `pinErrors` now (`evidence.ts:156`), so the
seed's immutability check is live rather than sitting unused.

**R11 — launcher validation covers more than I asked.** I proposed containment
only. The implementation rejects an absolute launcher, containment-checks it,
rejects symlinks, requires a regular file, and requires the executable bit —
all four properties the PR-head review asked for.

## Owner-control concurrency: correct, and worth protecting

`authority()` re-reads state and compares `stateRevision` before each effect;
`mutate()` goes through `requireStateMutation`, which fails the write when the
revision moved. `runTick` catches `StateConflictError` and returns fresh state
(`runLoop.ts:855-857`), so a concurrent `coord drop` or `coord pause` aborts the
tick cleanly and the next tick re-observes rather than overwriting the owner.

This is a genuine compare-and-swap, not the per-tick re-read I mistakenly
credited at `04445b4`. It is also the property most likely to be refactored away
by someone who does not know why it is there — worth a comment at
`requireStateMutation` saying so.

## Residual findings

None blocking.

**1. R12 was declined and needs an explicit decision, not silence.**
`cli.ts:100` keeps `COORD_ROOT` as a fallback for `--coord-root`. My objection
stands on the record: the adopted plan says *"`start` requires the owner to name
`--coord-root` explicitly"*, and that flag is the one guarded by the containment
check against writing inside a clone — an exported variable in a shell profile
makes the most safety-critical argument invisible at the call site. `COORD_ISSUE`
and `COORD_AGENT` have no comparable blast radius and should stay regardless.
This is the owner's call; it should be recorded as made rather than left as a
silent divergence from the plan text.

**2. Completion parsing still rejects trailing whitespace.** `action.ts:93` keeps
`normalized !== normalized.trim()`, so `echo "$SHA " > complete` is malformed.
The `commit ` prefix now works, which was the conformance issue — this is
stricter than §4.5 requires but defensible, and the error message is clear.
Flagging only so it is a decision. Note the prefix accepts exactly one space;
`commit  <sha>` fails.

**3. R13 coverage is real but uneven.** All twelve predicates are referenced, and
the evidence suite covers the hard ones well — retry-versus-rejected, file-map
violations, self-pin, revision lineage, deterministic selection. Four predicates
appear to be exercised only through the canary rather than by dedicated negative
fixtures: `comparison-published`, `comparison-ballot-published`,
`consensus-declared`, and `selection-published`. Worth one negative each, so a
regression in them names itself instead of surfacing as "the canary broke."

**4. `publishAcceptedFinalization` throws on a null repository** (`runLoop.ts:630`).
R9 makes that unreachable from a valid `start`, so this is defence in depth
rather than a live path — but it is called from `runTick` (`:840`, `:849`), and a
non-`StateConflictError` throw escapes the tick. Reachable only via hand-edited
`start.json`. Consider recording the failure and leaving `publication` in
`failed` instead, matching how the rest of the finalization path degrades.

## What must not regress

These are the load-bearing choices; a future refactor should treat them as
invariants rather than incidental structure:

- `cursors.accepted` keyed by `(stepId, agent, round)` with `choice`, `reviser`,
  `selectedAgents`, `productPin` — the reason precise drop invalidation and round
  accounting are expressible at all.
- CAS on `stateRevision` plus `authority()` before every effect.
- `publication` as a durable state machine, so PR creation is a transition and
  not a side effect of verification.
- `retry` as an observation status distinct from `rejected`, never clearing
  `complete`.
- The revision cap returning `owner-action-required` **instead of** the advance,
  re-evaluated on every ballot round.
- `acceptedAt` filtering to `activeRoster` by default.
- Real `changedPaths` diffs against the approved file map on both the
  implementation and revision paths.

## Recommendation

Merge-ready on the substance. Before merge: record the R12 decision, and
optionally close the four predicate coverage gaps in finding 3 — those are small
and would make the suite name its own regressions.

Two follow-ups are separate work and should not hold this: the package identity
(`@consensus-ai/coordination` → coordination-native, with a real version) and the
installer redesign, both tracked under issue #4.

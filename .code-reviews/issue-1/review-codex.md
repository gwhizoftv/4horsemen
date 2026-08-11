# Code review — `issue-1/codex`

**Reviewer:** Claude
**Target:** `04445b4` "Codex: implement coordination workflow driver"
**Baseline:** `14d052a` (`main`)
**Authority:** `.plans/issue-1/plan.md` @ `a485bb7`, `.plans/issue-1/workflow-algorithm.md` @ `9f918cd`

## Verdict

**Approve with changes.** Every required behaviour I checked is implemented, and
the hard ones — transient-vs-absent classification, the revision cap, action
confidentiality, R7 check-gating — are implemented correctly rather than
approximately. The gaps are one spec deviation in the completion parser, thin
unit-level negative coverage, and an unflagged remote write during finalization.

`pnpm check` passes: 46 fast tests + a 370-line four-agent canary.

---

## What is right

These are the invariants most likely to be got wrong, and this branch gets them
right. Listing them because they should survive revision.

**Action confidentiality is enforced, not just intended.** `createActionId()` is
`randomUUID()` (`src/action.ts:18`) — genuinely opaque. `renderAction` validates
the id against a UUID pattern before writing, and `parseAction`
(`src/action.ts:63-76`) *rejects* any front-matter key outside
`actionId | agent | requiredPath`, and rejects duplicates. The parser enforces
the invariant rather than documenting it.

**Transient failures are a distinct observation status.** `evidence.ts:155-163`
returns `status: "retry"` when a fetch fails transiently, and `machine.ts:69-70`
maps that to `retry-verification`, which in `runLoop.ts:499-500` updates the
cursor **without** clearing `complete`. Compare `accept` (`:332`) and `reissue`
(`:378`), which both clear it. An origin outage cannot become a
missing-artifact verdict, and the submitted SHA survives it.

**The revision cap actually caps.** `machine.ts:108-118`:

```ts
if (ballots.some((ballot) => ballot.disposition === "revise")) {
  if ((round ?? 1) >= start.maxRevisionRounds) {
    return [{ type: "owner-action-required", reason: `revision limit … round ${start.maxRevisionRounds + 1} is forbidden` }];
  }
  return [{ type: "advance-step", from: current, to: "R6.revise", round: (round ?? 1) + 1 }];
}
```

It *returns* the owner-action decision instead of the advance, and it is
evaluated when a ballot round closes — so it fires on every round, not only on
entry to the gate. `escalate` is handled separately.

**`machine.ts` is pure and honours owner control.** Imports are `state.js` types
and `steps.js` only. `decide()` short-circuits on `abandoned`, `completed`, and
`paused` (`:60-62`), and `runLoop.ts:601` checks the same flags — the rule lives
in both layers.

**Drop semantics are correct.** `acceptedAt` filters to `activeRoster` by default
(`runLoop.ts:112`), so a dropped agent's accepted work stops appearing in every
derived input set — which is exactly the plan's "no announcement, the reduced
input set communicates it". `cli.ts:235` refuses to drop the final active agent;
`:239-240` clears the pending completion and removes the action. `machine.ts:35`
degrades to the solo profile at one remaining agent.

**R7 gates PR creation on the checks.** `runLoop.ts:437-490` runs
`verifyFinalization` first, materializes a worktree, runs each configured argv in
order, and **returns a rejection before reaching the PR block** on the first
non-zero exit. The `finally` removes the worktree. Argv elements are mapped
individually, never assembled into a shell string.

**Pins are checked properly.** `evidence.ts:141-144` requires
`pin !== submissionSha`, reachability from the expected ref, and
`isAncestor(pin, submissionSha)` — product before signal, on the right branch.

**Paths are contained by construction.** `containedPath` (`paths.ts:40`) wraps
every derived path, `agentPattern` (`:138`) restricts ids to safe segments, and
`:92` refuses a coord root that overlaps a configured clone.

**Atomic writes with fsync** in both `action.ts:123` and `state.ts:248`.

---

## Findings

### 1. The completion parser rejects the `commit <sha>` form the design allows

**Significant — interoperability.**

`src/action.ts:88-99`

```ts
const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
if (normalized.includes("\n") || normalized.includes("\r") || normalized !== normalized.trim()) {
  return { status: "malformed", message: "complete must contain exactly one unpadded line" };
}
const parsed = gitShaSchema.safeParse(normalized);
```

The accepted design, §2.3 and §4.5, is explicit:

> Contents of `complete`: a single line, 40-hex git SHA (**optional `commit `
> prefix**). No JSON. No empty file.

```
commit 4ab89257…
```

is a documented valid submission and this parser rejects it as malformed. The
rendered action tells the agent to write the bare SHA, so a run driven purely by
this implementation is self-consistent — but an agent working from the design
document, or a `complete` file written by another implementation, is rejected for
a reason the protocol says is legal.

The `normalized !== normalized.trim()` guard also rejects a trailing space, which
`echo` and editors add readily.

**Fix:** strip an optional case-insensitive `commit\s+` prefix and trim
surrounding whitespace before validating, matching §4.5. Add both accepted forms
plus the trailing-space case to `action.test.ts`.

### 2. Unit-level negative coverage is thin

**Significant.**

47 tests total. Per file:

| File | Tests | Plan asks for |
| --- | --- | --- |
| `evidence.test.ts` | 5 | "positive **and negative** fixtures for **every** predicate" |
| `action.test.ts` | 3 | "**every** malformed `complete` form" |
| `state.test.ts` | 3 | schema strictness, atomic writes, journal recovery, pause/resume, dropped agents |
| `cli.test.ts` | 3 | "**every** public command, stable exit codes…" |
| `mirror.test.ts` | 3 | external-root refusal, wrong-branch SHAs, ancestry, transient vs absence |
| `pinValidation.test.ts` | 3 | adapted from the legacy pin tests |

The integration canary is genuinely good and covers the happy path plus a drop, a
rejection, a revision, and finalization. But it is one test: when it fails it
says "the workflow broke", not which predicate regressed. There are roughly ten
evidence predicates and five tests covering them.

This is the finding most likely to matter later — the branch is *correct* today,
and the suite would not tell you when it stops being.

**Fix:** at minimum one negative fixture per evidence predicate (wrong path,
malformed document, stale session, wrong pin, wrong round, signal-as-pin), and
the malformed-`complete` table from finding 1.

### 3. Finalization pushes a branch to origin, and fails late on a non-GitHub origin

**Moderate — authority and failure timing.**

`runLoop.ts:475-476`

```ts
const finalBranch = `${order.branch}-final`;
await this.mirror.publishBranch(observation.productPin, finalBranch);
```

The coordinator creates a **new remote branch** on origin during finalization.
Opening a PR needs a head ref, so this is defensible — but the plan enumerates
coordinator capabilities carefully ("PR creation and merge as separate
capabilities") and never mentions creating remote branches. It deserves an
explicit owner decision and a line in `docs/coord-driver.md`, because it is the
only origin *write* the driver performs.

Immediately above, `:473-474`:

```ts
const repository = githubRepositoryFromOrigin(start.origin);
if (repository === null) throw new Error(`Cannot derive a GitHub repository from origin ${start.origin}.`);
```

`githubRepositoryFromOrigin` (`:78-83`) matches only
`https://github.com/owner/repo` and `git@github.com:owner/repo`. Any other origin
— a file path, a self-hosted host, a URL with a trailing slash — throws **after**
verification and all configured checks have already run and passed. A run reaches
the very end of a successful workflow and dies on a configuration fact that was
knowable at `coord start`.

**Fix:** validate at `start` that `prPolicy: "coord-open-unmerged"` is paired
with an origin the opener can handle, and fail there. At finalization, prefer
recording the failure and leaving the verified state intact over throwing.

### 4. `decide()` returns after observation decisions

**Minor — observation, not a defect.**

`machine.ts:85`: `if (decisions.length > 0) return decisions;`

When any submission is observed, the tick applies only the accept/reject/retry
decisions; ordering and gate advancement wait for the next tick. That is a
legitimate one-thing-per-tick design and it keeps the reducer easy to reason
about. The cost is one poll interval of latency per accepted submission, which at
four agents and a multi-step gate adds up across a run. Worth a comment saying it
is deliberate, so a future reader does not "fix" it into a convergence loop.

### 5. `{worktree}` is the only placeholder

**Minor.**

`runLoop.ts:452` expands `{worktree}` and nothing else. The adopted plan's
finalization text mentions argv "such as `pnpm install --frozen-lockfile` and
`pnpm check`", which this covers. But `{baselineSha}` / `{finalSha}` are the
natural next request and the substitution is already per-element and shell-free.
Cheap to generalise now; harder once configs exist in the wild.

---

## Comparison note

Against `issue-1/cursor`: this branch is substantially more complete on required
behaviours (that branch has five unmet, four of them silent), and less complete
on unit-test breadth (134 tests there against 47 here, though several of that
branch's suites test code the driver never calls). The two failure modes are not
symmetric — missing behaviour ships broken, missing tests ship fragile.

---

## Suggested order of work

1. Finding 1 — small, and it is a protocol conformance bug rather than a
   preference.
2. Finding 3 — move the origin/PR-policy compatibility check to `start`.
3. Finding 2 — predicate-level negative fixtures; the largest amount of work and
   the one that protects everything already correct.
4. Findings 4 and 5 — comments and a small generalisation.

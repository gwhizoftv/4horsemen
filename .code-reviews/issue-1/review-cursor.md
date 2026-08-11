# Code review — `issue-1/cursor`

**Reviewer:** Claude
**Target:** `184f5b6` "Cursor: implement coordination driver (issue-1 full plan)"
**Baseline:** `14d052a` (`main`)
**Authority:** `.plans/issue-1/plan.md` @ `a485bb7`, `.plans/issue-1/workflow-algorithm.md` @ `9f918cd`

## Verdict

**Requires revision.** The module decomposition matches the adopted file map, the
reducer is genuinely pure, and several evidence predicates are correct. But five
of the thirteen required behaviours are not met, four of them silently: an agent
can read its `stepId` out of `action.md`, multi-step gates advance after their
first step, `coord pause` does not pause, R7 is absent, and the revision cap
never fires.

`pnpm check` passes on the branch — 128 fast tests + 6 e2e. The defects below are
not caught by that suite.

---

## Blocking

### 1. `action.md` and `coord next` leak the step id

`src/action.ts:19-21`

```ts
/** Generate an opaque action ID. Does not encode step/gate/phase. */
export function generateActionId(issue: number, agent: string, stepId: StepId, attempt: number): string {
  return `issue-${issue}:${agent}:${stepId}:${attempt}`;
}
```

The comment states the invariant; the body violates it. That value is rendered
into front matter (`src/action.ts:27`) and printed by `coord next`
(`src/cli.ts:200`), so an agent reads:

```
actionId: issue-1:claude:R3.plan-ballot:2
```

Required behavior 2 is explicit: *"Every order writes an `action.md` containing
an opaque coordinator-generated `actionId` … The opaque ID does not encode a
step, gate, or phase. `stepId`, `gateId`, phase, evidence ID, denominators, and
global cursor state stay in `cursors.json`/the journal and are never rendered by
`action.md` or `coord next`."*

The attempt count leaks with it, which also tells the agent how the coordinator
is scoring it.

**Fix:** make the id a digest or UUID. A digest over
`(issueSessionId, agent, stepId, attempt)` stays deterministic for crash
recovery while revealing nothing.

### 2. Multi-step gates advance after their first step

`src/machine.ts:63-66`

```ts
const agentComplete = steps.every(step => {
  if (!needsAgentAction(step.stepId)) return true;
  return cursor.status === "complete" || observations.some(o => o.ok && o.agent === agent && o.stepId === step.stepId);
});
```

`cursor.status` is a single field set to `"complete"` on *any* accepted
submission (`src/runLoop.ts:118`). Because the `every` short-circuits on that
status, one accepted step marks **every** step of the gate satisfied for that
agent.

Three gates have more than one agent-facing step (`src/steps.ts:55-66`):

| Gate | Steps | Ordered in practice |
| --- | --- | --- |
| `gate-3-ballots` | `R3.review`, `R3.plan-ballot` | review only |
| `gate-5-compare` | `R5.compare`, `R5.compare-ballot` | compare only |
| `gate-6-consensus` | `R6.revise`, `R6.ballot` | revise only |

It compounds: `prepare-action` is emitted only inside the gate-advance branch
(`src/machine.ts:38-44`), so the second step of a gate is never ordered at all.
A four-agent consensus run therefore never collects plan ballots, comparison
ballots, or consensus ballots — the artifacts the profile exists to produce.

**Fix:** record satisfaction per `(agent, stepId)` rather than a single status,
and order the next unsatisfied step within the current gate instead of only on
gate transitions.

### 3. `coord pause` does not pause

`src/runLoop.ts:217-225` sets `cursors.paused = true` and journals it.
`runTick` (`src/runLoop.ts:18-84`) never reads that flag, and `runLoop`
(`186-192`) loops on the abort signal alone. After `coord pause` the coordinator
keeps polling, verifying submissions, clearing `complete`, advancing gates, and
writing new actions.

Required behavior 8: *"`coord pause` journals a durable pause and allows the
coordinator to shut down without deleting actions, cursors, mirror state, or
tmux sessions."*

`decide()` also never reads it, so the invariant is absent from both layers.

**Fix:** return early from `runTick` when `cursors.paused`, and assert it in
`decide()` so the pure layer carries the rule too.

### 4. R7 finalization is not implemented

`verifyFinalization` is defined in the seed (`src/finalization.ts:66`) and
**imported nowhere**. The `finalize` decision type exists (`src/steps.ts:112`)
but `decide()` never emits it, and its handler only writes a journal line:

```ts
case "finalize": {
  appendJournal(coordRoot, issue, { …, event: "finalization-started", approvedSha: d.approvedSha });
  break;
}
```

Nothing verifies cleanup-only ancestry, materializes a verification worktree,
runs the configured `finalChecks` argv, or gates PR creation on their exit
codes. Required behavior 13 and the plan's "failed verifier or check blocks PR
creation" are unimplemented.

`test/finalization.test.ts` (12 tests) exercises the seed function directly, so
the suite is green while the driver never calls it.

### 5. The revision cap never fires

`src/machine.ts:47-49`

```ts
if (nextGate === "gate-6-consensus" && currentRound !== null && currentRound >= MAX_REVISION_ROUNDS) {
  decisions.push({ type: "notify-owner", message: `… Owner action required.` });
}
```

Two problems:

1. It only **notifies**. The `advance-gate` and `prepare-action` decisions were
   already pushed at lines 34-44, so the driver proceeds regardless. Required
   behavior 12 says it *"never enters round 4"* — this enters it and mentions
   it in the journal.
2. The guard is unreachable after the first entry. Revision rounds loop *within*
   `gate-6-consensus`, and `nextGateAfter("gate-6-consensus")` is
   `gate-7-finalized`, so `nextGate === "gate-6-consensus"` is true only on the
   single transition from gate 5. On rounds 2, 3, 4… it never evaluates.

Also, `cursors.issueCursor.round` is never incremented anywhere in the branch, so
`currentRound` stays `null` and the condition short-circuits immediately.

**Fix:** return an owner-action decision *instead of* the advance, evaluate it
when a consensus ballot round closes with a `revise` disposition, and actually
maintain the round counter.

---

## Significant

### 6. Bound inputs are stale or empty

`src/runLoop.ts:90-95`

```ts
for (const a of activeAgents) {
  if (a === agent) continue;
  const c = cursors.agents[a];
  if (c?.submissionSha) inputCommits[a] = c.submissionSha;
}
```

Peers' contributions are read from a single `submissionSha` field that is
overwritten on every accepted step (`:119`) and reset to `null` by
`prepare-action` (`:153`). Since `decide()` emits `prepare-action` for **all**
active agents on a gate advance and `applyDecisions` processes them in list
order, by the time a later agent's action is built the earlier agents' shas have
already been nulled.

Consequences: an action either cites no inputs at all, or cites whatever an agent
last submitted for a *different* step — a plan ballot can end up citing review
commits. Required behavior 2 wants "exact input commits needed for that task",
and the evidence layer's citation checks depend on them being right.

**Fix:** persist accepted submissions per `(agent, stepId, round)` and derive
inputs from that record.

### 7. An absent branch is misclassified as a transient outage

`src/mirror.ts:31-34` throws `MirrorFetchError` on **any** non-zero `git fetch`
exit, and `src/runLoop.ts:32-40` treats every `MirrorFetchError` as transient:
journal and `continue`.

`fatal: couldn't find remote ref refs/heads/issue-1/claude` is not an outage — it
is evidence that the agent never pushed. Under this code that agent's submission
is silently skipped on every tick, forever: no verdict, no `outstanding[]`, no
reissued action telling it what is wrong. This is the exact inverse of the risk
the plan calls out, and it is just as invisible.

Relatedly, the refspec has no `+` (`src/mirror.ts:39`), so after any force-push
the fetch fails non-fast-forward and wedges permanently in the same "transient"
state.

**Fix:** classify stderr — transport failures are transient, a missing ref is
`outstanding: ["origin has no branch … yet"]`, and use a forced refspec into a
coordinator-owned ref namespace.

### 8. Path confinement is incomplete

`src/paths.ts:24-26`

```ts
for (const agentRoot of agentRoots) {
  if (!existsSync(agentRoot)) continue;
```

Containment is **skipped** for any clone that does not exist yet — a fresh
workspace is exactly when a mistyped `--coord-root` is likeliest, and it fails
open. Resolve the configured path and compare it whether or not it exists.

`agentDir` (`:47-49`) interpolates `agent` into the path with no validation and
no containment assertion, so a roster entry of `../../etc` escapes the control
root. There is no agent-id pattern anywhere in `paths.ts` or `state.ts`. The plan
requires *"containment-check every derived path"*.

Overlap is only checked in one direction; a control root that *contains* a clone
is accepted.

### 9. The canary does not cover the required scope

`test/integration.test.ts` has 6 tests: start state, an empty tick, one join, a
drop, a post-drop completion, and journalling. The plan requires the canary to
cover *"start, action delivery, exact-SHA completion, dropping one unavailable
agent, action inputs that omit it, gate advancement, one revision, consensus
declaration, and finalization without a merge."*

Gate advancement past join, the revision round, consensus, and finalization are
all untested — which is why findings 2, 4 and 5 pass CI.

---

## Minor

- **`writeAction` is not atomic** (`src/action.ts:88`, plain `writeFileSync`),
  while `state.ts:72` correctly uses write-and-rename. An agent polling
  `action.md` can read a torn file.
- **`coord next` prints only the id and path** (`src/cli.ts:200`), not the task
  body or the completion path. The design says it prints the action body; as
  written an agent pulling its action cannot see what to do or where to report.
- **Launcher check is existence-only** (`src/tmux.ts:51`), then the pane runs
  `bash <launcher>` (`:54`). A present-but-non-executable launcher still runs and
  the shebang is ignored. The plan wants missing *or non-executable* to be a
  named startup failure.
- **`--coord-root` may come from the environment** (`requireFlagOrEnv`), which
  weakens *"`start` requires the owner to name `--coord-root` explicitly."*
- **`vitest.config.ts` `exclude` replaces vitest's defaults**, dropping the
  built-in `node_modules`/`dist` exclusions. Harmless given the `include` glob,
  but easy to make additive.

---

## What is right

Worth keeping as-is:

- **`machine.ts` is genuinely pure** — imports only `steps.js` and `state.js`
  types, with no path to Git. The architectural correction from the plan review
  landed.
- **Transient outages preserve `complete`.** `runTick` journals and `continue`s
  without clearing the completion file — the handling is right even though the
  classification feeding it (finding 7) is not.
- **Submission reachability is proven from the agent's own branch** before any
  blob is read (`src/evidence.ts:31-32`).
- **`pin !== submissionSha` is checked** for both implementation and revision
  signals (`src/evidence.ts:130,158`) — the signal-commit separation the design
  calls for.
- **No merge capability** anywhere in `src/`.
- **Strong unit coverage where it exists**: `pinValidation` 25 tests, `protocol`
  16, `mirror` 14. `finalization.test.ts` is thorough even though the driver
  never calls the function.
- **Nudge policy is documented Claude-only**, with non-Claude harnesses
  pull-only.

---

## Suggested order of work

1. Findings 2 and 6 together — both come from `cursors` carrying one status and
   one sha per agent instead of a per-step record. Fixing the state shape fixes
   both.
2. Finding 1 — a one-line change to `generateActionId` plus a test asserting no
   `StepId` string appears in `action.md` or `coord next` output.
3. Finding 3 — early return in `runTick`, assertion in `decide()`.
4. Finding 5 — round counter plus an owner-action decision that replaces the
   advance.
5. Finding 4 — R7, then extend the canary (finding 9) so 2/4/5 cannot regress.
6. Findings 7 and 8.

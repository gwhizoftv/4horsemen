# Revise requirements — accept `issue-1/codex` as trunk

**Purpose.** Gate document for adopting Codex’s implementation (`04445b4`) as the
coordination-driver baseline. It consolidates peer reviews and states the
**must-fix before acceptance** set, with enough explanation and proposed code
shape that an implementer can land the work without rediscovering intent.

**Sources**

| Reviewer | Artifact |
| --- | --- |
| Cursor | `.code-reviews/issue-1/review-codex.md` @ `e097be7` |
| Claude | `origin/issue-1/claude:.code-reviews/issue-1/review-codex.md` |
| Antigravity | `origin/issue-1/antigravity:.code-reviews/issue-1/review-codex.md` (+ summary) |

**Authority.** `.plans/issue-1/plan.md`, `.plans/issue-1/workflow-algorithm.md`.

**Verdict on the base.** Codex remains the preferred trunk: pure `machine.ts`,
opaque UUID actions, required external `--coord-root`, reachability-checked
evidence, working revision cap, R7 cleanup verification that blocks PR on failed
checks, and a real four-agent canary. Acceptance is blocked until the
requirements below are landed and covered by tests.

---

## Acceptance rule

Do **not** merge or rebase other agents onto Codex until every item in
**Must-fix (blocking)** is:

1. implemented on `issue-1/codex` (or a follow-on branch cut from it),
2. covered by at least one focused regression test named in that item, and
3. green under `pnpm check` (fast + e2e).

**Should-fix** items are required before calling the driver “operator-ready,”
but may ship in the same PR or the immediate follow-up. **Nice-to-have** items
do not block acceptance.

---

## Must-fix (blocking)

### R1. Drop must not wipe peer acceptances at the current gate

**Why.** Plan drop semantics: `coord drop A` is one local state change that
continues without A. Completed historical gates are not recomputed. For an
*unresolved* gate, peer work that already passed evidence must remain eligible
so the reduced denominator can finish. Codex’s CLI path violates that.

**Current behavior.** `cmd drop` calls `dropAgent`, then
`resetUnresolvedActions` (`src/cli.ts`):

```ts
accepted: cursors.accepted.filter(
  (submission) => submission.stepId !== cursors.issueCursor.stepId
);
// then for every remaining active agent: clear complete, delete action.md,
// set actionId null / status idle
```

That deletes **all** current-step acceptances (including B/C/D’s good plans)
and forces every remaining agent to republish. The integration canary only
exercises `dropAgent` and therefore hides the CLI bug.

**Required behavior.**

- Persist the drop (roster, dropped set, clear A’s `complete` + `action.md`).
- Keep `accepted[]` entries for other agents at the current step.
- Remove only A’s unresolved/current-step acceptances (and any bound inputs that
  would cite A — already handled by `acceptedAt(..., activeOnly=true)`).
- Reissue actions **only** for agents whose outstanding work still depends on
  the reduced roster (or whose current action text would change because inputs
  omitted A). Agents who already satisfied the current step stay `complete` /
  accepted and must not be forced idle.
- Then `runTick()` once so the gate can advance if the new denominator is met.

**Proposed code change.**

1. Delete or narrow `resetUnresolvedActions` so it never strips peer
   acceptances for the current step.
2. Prefer a dedicated helper, e.g. `rederiveAfterDrop(paths, cursors, droppedAgent)`:

```ts
export const rederiveAfterDrop = (
  paths: IssueRuntimePaths,
  cursors: CursorsState,
  droppedAgent: string,
  now: string
): CursorsState => {
  let next = dropAgent(cursors, droppedAgent, now); // already filters activeRoster
  // Keep peer acceptances at the current step; drop only the dropped agent's.
  next = {
    ...next,
    accepted: next.accepted.filter((s) => s.agent !== droppedAgent),
    updatedAt: now
  };
  clearCompletion(agentRuntimePaths(paths, droppedAgent).complete);
  unlinkSyncIfExists(agentRuntimePaths(paths, droppedAgent).action);

  for (const agent of next.activeRoster) {
    const cursor = next.agents[agent];
    if (cursor === undefined) continue;
    const alreadyAccepted = next.accepted.some(
      (s) =>
        s.agent === agent &&
        s.stepId === next.issueCursor.stepId &&
        s.round === next.issueCursor.round
    );
    if (alreadyAccepted) continue; // do not reset peers who already passed
    // Clear only agents who still owe work, then let runTick prepare-action.
    clearCompletion(agentRuntimePaths(paths, agent).complete);
    unlinkSyncIfExists(agentRuntimePaths(paths, agent).action);
    next = replaceCursor(next, agent, {
      actionId: null,
      status: "idle",
      submissionSha: null,
      outstanding: []
    }, now);
  }
  return next;
};
```

3. Wire `cli.ts` `drop` to `rederiveAfterDrop` + `writeCursorsState` + `runTick`.

**Regression tests (required).**

- Unit: three agents accepted `R2.plan`, drop the fourth → `accepted` still has
  three plan rows; remaining agents are not forced to `idle` if already
  accepted; next `decide()` advances or waits on the reduced denominator only.
- CLI: `coord drop` path matches the unit behavior (not only `dropAgent`).
- Negative: dropping the final active agent still refuses.

---

### R2. Persist and honor the authorized reviser

**Why.** After comparison, the workflow authorizes one reviser. R6/R7
participation is `reviser`. Codex validates the authorization artifact’s
implementation pin but never stores `parsed.value.reviser`, so
`cursors.reviser` stays `originalRoster[0]` forever (`src/state.ts` init).

**Current behavior.**

- Schema includes `reviser` (`reviserAuthorizationArtifactSchema`).
- `evaluateEvidence` for `reviser-authorized` returns
  `{ productPin: implementationCommitSha }` only — no reviser field on the
  observation / accept decision.
- `accept()` never writes `cursors.reviser`.
- `participantsForStep(..., reviser)` therefore always falls back to roster[0].

**Required behavior.**

- On satisfied `reviser-authorized` evidence, require `reviser` to be in the
  **active** roster (not dropped).
- Thread `reviser` through `EvidenceObservation` → `accept-submission` →
  `cursors.reviser`.
- All later `participantsForStep` / `prepare-action` calls for
  `R6.revise`, `R6.declare`, `R7.finalize` must target that agent.
- If authorization names a dropped or unknown agent → reject with a concrete
  outstanding code (do not silently fall back to roster[0]).

**Proposed code change.**

1. Extend observation / accept decision:

```ts
// steps.ts / evidence observation
selectedAgents?: readonly string[]; // existing
reviser?: string;                   // add

// evidence.ts reviser-authorized branch
if (!cursorsWouldAllow) { /* validate against order / bound roster if available */ }
if (!order.inputs.some(...)) errors.push(...);
if (!activeRosterIncludes(parsed.value.reviser)) {
  errors.push(`authorized reviser ${parsed.value.reviser} is not an active agent`);
}
return satisfied(order, submissionSha, {
  productPin: parsed.value.implementationCommitSha,
  reviser: parsed.value.reviser
});
```

(If `evaluateEvidence` lacks roster context, pass `activeRoster` in via the
order or a small evidence context object — do not re-read disk inside the
predicate.)

2. In `accept()`:

```ts
reviser:
  decision.reviser !== undefined
    ? decision.reviser
    : cursors.reviser
```

3. Ensure `prepareAction` / machine participant lists use `cursors.reviser`
   after R5.

**Regression tests (required).**

- Authorization naming `bob` while roster is `[alice, bob, ...]` → subsequent
  R6.revise action is prepared for `bob` only.
- Authorization naming a dropped agent → rejected, `cursors.reviser` unchanged.
- Integration or runLoop tick: comparison → reviser-auth → revise order lands
  on the authorized agent, not `originalRoster[0]`.

---

### R3. Do not open PRs (or publish final branches) during verification

**Why.** Under `coord-open-unmerged`, `verifyFinalizationChecks` publishes
`${branch}-final` and opens a draft PR **while constructing the observation**,
before `accept-submission`. If the tick then pauses, abandons, crashes, or
fails to accept, origin already has a remote branch/PR while R7 is not
accepted. Failed checks correctly block publication; success must not publish
early either.

Claude’s review also notes this is the driver’s only origin **write** and that
non-GitHub origins throw **after** checks pass — a late, avoidable failure.

**Required behavior.**

1. Verification phase: `verifyFinalization` + worktree checks only. Return
   satisfied/rejected observation. **No** `publishBranch`, **no** PR.
2. After `accept-submission` for R7 (or an explicit `finalize` decision applied
   to durable state), perform publication as a separate effect:
   - journal intent,
   - publish branch if needed,
   - open draft PR,
   - journal `pr-created` with URL,
   - on failure: leave accepted finalization intact, surface owner-action /
     retryable error (do not throw away verified state).
3. At `coord start`, if `prPolicy === "coord-open-unmerged"`, validate that
   `origin` matches a supported GitHub remote form; fail closed before any
   runtime write.
4. Document in `docs/coord-driver.md` that unmerged-PR mode may create a
   remote `*-final` head ref (owner-visible capability, not a silent side
   effect).

**Proposed code change.**

```ts
// verifyFinalizationChecks: end after checks; remove publish/PR block

// applyDecisions / after accept of R7:
private async maybeOpenPullRequest(start, cursors, acceptedFinal): Promise<void> {
  if (start.prPolicy !== "coord-open-unmerged") return;
  if (readJournal(this.paths).some((e) => e.type === "pr-created")) return;
  const repository = githubRepositoryFromOrigin(start.origin);
  if (repository === null) {
    this.log(`Owner action required: cannot open PR from origin ${start.origin}`);
    return;
  }
  const finalBranch = `${acceptedFinal.branch}-final`;
  await this.mirror.publishBranch(acceptedFinal.productPin, finalBranch);
  const result = await this.pullRequestOpener({ ... });
  appendJournal(this.paths, { type: "pr-created", details: { url: result.url } }, this.now());
}
```

```ts
// cli start
if (config.prPolicy === "coord-open-unmerged" && githubRepositoryFromOrigin(config.origin) === null) {
  throw new Error("prPolicy coord-open-unmerged requires a github.com origin URL");
}
```

**Regression tests (required).**

- Satisfied R7 verification with injected pause/abandon before accept → no
  `publishBranch` / `pullRequestOpener` calls.
- Accept path with `coord-open-unmerged` → exactly one publish + one PR open
  after accept; journal contains `pr-created`.
- Failed final check → zero publish/PR calls.
- `start` with `coord-open-unmerged` + `file://` origin → fails at start.

---

## Should-fix (operator-ready)

### S1. Accept the design’s `commit <sha>` completion form

**Why (Claude).** Workflow-algorithm §2.3 / §4.5 allow an optional `commit `
prefix. Codex’s `parseCompletion` rejects anything that is not a bare 40-hex
line and also rejects trim-able whitespace (`normalized !== normalized.trim()`),
so `echo 'sha '` and design-doc agents fail interoperability.

**Proposed change (`src/action.ts`).**

```ts
export const parseCompletion = (raw: string): CompletionParseResult => {
  const line = raw.replace(/^\uFEFF/, "").trim(); // allow BOM / surrounding ws
  if (line === "") return { status: "malformed", message: "complete must contain one commit SHA" };
  if (line.includes("\n") || line.includes("\r")) {
    return { status: "malformed", message: "complete must contain exactly one line" };
  }
  const match = /^(?:commit\s+)?([a-f0-9]{40})$/i.exec(line);
  if (match === null) {
    return { status: "malformed", message: "complete must contain a 40-character Git SHA" };
  }
  return { status: "valid", sha: match[1]!.toLowerCase() };
};
```

**Tests.** Bare SHA; `commit <sha>`; `Commit <SHA>` case; trailing newline;
trailing space; multi-line → malformed; empty → malformed.

---

### S2. Contain launcher paths under the agent clone

**Why (Cursor).** `resolve(agent.root, agent.launcher)` + `accessSync(X_OK)`
allows `../../elsewhere/evil.sh`. Coord-root and runtime paths are contained;
launchers must be too.

**Proposed change (`src/tmux.ts`).**

```ts
const launcher = resolve(agent.root, agent.launcher);
if (!isPathInside(agent.root, launcher)) {
  throw new Error(`Launcher for ${agent.id} escapes agent root: ${launcher}`);
}
assertNoSymlink(agent.root, launcher);
accessSync(launcher, constants.X_OK);
```

**Tests.** Relative escape rejected; in-root `start-codex.sh` accepted.

---

### S3. Fix automation digest to issue-scoped plan material

**Why (Cursor).** `coord start` hashes config + hard-coded
`.plans/issue-1/plan.md` regardless of the issue argument.

**Proposed change.**

```ts
const planPath = resolve(io.cwd, `.plans/issue-${issue}/plan.md`);
// If the plan is not required at start in this repo’s workflow, hash config +
// declared digestInputs from config instead — but never a literal issue-1 path.
const digestMaterial = existsSync(planPath)
  ? `${readFileSync(configPath, "utf8")}\n${readFileSync(planPath, "utf8")}`
  : readFileSync(configPath, "utf8");
```

Prefer making digest inputs explicit in `config.example.json` (e.g.
`"digestFiles": ["..."]`) so issue identity is not guessed.

**Tests.** `start` issue `7` must not read `issue-1/plan.md`.

---

### S4. Keep rebuild noise off `coord next` stdout

**Why (Cursor / Claude comparison).** Stale-dist rebuild runs `pnpm build` on
stdout; pull-mode agents can ingest build logs as action text.

**Proposed change (`coord`).**

```bash
if [[ ! -f dist/main.js ]] || find src -type f -newer dist/main.js -print -quit | grep -q .; then
  pnpm build >&2
fi
exec node dist/main.js "$@"
```

**Tests.** Optional smoke: stub build that prints to stdout and assert `coord next`
stdout has no build banner (or document manual check in the PR).

---

### S5. Give the e2e canary its own Vitest config / timeout

**Why (Cursor).** `test:e2e` still inherits `testTimeout: 15_000` from the unit
config. Four-agent git canaries are flaky under that budget.

**Proposed change.** Add `vitest.e2e.config.ts` with
`include: ["test/integration.test.ts"]`, `testTimeout` / `hookTimeout` ≥ 120s;
point `test:e2e` at it; exclude the canary from `vitest.config.ts` and make
`"test"` ≡ `test:fast`.

---

### S6. Broaden negative unit coverage (Claude)

**Why.** Canary covers happy path + drop + one rejection + revision + finalize,
but ~10 evidence predicates have only ~5 unit tests. Correct code without
predicate-level negatives will regress silently.

**Minimum table to add before calling the suite protective.**

| Area | Required negatives |
| --- | --- |
| `complete` | every malformed form from S1 |
| each evidence id | missing path; malformed JSON/markdown; session mismatch; wrong round; pin === signal; pin not on branch |
| mirror | wrong-branch SHA; transient fetch vs absence |
| drop | R1 scenarios |
| reviser | R2 scenarios |
| finalization | failed check blocks PR; PR not opened during verify (R3) |

---

## Nice-to-have (non-blocking)

| ID | Item | Note |
| --- | --- | --- |
| N1 | Document deliberate one-decision-batch in `decide()` | Claude finding 4 — observation decisions return before gate advance; latency is one poll interval; comment so nobody “fixes” it incorrectly. |
| N2 | Generalize check argv placeholders | Support `{finalSha}`, `{baselineSha}`, `{issue}` with the same per-element, shell-free substitution as `{worktree}`. |
| N3 | Keep Antigravity’s env fallbacks | `COORD_ROOT` / `COORD_ISSUE` / `COORD_AGENT` are already present — preserve them in any CLI refactor. |
| N4 | Avoid absorbing Claude’s broken R6/R7 when cherry-picking | Claude is a donor for pause-exit / concurrent cursor reload / e2e config patterns only — not for vacuous coordinator gates or same-SHA finalization. |

---

## Suggested implementation order

1. **R1** drop semantics — correctness of multi-agent gates; small surface.
2. **R2** reviser persistence — unlocks correct R6/R7 routing.
3. **R3** PR/publish after accept + start-time origin validation — authority /
   crash safety.
4. **S1** completion parser — protocol conformance, tiny diff.
5. **S2–S5** containment, digest, stdout, e2e timeout — operator hygiene.
6. **S6** negative fixtures — protects everything above.

---

## Definition of done (acceptance checklist)

- [ ] R1 implemented + drop regression tests green
- [ ] R2 implemented + reviser routing tests green
- [ ] R3 implemented + verify-vs-publish ordering tests green; start rejects bad
      origin for `coord-open-unmerged`
- [ ] S1–S5 landed (or explicitly deferred in the PR description with owner ACK)
- [ ] `pnpm check` green on the revised Codex branch
- [ ] `docs/coord-driver.md` mentions remote `*-final` branch creation when
      `coord-open-unmerged` is enabled
- [ ] No merge of peer trunks until this checklist is checked

---

## Explicit non-goals for this revision pass

- Rewriting the pure machine / evidence split (already correct on Codex).
- Porting Claude’s full runtime model or Cursor’s scaffold wholesale.
- Enabling automatic non-Claude nudges.
- Implementing merge (remains owner-only forever).

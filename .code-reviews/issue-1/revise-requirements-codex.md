# Revision requirements — `issue-1/codex`

**Author:** Claude
**Target:** `04445b4` "Codex: implement coordination workflow driver"
**Recommendation:** adopt this branch as the base for issue-1, **conditional on
R1–R10 below.**

## Sources and verification

This consolidates three reviews:

| Source | Location | Findings adopted |
| --- | --- | --- |
| Claude | `.code-reviews/issue-1/review-codex.md` (`1c1bc9d`) | R8, R9, R11, R13 |
| Cursor | `origin/issue-1/cursor:.code-reviews/issue-1/review-codex.md` (`e097be7`) | R1, R2, R3, R5, R6, R7, R12, R14 |
| Antigravity | `origin/issue-1/antigravity:.code-reviews/issue-1/review-codex.md` (`225dfdb`) | none — see *Disagreements* |

**Every finding below was re-verified against the source before inclusion.** I
did not take another reviewer's claim on trust; where a claim proved stronger or
weaker than reported, the entry says so. R10 is mine and appears in no other
review.

Baseline state: `pnpm check` passes on `04445b4` — 46 fast tests + a 370-line
four-agent canary. None of the defects below is caught by that suite.

## Why this branch, in one paragraph

Codex's `cursors.accepted` is an array of `AcceptedSubmission` keyed by
`(stepId, agent, round)` carrying `productPin`, `disposition`, and
`selectedAgents`. That single modelling choice is why drop filtering, round
accounting, and disposition-driven revision routing all fall out naturally —
and it is the thing that cannot be retrofitted cheaply. The competing branches
store one status and one SHA per agent, which is why their gates and revision
caps are broken in ways that require redesigning `cursors.json`. Codex's defects
are, without exception, additive: they are missing wiring and missing tests
around a correct core.

---

## Acceptance gate

| # | Requirement | Severity | Est. |
| --- | --- | --- | --- |
| R1 | `coord drop` must not discard peers' accepted evidence | **Blocking** | M |
| R2 | Reviser authorization must actually route later steps | **Blocking** | M |
| R3 | PR creation must follow acceptance, not verification | **Blocking** | S |
| R4 | Preserve agent intent across a roster change | **Blocking** | S |
| R5 | Automation digest must derive from the issue being started | **Blocking** | S |
| R6 | `coord` rebuild output must not pollute stdout | Required | XS |
| R7 | The e2e canary needs its own timeout budget | Required | XS |
| R8 | Completion parser must accept the `commit <sha>` form | Required | XS |
| R9 | PR-policy/origin compatibility must fail at `start` | Required | S |
| R10 | The git boundary must be hermetic | Required | S |
| R11 | Launcher paths must stay inside the agent clone | Recommended | XS |
| R12 | `--coord-root` should not fall back to the environment | Recommended | XS |
| R13 | Predicate-level negative coverage | Required | L |
| R14 | `pnpm test` should not conflate the tiers | Recommended | XS |

R1–R5 block acceptance. R6–R10 and R13 must land before the branch is used for
further feature work. R11, R12, R14 are judgement calls the owner may decline.

---

## R1 — `coord drop` must not discard peers' accepted evidence

**Severity: blocking. Verified at `src/cli.ts:109-127`.**

### What is wrong

```ts
const resetUnresolvedActions = (paths: IssueRuntimePaths, cursors: CursorsState, now: string): CursorsState => {
  let next = cursorsStateSchema.parse({
    ...cursors,
    accepted: cursors.accepted.filter((submission) => submission.stepId !== cursors.issueCursor.stepId),
    updatedAt: now
  });
  for (const agent of next.activeRoster) {
    const runtime = agentRuntimePaths(paths, agent);
    clearCompletion(runtime.complete);
    if (existsSync(runtime.action)) unlinkSync(runtime.action);
    next = replaceCursor(next, agent, { actionId: null, status: "idle", submissionSha: null, outstanding: [] }, now);
  }
  return next;
};
```

The `accepted` filter drops **every** submission at the current step, from every
agent — not just the dropped one. It then clears every active agent's `complete`
file and `action.md`.

Note that `dropAgent` (`src/state.ts:383-384`) already removes the dropped
agent's own acceptance at the current step, and does so correctly. The `cli.ts`
helper duplicates that intent with a far wider blast radius.

### Failure scenario

Four-agent consensus run at `R2.plan`. `antigravity`, `claude`, and `cursor`
publish valid plans and have them accepted. `codex` is unavailable. The owner
runs `coord drop codex`.

Expected: the gate closes immediately on a denominator of 3.
Actual: all three accepted plans are erased. Three agents that did nothing wrong
are re-ordered to republish work already verified against origin. If any had a
submission mid-flight, its `complete` file is deleted too.

The larger the roster, the worse it scales — dropping the last of N agents
destroys N−1 agents' work.

### Why it matters

Required behavior 7 defines drop as **one local atomic state change**: journal
it, add to the dropped set, ignore that agent's pending completion, *"and
rederive the unresolved and future actions from the remaining agents."*
Rederiving an **action** is not the same as discarding an **acceptance**. The
plan is explicit that *"Completed historical gates and immutable pins are not
recomputed"*, and the same principle applies to verified work at the current
step: it was proven against an immutable origin commit and a drop does not
change that proof.

### Proposed change

Replace the helper. Accepted evidence is never touched here; only actions whose
bound inputs changed are reissued.

```ts
/**
 * After a roster change, reissue only what the change invalidated.
 *
 * Accepted evidence is deliberately untouched: `dropAgent` has already removed
 * the dropped agent's own acceptance at the current step, and a peer that
 * already satisfied the step keeps its acceptance so the gate can close on the
 * reduced denominator. Completion files are also left alone — see R4.
 */
const reissueAffectedActions = (
  paths: IssueRuntimePaths,
  cursors: CursorsState,
  now: string
): CursorsState => {
  const currentStep = cursors.issueCursor.stepId;
  const round = currentStep.startsWith("R6.") ? (cursors.issueCursor.round ?? 1) : null;
  let next = cursors;

  for (const agent of next.activeRoster) {
    const alreadySatisfied = next.accepted.some(
      (submission) =>
        submission.stepId === currentStep &&
        submission.agent === agent &&
        submission.round === round
    );

    if (alreadySatisfied) continue;

    const runtime = agentRuntimePaths(paths, agent);
    if (existsSync(runtime.action)) unlinkSync(runtime.action);
    next = replaceCursor(next, agent, { actionId: null, status: "idle", outstanding: [] }, now);
  }

  return next;
};
```

Call site at `src/cli.ts:241` changes name only. The subsequent
`await makeRunLoop(paths).runTick()` then re-derives inputs from the reduced
roster and rewrites actions for exactly the agents that still owe work.

### Test to add

```ts
it("keeps peers' accepted work when an agent is dropped mid-gate", async () => {
  // three of four agents accepted at R2.plan, fourth is stuck
  await runCli(["drop", "codex", ...base], deps);
  const cursors = readCursorsState(paths);
  expect(cursors.accepted.filter((s) => s.stepId === "R2.plan")).toHaveLength(3);
  // and the gate closes on the reduced denominator without republication
  expect(readCursorsState(paths).issueCursor.stepId).not.toBe("R2.plan");
});
```

---

## R2 — Reviser authorization must actually route later steps

**Severity: blocking. Verified at `src/evidence.ts:257-265`, `src/state.ts:280,378`.**

### What is wrong

The `reviser-authorized` predicate parses the artifact, validates the
implementation pin, and returns:

```ts
return errors.length === 0
  ? satisfied(order, submissionSha, { productPin: parsed.value.implementationCommitSha })
  : rejected(order, submissionSha, errors);
```

`reviserAuthorizationArtifactSchema` declares a `reviser: agentIdSchema` field
(`src/protocol.ts:86`) which is parsed and then **discarded**. `cursors.reviser`
is initialised once to `start.originalRoster[0]` (`src/state.ts:280`) and is
only ever reassigned when the current reviser is themselves dropped
(`src/state.ts:378`).

### Failure scenario

Comparison ballots select `cursor`'s implementation. The `R5.reviser-auth`
artifact names `cursor` as reviser and is accepted. `R6.revise` is then ordered
to `antigravity` — `originalRoster[0]` — who has no relationship to the selected
implementation. `R6.declare` and `R7.finalize` inherit the same wrong agent.
Reviser routing, the entire point of `R5.reviser-auth`, is a no-op.

The alphabetical-first roster entry makes this easy to miss in the canary if the
canary's selected agent happens to sort first.

### Why it matters

The adopted plan lists *"plan/reviser routing"* among the machine's
responsibilities, and required behavior 6 covers the accepted R0–R7 behaviour.
An unused artifact field is worse than a missing one: agents are asked to
produce and cite it, and the evidence layer validates it, so everyone reasonably
assumes it is load-bearing.

### Proposed change

Thread the reviser through the existing observation → decision → accept path,
which already carries `productPin`, `disposition`, and `selectedAgents` — this
is one more field of the same kind.

**`src/steps.ts`** — extend both types:

```ts
export type EvidenceObservation = {
  // …existing fields…
  reviser?: string;
};

// MachineDecision, accept-submission variant:
| {
    type: "accept-submission";
    agent: string;
    submissionSha: string;
    productPin?: string;
    disposition?: "approve" | "revise" | "escalate";
    approvedPaths?: readonly string[];
    selectedAgents?: readonly string[];
    reviser?: string;
  }
```

**`src/evidence.ts:257-265`** — return it:

```ts
if (order.evidenceId === "reviser-authorized") {
  const parsed = parseJsonWithSchema(blob, reviserAuthorizationArtifactSchema);
  if (!parsed.ok) return rejected(order, submissionSha, [`invalid reviser authorization: ${parsed.error}`]);
  const errors = [...commonErrors(parsed.value, order), ...inputHashErrors(parsed.value.inputSetHash, order)];
  if (!order.inputs.some((input) => input.commitSha === parsed.value.implementationCommitSha)) {
    errors.push("authorized implementation pin is not one of the bound inputs");
  }
  return errors.length === 0
    ? satisfied(order, submissionSha, {
        productPin: parsed.value.implementationCommitSha,
        reviser: parsed.value.reviser
      })
    : rejected(order, submissionSha, errors);
}
```

**`src/machine.ts:74-83`** — forward it alongside the other optionals:

```ts
...(observation.reviser === undefined ? {} : { reviser: observation.reviser }),
```

**`src/runLoop.ts`, `accept()`** — persist it, rejecting an inactive nominee.
`cursors` is in scope here, which is the right place for the roster check
(`InternalOrder` does not currently carry the active roster, so validating in
`evidence.ts` would mean threading it further):

```ts
if (decision.reviser !== undefined && !cursors.activeRoster.includes(decision.reviser)) {
  return this.reissue(start, cursors, decision.agent, [
    `authorized reviser ${decision.reviser} is not an active agent`
  ]);
}
```

then include `reviser: decision.reviser ?? cursors.reviser` in the
`cursorsStateSchema.parse({ … })` call that builds the next state.

### Test to add

```ts
it("routes R6.revise to the authorized reviser, not the first roster entry", async () => {
  // authorize the last roster entry, so a regression to originalRoster[0] fails
  await acceptReviserAuthorization({ reviser: "cursor" });
  expect(readCursorsState(paths).reviser).toBe("cursor");
  await loop.runTick();
  expect(existsSync(agentRuntimePaths(paths, "cursor").action)).toBe(true);
  expect(existsSync(agentRuntimePaths(paths, "antigravity").action)).toBe(false);
});

it("rejects an authorization naming a dropped agent", async () => { /* … */ });
```

---

## R3 — PR creation must follow acceptance, not verification

**Severity: blocking. Verified at `src/runLoop.ts:437-490`.**

### What is wrong

`verifyFinalizationChecks` is an **observation builder** — it returns an
`EvidenceObservation`. Inside it, after the checks pass:

```ts
if (start.prPolicy === "coord-open-unmerged" && !readJournal(this.paths).some((event) => event.type === "pr-created")) {
  // …
  await this.mirror.publishBranch(observation.productPin, finalBranch);
  const result = await this.pullRequestOpener({ /* … */ });
  appendJournal(this.paths, { type: "pr-created", … }, this.now());
}
return observation;
```

So an externally visible, irreversible side effect — a pushed branch and an open
PR on GitHub — happens while the coordinator is still deciding whether to accept
the submission.

The check-gating itself is correct: a non-zero exit returns before this block.
The problem is ordering, not gating.

### Failure scenario

`verifyFinalizationChecks` publishes the branch and opens the PR. Before the
resulting observation reaches `accept-submission`:

- the owner runs `coord pause` or `coord abandon`, and `decide()` early-returns
  at `machine.ts:60-62`; or
- the process crashes between the `publishBranch` await and the state write.

Origin now carries an `issue-1/<agent>-final` branch and an open pull request,
while `cursors.json` records finalization as unaccepted. On restart the driver
re-verifies; the `pr-created` journal guard prevents a duplicate PR, but the
recorded state and the world disagree, and nothing reconciles them.

### Why it matters

The plan treats PR creation as a distinct capability and requires that it happen
only *"when authorized"*, after successful verification. An artifact that exists
on GitHub while the coordinator believes finalization did not complete is the
kind of divergence the journal-before-acknowledge discipline exists to prevent —
and it is the one effect in the whole driver that other people can see.

### Proposed change

Split the two concerns. `verifyFinalizationChecks` becomes pure verification and
records the checks it ran; publication moves into the accept path.

```ts
// verifyFinalizationChecks: delete the PR block entirely, return the observation.
// The check results are already journaled at :454-458.
```

```ts
// In the accept path, after the R7 acceptance is durably persisted:
private async publishFinalization(start: StartState, cursors: CursorsState, pin: string): Promise<void> {
  if (start.prPolicy !== "coord-open-unmerged") return;
  if (readJournal(this.paths).some((event) => event.type === "pr-created")) return;

  const repository = githubRepositoryFromOrigin(start.origin);
  if (repository === null) {
    // R9 makes this unreachable from a valid `start`; keep it as a guard that
    // records rather than throws, so a verified finalization is not lost.
    this.log(`Cannot derive a GitHub repository from origin ${start.origin}; no PR opened.`);
    return;
  }
  // …publishBranch + pullRequestOpener + journal, exactly as today…
}
```

Call it from the branch that handles `accept-submission` for `R7.finalize`,
after `this.persist(...)` has returned.

### Test to add

```ts
it("opens no PR when the run is paused between verification and acceptance", async () => {
  // pause after checks pass but before the accept decision is applied
  expect(opener).not.toHaveBeenCalled();
  expect(readJournal(paths).some((e) => e.type === "pr-created")).toBe(false);
});
```

---

## R4 — Preserve agent intent across a roster change

**Severity: blocking (folded into R1's fix). Verified at `src/cli.ts:117`.**

`resetUnresolvedActions` calls `clearCompletion(runtime.complete)` for **every**
active agent. An agent that wrote its submission SHA seconds before the owner
typed `coord drop` has that intent silently destroyed, with no journal entry
naming it and no way for the agent to know.

The proposed R1 replacement deliberately omits the `clearCompletion` call. If a
pending submission is genuinely invalidated by the roster change — a ballot
citing the dropped agent, say — the evidence layer already rejects it with
concrete `outstanding[]` detail and the action is reissued. That is the designed
feedback path, and it tells the agent *why*. Silently deleting the file tells it
nothing.

This matters because the plan makes indefinite waiting and explicit feedback the
core of the protocol: *"only valid evidence or a direct owner control command
changes the workflow."* A completion file the owner never saw is neither.

**Test:** assert that a pending `complete` for a non-dropped agent still exists
after `coord drop`, and that the next tick either accepts it or rejects it with
`outstanding[]`.

---

## R5 — Automation digest must derive from the issue being started

**Severity: blocking. Verified at `src/cli.ts:166`.**

```ts
const digestMaterial = `${readFileSync(configPath, "utf8")}\n${readFileSync(resolve(io.cwd, ".plans/issue-1/plan.md"), "utf8")}`;
```

The path `.plans/issue-1/plan.md` is a literal, independent of the `issue`
argument parsed a few lines above.

### Failure scenario

`coord start 7 --profile consensus …`:

- if `.plans/issue-1/plan.md` is absent, `readFileSync` throws and `start` fails
  with a message about a file that has nothing to do with issue 7;
- if it is present, `automationDigest` binds **issue 1's plan bytes** into issue
  7's session. Every agent's join signal is then validated against the wrong
  material. The digest still functions as a consistency check — all agents agree
  — but it certifies the wrong thing, which is worse than not checking, because
  it looks like it is working.

It also reads from `io.cwd`, so the result depends on where the operator stood.

### Proposed change

Make the digest material configuration-declared and issue-parameterised.

**`src/state.ts`**, config schema:

```ts
digestPaths: z.array(z.string().min(1)).default([".plans/issue-{issue}/plan.md"]),
```

**`src/cli.ts:166`**:

```ts
const digestSources = config.digestPaths.map((template) =>
  template.replaceAll("{issue}", String(issue))
);
const digestMaterial = [
  readFileSync(configPath, "utf8"),
  ...digestSources.map((relativePath) => {
    const absolute = containedPath(resolve(configPath, ".."), relativePath);
    try {
      return readFileSync(absolute, "utf8");
    } catch {
      throw new Error(
        `Digest source ${relativePath} for issue ${issue} is missing at ${absolute}. ` +
          `Publish it, or adjust digestPaths in ${configPath}.`
      );
    }
  })
].join("\n");
```

Resolving relative to the **config file** rather than `io.cwd` also makes
`start` reproducible from any directory, and `containedPath` keeps a config
value from reaching outside the project.

**Test:** `coord start 7` with only `.plans/issue-7/plan.md` present succeeds and
produces a digest different from `coord start 1`'s.

---

## R6 — `coord` rebuild output must not pollute stdout

**Severity: required. Verified at `coord:4-6`.**

```bash
if [[ ! -f dist/main.js ]] || find src -type f -newer dist/main.js -print -quit | grep -q .; then
  pnpm build
fi
exec node dist/main.js "$@"
```

The staleness detection is good — better than the scaffold's existence-only
check. But `pnpm build` writes to stdout, so the first `coord next` after any
source edit returns build logs prepended to the action document. Pull-mode
agents are told to treat that stdout as their action.

```diff
-  pnpm build
+  pnpm build >&2
```

**Test:** with `dist/` stale, assert `coord next` stdout parses as valid action
front matter.

---

## R7 — The e2e canary needs its own timeout budget

**Severity: required. Verified at `vitest.config.ts:6`, `package.json`.**

`test:e2e` is `vitest run test/integration.test.ts`, which loads the shared
config with `testTimeout: 15_000`. The canary measured **8.7 s** on my machine
with a warm page cache. That is 58% of budget for a test doing dozens of
sequential `git clone`/`commit`/`push` round trips.

On a loaded CI box or a slower disk this fails as a timeout. The pre-push hook
runs `test:e2e` for workflow-critical paths, so the symptom is a blocked push
that looks like a product defect and passes on retry — the most expensive kind
of flake to diagnose.

Add a dedicated config:

```ts
// vitest.e2e.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
});
```

and point `test:e2e` at it: `vitest run --config vitest.e2e.config.ts`.

Keep `passWithNoTests` at its default `false`, so a renamed or deleted canary
fails loudly rather than reporting a green run over an empty suite.

---

## R8 — Completion parser must accept the `commit <sha>` form

**Severity: required. Verified at `src/action.ts:88-99`.**

```ts
const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
if (normalized.includes("\n") || normalized.includes("\r") || normalized !== normalized.trim()) {
  return { status: "malformed", message: "complete must contain exactly one unpadded line" };
}
const parsed = gitShaSchema.safeParse(normalized);
```

The accepted design is explicit in both §2.3 and §4.5:

> Contents of `complete`: a single line, 40-hex git SHA (**optional `commit `
> prefix**).

`commit 4ab89257…` is a documented valid submission and this rejects it. The
`normalized !== normalized.trim()` guard additionally rejects a trailing space,
which `echo` and most editors add.

The rendered action asks for the bare form, so a run driven entirely by this
implementation is self-consistent — but an agent working from the design
document, or a `complete` written by another implementation, is rejected for a
reason the protocol says is legal.

```ts
export const parseCompletion = (raw: string): CompletionParseResult => {
  const lines = raw.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length === 0) return { status: "malformed", message: "complete must contain one commit SHA" };
  if (lines.length > 1) return { status: "malformed", message: "complete must contain exactly one line" };

  // §4.5 permits an optional `commit ` prefix.
  const candidate = (lines[0] as string).replace(/^commit\s+/i, "");
  const parsed = gitShaSchema.safeParse(candidate);
  return parsed.success
    ? { status: "valid", sha: parsed.data }
    : { status: "malformed", message: "complete must contain a 40-character lowercase Git SHA" };
};
```

**Tests:** a table covering bare SHA, `commit <sha>`, trailing whitespace,
trailing newline, empty, prose, JSON, abbreviated, uppercase, and two lines.

---

## R9 — PR-policy/origin compatibility must fail at `start`

**Severity: required. Verified at `src/runLoop.ts:473-474`, `:78-83`.**

```ts
const repository = githubRepositoryFromOrigin(start.origin);
if (repository === null) throw new Error(`Cannot derive a GitHub repository from origin ${start.origin}.`);
```

`githubRepositoryFromOrigin` matches only `https://github.com/owner/repo` and
`git@github.com:owner/repo`. Any other origin — a file path, a self-hosted host,
a URL with a trailing slash — throws **after** cleanup verification and every
configured check has already run and passed.

A long consensus run reaches the final second and dies on a configuration fact
that was knowable before the first action was written. Worse, it throws out of
the tick, so the successful verification is not durably recorded.

Add a precondition in `coord start`:

```ts
if (config.prPolicy === "coord-open-unmerged" && githubRepositoryFromOrigin(config.origin) === null) {
  throw new Error(
    `prPolicy "coord-open-unmerged" requires a GitHub origin; ${config.origin} is not one. ` +
      `Use prPolicy "owner-only", or point origin at github.com.`
  );
}
```

Combined with R3's non-throwing guard, a late surprise degrades to a logged
"no PR opened" over a finalization that is still recorded as verified.

---

## R10 — The git boundary must be hermetic

**Severity: required. Verified at `src/mirror.ts:7-14`. Not reported by any other reviewer.**

```ts
export type GitRunner = (args: readonly string[], options?: { cwd?: string }) => Promise<CommandResult>;
// …
cwd: options.cwd,
env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
```

Two inherited things can redirect every git operation:

1. **`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
   `GIT_COMMON_DIR`, `GIT_CONFIG*`** pass straight through from `process.env`.
   Git hooks set several of these unconditionally, and so do many agent
   harnesses.
2. **`cwd` is `undefined` unless a caller passes one**, so git inherits the
   coordinator's working directory.

The coordinator is launched from agent panes and, plausibly, from hooks. With
`GIT_DIR` set, a `git -C <mirror> …` invocation can still resolve objects
against the *wrong* repository.

I hit this concretely on my own branch: it surfaced as an intermittent
`fatal: .git/index: index file open failed: Not a directory` during
`git worktree add` in the finalization path — under parallel test execution
only, which made it look like flake rather than a boundary defect. Codex's
finalization uses `materializeWorktree` in exactly the same way, so the same
latent failure is present.

```ts
const inheritedGitVars = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE",
  "GIT_PREFIX", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"
] as const;

const gitEnv = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const key of inheritedGitVars) delete env[key];
  return env;
};

// and in the runner:
cwd: options?.cwd ?? tmpdir(),   // an explicit `-C` in args decides the repository
env: gitEnv()
```

**Test:** run a mirror operation with `GIT_DIR` set to an unrelated repository
and assert it still reads the mirror.

---

## R11 — Launcher paths must stay inside the agent clone

**Severity: recommended. Verified at `src/tmux.ts:48-54`.**

```ts
const launcher = resolve(agent.root, agent.launcher);
accessSync(launcher, constants.X_OK);
```

Executability is checked; containment is not. A config `launcher` of
`../../elsewhere/run.sh` resolves outside the clone and is handed to tmux
`new-window`. Every other path in this branch is confined via `containedPath` —
this one is the exception.

The threat model is modest (the config is owner-written), but consistency is
cheap here and `containedPath` already exists:

```ts
const launcher = containedPath(resolve(agent.root), agent.launcher);
```

Credit where due: requiring `X_OK` rather than mere existence is correct, and
matches the plan's *"missing/non-executable launcher is a named startup
failure."*

---

## R12 — `--coord-root` should not fall back to the environment

**Severity: recommended — and a direct disagreement with Antigravity's review.**

`src/cli.ts:106`: *"COORD_ROOT, COORD_ISSUE, and COORD_AGENT may replace the
corresponding options."*

Antigravity lists this under **Strengths**: *"Codex smartly implemented fallback
checks… This greatly improves operator ergonomics."*

I disagree specifically for `COORD_ROOT`. The plan states: *"`start` requires the
owner to name `--coord-root` explicitly and proves it is outside every configured
clone before writing."* The word *explicitly* is doing work. An exported
`COORD_ROOT` in a shell profile makes the most safety-critical argument in the
system invisible at the call site — and the containment check protects against
exactly the mistake (a root inside a clone) that a stale environment variable
makes easy to inherit without noticing.

`COORD_ISSUE` and `COORD_AGENT` are genuine ergonomics wins with no equivalent
blast radius; agents type `coord next` constantly. Keep those.

**Proposed:** drop the `COORD_ROOT` fallback, keep `COORD_ISSUE` and
`COORD_AGENT`. If the owner wants it, make it an explicit `--coord-root env`
opt-in rather than a silent default. This is a judgement call and the owner may
reasonably overrule it — but it should be a decision, not an inheritance.

---

## R13 — Predicate-level negative coverage

**Severity: required. Largest item.**

47 tests total:

| File | Tests | Plan requires |
| --- | --- | --- |
| `evidence.test.ts` | 5 | "positive **and negative** fixtures for **every** predicate" |
| `action.test.ts` | 3 | "**every** malformed `complete` form" |
| `state.test.ts` | 3 | strictness, atomic writes, journal recovery, pause/resume, drops |
| `cli.test.ts` | 3 | "**every** public command, stable exit codes…" |
| `mirror.test.ts` | 3 | external-root refusal, wrong-branch SHAs, ancestry, transient vs absence |
| `pinValidation.test.ts` | 3 | adapted from the legacy pin tests |

The canary is genuinely good, but it is **one test**. When it fails it reports
"the workflow broke", not which predicate regressed. There are roughly ten
evidence predicates behind five tests.

This is the finding most likely to matter six months out: the branch is *correct
today* in the places that count, and the suite would not tell you when it stops
being. Every defect in R1–R5 is invisible to the current suite.

Minimum floor before further feature work:

1. **One negative fixture per evidence predicate** — wrong path, malformed
   document, stale `issueSessionId`, wrong pin, wrong round, signal-commit used
   as product pin, citation of a non-bound input.
2. **The malformed-`complete` table** from R8.
3. **Regression tests for R1–R5**, each specified above.
4. **Four invariant tests portable from `issue-1/claude`** — they assert rules
   rather than behaviour, so they survive refactors:
   - `machine.ts` source imports nothing effectful (read the file, assert the
     import list);
   - `action.md` contains no `StepId`/`GateId`/`EvidenceId`/attempt/peer name;
   - a transient verification preserves `complete` and emits no verdict;
   - `verifyFinalization` is invoked with `finalSha !== consensusSha` and fails
     when non-cleanup paths remain.
5. **A concurrency test**: a `coord drop` issued while `coord run` is live
   survives the next tick. Codex is correct here — `runTick` re-reads
   `cursors.json` at `src/runLoop.ts:509`, unlike `issue-1/claude`, which loads
   once and overwrites owner controls. That correctness is currently
   undefended by any test; lock it down before someone "optimises" the re-read
   away.

---

## R14 — `pnpm test` should not conflate the tiers

**Severity: recommended. Verified at `package.json`.**

`"test": "vitest run"` with no exclude in `vitest.config.ts` runs the canary too.
`check:fast` and `check` are wired correctly, so the hooks are fine; this only
bites someone typing `pnpm test` by hand and wondering why it takes 9 s.

```diff
-  "test": "vitest run",
+  "test": "pnpm test:fast && pnpm test:e2e",
```

---

## Disagreements with other reviews

**Antigravity, "Environment Variable Fallbacks … Strengths."** Addressed in R12.
For `COORD_ROOT` specifically I read this as a defect against an explicit plan
requirement, not a strength.

**Antigravity's review overall** did not identify any defect. It is three
strengths and two mild suggestions against a branch that has, on verification,
two blocking correctness bugs in drop handling and reviser routing. It should not
be weighed as independent confirmation of quality.

**Cursor's P1 severity on `resetUnresolvedActions` is if anything understated.**
Their description covers the discarded acceptances; the unconditional
`clearCompletion` across all active agents (R4) is a second, separate loss of
agent intent in the same function.

**Cursor's `[P2]` on PR-during-verify** I have raised to blocking (R3). The
others are recoverable internal-state problems; this one puts an artifact on
GitHub that the coordinator's own state says should not exist.

---

## What not to change

These are correct and should survive revision:

- **`cursors.accepted` keyed by `(stepId, agent, round)`** — the reason this
  branch is the right base. Do not flatten it.
- **`randomUUID()` action ids plus a parser that rejects any front-matter key
  outside `actionId | agent | requiredPath`** (`src/action.ts:63-76`). The
  parser enforces the confidentiality invariant instead of documenting it.
- **`retry` as an observation status distinct from `rejected`**
  (`src/evidence.ts:155-163` → `machine.ts:69-70` → `runLoop.ts:499-500`), with
  `retry` deliberately not clearing `complete`.
- **The revision cap returning `owner-action-required` *instead of* the advance**
  (`machine.ts:108-118`), evaluated on every ballot round rather than on gate
  entry.
- **`acceptedAt` filtering to `activeRoster` by default** (`runLoop.ts:112`) —
  this is what makes the drop contract's "no announcement, the reduced input set
  communicates it" fall out for free.
- **`runTick` re-reading `cursors.json` each tick** (`runLoop.ts:509`).
- **Atomic write-and-rename with fsync** in `action.ts:123` and `state.ts:248`.
- **`containedPath` wrapping every derived runtime path**, and `agentPattern`
  restricting ids to safe segments.

---

## Acceptance checklist

Sign-off requires all of the following:

- [ ] R1 — drop keeps peers' accepted evidence; regression test present
- [ ] R2 — `cursors.reviser` follows the authorization artifact; routing test present
- [ ] R3 — no PR or branch push before the R7 acceptance is persisted
- [ ] R4 — pending completions survive a roster change
- [ ] R5 — digest derives from the started issue, resolved relative to the config
- [ ] R6 — `coord next` stdout is protocol-clean with a stale `dist/`
- [ ] R7 — `test:e2e` runs under its own config with a realistic timeout
- [ ] R8 — `commit <sha>` accepted; malformed-form table tested
- [ ] R9 — incompatible `prPolicy`/origin rejected at `start`
- [ ] R10 — git subprocesses run with a sanitised environment and explicit cwd
- [ ] R13 — one negative fixture per evidence predicate, plus the five listed suites
- [ ] `pnpm check` green, and the canary extended to cover R1 and R2
- [ ] Owner decision recorded on R11, R12, R14
- [ ] Owner decision recorded on the `-final` branch push to origin
      (`src/runLoop.ts:475-476`) — the only origin write the driver performs, and
      not a capability the adopted plan enumerates

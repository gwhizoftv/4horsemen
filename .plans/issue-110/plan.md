# Issue 110 — Private ballot responses + coordinator batch evidence

## Problem restated

Ballot phases (`R3.plan-ballot`, `R5.compare-ballot`, every `R6.ballot`
round) currently force each agent to copy a large coordinator-known envelope
into a repository JSON file, commit it on `issue-<n>/<agent>`, push, and write
the tip SHA to `complete`. Under a four-agent consensus profile that is twelve
agent Git round-trips per successful pass, plus more per revision round.

Only `choice`/`disposition` and `rationale` are agent judgment. Everything else
is already known to the coordinator. This issue moves that judgment into an
action-scoped private runtime response outside every clone, then has the
coordinator publish **one** canonical origin commit per completed gate/round on
a dedicated evidence branch before any derivation or advance.

Depends on #109 (deterministic selection/reviser/consensus; no agent-facing
selection, reviser-auth, or declare phases). This issue must not reintroduce
those LLM phases. New-workflow only: bump runtime format and fail closed; no
migration of in-flight ballot Git submissions.

## Design (authoritative for implementers)

### Public action union

Ballot actions render `submissionMode: response` with an absolute
`responsePath`. Git actions retain today's `requiredPath` Git mode. Parsing is
strict: response front matter may not carry `requiredPath`; Git front matter may
not carry `submissionMode`/`responsePath`.

Representative ballot front matter:

```yaml
---
actionId: <uuid>
agent: <id>
submissionMode: response
responsePath: <coord-root>/issue-<n>/agents/<agent>/responses/<actionId>.json
---
```

Action body still binds exact Git inputs to inspect, names the existing
completion mailbox path, and shows only the minimal response schema for the
current ballot kind.

### Agent response schemas (strict)

Plan / comparison:

```json
{ "actionId": "<current-action-uuid>", "choice": "<eligible-agent>", "rationale": "..." }
```

Consensus:

```json
{ "actionId": "<current-action-uuid>", "disposition": "approve|revise|escalate", "rationale": "..." }
```

Bounds (document in code + docs):

- `rationale`: non-empty, max **2000** Unicode code points after trim;
- whole response file: max **8192** bytes before parse;
- no agent/issue/session/pins/round/digest/protocol fields from the agent.

Coordinator identity for the response comes only from the configured agent
runtime + current cursor, never from an agent-supplied `agent` field.

### Completion marker

Git actions keep `complete` = 40-char lowercase SHA (optional `commit ` prefix).

Response actions:

1. Write the full JSON to `responsePath`.
2. Then write exactly one line to the existing completion path:

```text
response <actionId>
```

Coordinator accepts the marker only when that action ID equals the current
authorized action. Coordinator computes SHA-256 over accepted bytes; agents do
not supply digests. Optional `coord respond` helper may atomically write both
files; the durable protocol is response file + marker, not the helper.

### Acceptance pipeline (on valid marker)

1. Reassert cursor authority.
2. Resolve expected `responsePath` from trusted `IssueRuntimePaths` + action ID
   (never from agent-supplied paths).
3. Existing confinement + `assertNoSymlink` + regular-file checks.
4. Read response only after the marker exists.
5. Strict schema parse for the current internal step.
6. Verify `actionId`, choice eligibility / disposition enum.
7. Hash exact accepted bytes; store normalized semantic value.
8. Persist accepted-response record (not a Git `AcceptedSubmission`).
9. Journal `response-accepted` with full bounded semantics + digest.
10. Atomically archive immutable bytes under coordinator-owned runtime state.
11. Clear working response file and completion marker.

Rejected/malformed: clear marker, reissue same action with concrete outstanding
items; allow replace. No Git commit and no accepted record.

Transient publication failure after acceptance must **not** clear accepted
responses or re-nudge those agents.

### Runtime format

- Bump `RUNTIME_FORMAT_VERSION` **3 → 4**.
- Treat format **3** like today's format **2**: `assertRuntimeFormat` throws a
  wipe/restart message; no migration, dual-mode, or compatibility readers.
- Stamp `formatVersion: 4` on all new start/cursors/journal writes.
- Artifact `protocolVersion` for published ballots remains **1**.

### State model

Add (names may match these shapes; schemas must be `.strict()`):

- `acceptedResponses[]` — agent intent records with
  `stepId`, `agent`, `actionId`, `round`, `responseSha256`, `choice` or
  `disposition`, `rationale`, `acceptedAt`.
- `ballotBatches[]` — publication history (not only latest), each with
  `kind` (`plan-ballot-batch` | `comparison-ballot-batch` |
  `consensus-ballot-batch`), `round`, `inputSetHash`, `responseSha256s`,
  `branch`, `parentSha`, `commitSha`, `status`
  (`pending` | `published` | `failed`), `attempts`, `error`.
- Journal: `response-accepted`; batch pending/published/failed events as needed
  for status/analytics.

Keep `AcceptedSubmission` for Git-published steps only. Machine denominator and
derive helpers for ballot gates read **accepted responses** (and require a
successful published batch for that gate/round before derivation/advance).

### Evidence branch and batch commit

- Branch name: `issue-<n>/coordinator-evidence` (never an agent branch).
- Initialize from the issue `baselineSha` when the branch does not exist.
- One commit per completed active-roster denominator for a gate/round.
- Tree contains every canonical active ballot for that batch at the same repo
  relative paths used today for human auditability:

  - plan: `.plans/issue-<n>/ballot-<agent>.json`
  - comparison: `.code-reviews/issue-<n>/ballot-<agent>.json`
  - consensus: `.code-reviews/issue-<n>/consensus-ballot-<agent>-round-<r>.json`

- Canonical ballot JSON is coordinator-authored: existing ballot artifact fields
  plus `actionId` and `responseSha256` provenance. Citations and `inputSetHash`
  come from trusted state, not the response.
- Commit author/committer: dedicated coordinator identity (fixed name/email
  constants in code; not any agent identity).
- Message: deterministic, e.g. `Coordinator: publish <kind> evidence for issue <n>`
  (include round when consensus).
- Build the commit in the bare mirror via `hash-object` / `mktree` / `commit-tree`
  (or equivalent plumbing already used by the mirror). **Never** write agent
  clones or agent branches.
- Push with normal fast-forward only (`publishBranch` style `sha:refs/heads/...`);
  never `--force`.
- Persist exact `commitSha` while `status: pending`; retries push the same SHA;
  do not regenerate the commit or re-nudge agents.
- Gate derivation/advance runs only after origin publish succeeds and batch
  status is `published`.

### Derived decisions (#109 policy unchanged)

After successful publication:

- Plan gate → `derive-plan-selection` (plurality-active-roster-v1).
- Comparison gate → `derive-implementation-selection` (same).
- Consensus gate → escalate / revise / unanimous approve routing unchanged.

Derived records must cite accepted response digests **and** the published
evidence commit + paths. Do not recreate `R3.publish-selection`,
`R5.reviser-auth`, or `R6.declare`.

### Reporting and cleanup

- Retain evidence branch after normal completion; do not delete in finalization
  or ordinary wipe of product branches.
- Explicit owner deletion only (extend wipe/detach docs/commands as needed so
  default wipe of agent/`*-final` branches does not silently drop evidence
  without documenting the owner action).
- `coord status`, issue report, and final PR body name evidence branch + tip.
- Analytics: separate response-wait latency from coordinator publication latency.
- Final product PR remains deletion-clean `finalSha` only; ballots stay on the
  evidence branch.

### Privacy

Pending responses must not appear in peer actions, ordinary status output, logs
that other agents see, or origin commits before the gate closes. Protocol-level
secret-until-close; do not claim OS isolation.

## Exact File List to be changed or deleted

- `src/state.ts` — bump `RUNTIME_FORMAT_VERSION` to `4`; set
  `LEGACY_RUNTIME_FORMAT_VERSION` to `3` with an updated wipe message; add
  accepted-response, ballot-batch, and journal schemas; extend `CursorsState`
  (and writers) without migrating v3 payloads.
- `src/paths.ts` — add confined helpers for
  `agents/<agent>/responses/<actionId>.json` and coordinator-owned accepted
  response archive paths under the issue runtime; keep `assertNoSymlink` /
  `containedPath` guarantees.
- `src/protocol.ts` — add strict private response schemas; extend published
  plan/comparison/consensus ballot schemas with `actionId` + `responseSha256`
  (keep `protocolVersion: 1`); reject agent-supplied envelope fields on the
  private schemas.
- `src/action.ts` — strict Git-vs-response public action variants; render
  response path + response completion instructions for ballot steps; parse
  completion as either Git SHA **or** `response <uuid>` (discriminate by
  current action mode, never accept a SHA for a response action or a response
  marker for a Git action); keep atomic write helpers.
- `src/steps.ts` — ballot step definitions: stop treating repository
  `requiredPath` as the agent write target for ballots; carry evidence IDs /
  tasks that describe runtime response + coordinator publication; keep path
  helpers available for **canonical published** blob locations on the evidence
  branch.
- `src/orderScaffold.ts` — ballot scaffolds emit only the minimal response JSON
  (choice/disposition + rationale + actionId), not the full Git envelope.
- `src/evidence.ts` — ballot `evidenceId`s no longer validate agent-branch blobs
  via `readBlob(submissionSha, …)` as the acceptance path; Git-pin inspection
  for bound inputs remains. Canonical ballot byte checks move to post-publish
  verification against the evidence commit when needed.
- `src/machine.ts` — ballot completeness / derive triggers use accepted-response
  coverage plus published-batch barrier; preserve escalate/revise/unanimous and
  owner-question behavior from #109.
- `src/runLoop.ts` — tick path for response actions; accept/archive/journal;
  batch outbox build+push before `applyDerived*`; stop creating ballot
  `AcceptedSubmission` rows; update `buildOrder` / `deriveBoundInputs` /
  drop-rederive / status surfaces; separate analytics hooks for response vs
  publication wait; keep R7 `-final` publication unchanged in role.
- `src/mirror.ts` — add plumbing to create a commit in the bare mirror from a
  parent SHA + path/content map (no worktree required for the happy path);
  reuse fast-forward `publishBranch`; helpers to resolve/create
  `issue-<n>/coordinator-evidence` from baseline.
- `src/cli.ts` — optional `coord respond` that atomically writes response +
  marker with the same validation bounds; update status printing for evidence
  branch/tip and response-wait; ensure drop/answer/restart-action paths clear or
  ignore stale response files correctly; help text.
- `src/analytics.ts` — report response latency and evidence-publication latency
  as distinct intervals (journal events must make this possible).
- `src/issueReport.ts` — include evidence branch and latest tip in the human
  report.
- `src/finalization.ts` / `src/wipeIssue.ts` / related cleanup — final product
  branch stays ballot-free; default cleanup retains
  `issue-<n>/coordinator-evidence`; document/implement explicit owner deletion
  only (do not silently `push :branch` the evidence ref during ordinary wipe
  unless the owner opts in).
- `src/agentLanguage.ts` — ballot subjects/instructions match response mode.
- `docs/coord-driver.md` — workflow truth: response `complete` + accepted
  response for ballot intent; published evidence batch + derived state for
  advance; evidence branch retention; format-4 wipe.
- `docs/setup-workspace.md` — mailbox still holds `complete`, but ballot markers
  are `response <actionId>`; response files live under issue runtime agents/.
- `docs/repo-map.md` — note response paths, evidence branch, format 4.
- `docs/readiness-policy.md` / `docs/analytics.md` — ballot completion and
  latency semantics.
- `test/state.test.ts` — format-3 wipe; new schemas.
- `test/protocol.test.ts` — private response + extended published ballot
  schemas.
- `test/action.test.ts` — action union + completion discrimination.
- `test/paths.test.ts` — response/archive confinement and symlink rejection.
- `test/evidence.test.ts` — ballot acceptance no longer agent-SHA blob path;
  keep non-ballot evidence coverage green.
- `test/orderScaffold.test.ts` / `test/agentLanguage.test.ts` — response
  scaffolds.
- `test/machine.test.ts` — denominator + barrier before derive; escalate/revise
  unchanged.
- `test/runLoop.test.ts` — accept/reject/reissue; batch publish; no re-nudge;
  derive after publish; roster change pending vs published.
- `test/mirror.test.ts` — evidence commit author, parent, FF-only, retry same
  SHA.
- `test/cli.test.ts` — `respond` helper; status evidence fields; drop/answer
  with responses.
- `test/integration.test.ts` — full consensus path with response ballots and
  evidence commits.
- `test/analytics.test.ts` / `test/issueReport.test.ts` / `test/wipeIssue.test.ts`
  / `test/finalization.test.ts` — reporting and retention expectations.

No deletions of product `githooks/`. Do not bump `package.json` version on the
issue branch (post-merge CI bump per #108).

`AGENTS.md`: this clone keeps `skip-worktree` on the file. Do **not** clear that
bit. If tracked AGENTS wording still implies every automated action ends in a
Git SHA `complete`, escalate that doc edit to the owner rather than fighting
index flags; action.md text remains authoritative per action.

## Exact file list to be created

- `.plans/issue-110/plan.md` — this plan.
- `src/ballotResponse.ts` (or equivalently tight modules under existing files if
  a new file is unnecessary) — parse/validate private responses, hash, archive,
  completion-marker parse for `response <uuid>`. Prefer a focused module if
  `action.ts` / `runLoop.ts` would otherwise grow another large concern.
- `src/ballotEvidence.ts` — build canonical ballot JSON from trusted state +
  accepted responses; assemble batch commit contents; map batch kind → paths.
  May live in `mirror.ts` only if it stays small; otherwise keep publish
  orchestration out of `runLoop` god-file growth.
- `test/ballotResponse.test.ts` — unit coverage listed under Tests for parsing,
  bounds, confinement, stale markers.
- `test/ballotEvidence.test.ts` — canonical bytes, one-commit-for-N, FF retry,
  author identity.

(If implementers fold the two new `src/` modules into existing files, the test
files above still exist under those names or as clearly named suites in the
touched test files — do not drop coverage.)

## Tests

Commands (real, as declared in this repository):

- `pnpm check:fast` — lint, typecheck, fast tests (`verify.precommit`). Run
  before every commit.
- `pnpm check` — build + check:fast + e2e. Coordinator acceptance before PR.

Required coverage (unit + integration), mapping to issue acceptance:

1. Strict plan/comparison response parsing (eligible `choice`, required fields).
2. Strict consensus response parsing (`approve`/`revise`/`escalate`).
3. Action ID mismatch and path confinement rejection.
4. Stale completion marker / late response after action rotate rejected.
5. Malformed, partial, oversized, symlink, and non-file response rejection.
6. Ineligible choice and illegal disposition rejected.
7. Response digest (SHA-256 of exact bytes) + immutable archive round-trip.
8. Correction/reissue clears marker without false acceptance.
9. No peer disclosure of pending responses in rendered actions/status.
10. Active-roster denominator; dropped agents excluded without discarding
    already published batch history.
11. One canonical evidence commit for N plan responses; same for comparison;
    one per consensus round; cumulative FF history from baseline.
12. Exact canonical ballot bytes include citations, action IDs, response digests.
13. Coordinator commit author/committer identity; message shape.
14. Non-fast-forward push refused; transient fetch/push retries same persisted
    `commitSha` without regenerating or re-nudging.
15. No gate advancement / derive before `status: published`.
16. Plan and implementation tie-break after response-backed ballots (#109).
17. Revise, escalate, revision-limit, unanimous approve routing unchanged.
18. Roster change while batch pending vs after published.
19. Evidence branch retained through finalization; explicit owner deletion only.
20. Clean final PR branch excludes ballot evidence paths as product content.
21. Status / issue report / PR body reference evidence branch + tip.
22. Analytics separates response wait from publication latency.
23. Old runtime format 3 fails closed with wipe/restart remediation text.

Harness notes: integration fixtures that today write ballot JSON commits must
switch to writing runtime responses + markers and assert the coordinator
evidence branch tip.

## Alternatives Rejected

- **Keep agent Git ballots but shrink the JSON** — still N commits/pushes per
  gate; does not meet the mechanical-cost goal.
- **Coordinator invents votes** — violates non-goals; judgment must stay with
  agents.
- **Put responses in `complete` as JSON** — overloads the SHA mailbox; harder to
  confine and archive; issue specifies distinct response path + one-line marker.
- **Reuse `AcceptedSubmission` for responses** — collapses agent intent with Git
  publication provenance; issue forbids it.
- **Publish evidence on agent branches or into the product `-final` branch** —
  mixes identities and pollutes the PR.
- **Force-push or regenerate commits on retry** — loses idempotency and can
  discard or duplicate evidence.
- **Advance derive before origin publish** — loses the durability barrier the
  issue exists to create.
- **Migrate in-flight format-3 ballot submissions** — explicitly out of scope;
  wipe/restart only.
- **OS/cryptographic isolation claims** — protocol non-disclosure only under
  shared accounts.
- **Move plans/reviews/comparisons/implementations/finalize to responses** —
  out of scope for this issue.

## Risks and Mitigations

- **`runLoop.ts` complexity** — extract ballot response + evidence batch helpers;
  keep tick authority/`StateConflictError` patterns identical to Git accept.
- **Bare-mirror commit creation bugs** — unit-test tree contents and parent SHA;
  refuse push when `rev-list` shows non-FF; never fall back to agent worktrees.
- **Accepted responses stranded if publish loops forever** — pending batch state
  + status/error surfaces; retries are automatic but owner can abandon/wipe;
  do not re-nudge respondents.
- **Roster drop mid-ballot** — denominator uses active roster; published history
  retained; in-flight accepted responses for dropped agents ignored for
  remaining denominator without deleting published batches.
- **Skip-worktree `AGENTS.md`** — escalate owner edit if needed; action bodies
  carry the binding contract for agents.
- **Evidence branch growth** — acceptable; retention is intentional for audit.
- **Regression of #109 election policy** — reuse existing
  `deterministicWinner` / derive helpers; only change input source to accepted
  responses + published citations; keep machine tests for escalate/revise caps.

## Conclusion

Replace Git-committed ballot artifacts with action-scoped private runtime
responses (`choice`/`disposition` + `rationale` only), accept them into distinct
runtime state, and barrier each ballot gate on one coordinator-authored,
fast-forward-only evidence commit on `issue-<n>/coordinator-evidence` before
#109 derivation and advance. Bump runtime format to 4 and fail closed. Agents
keep read-only Git inspection of bound inputs and stop committing or pushing for
ballot phases.

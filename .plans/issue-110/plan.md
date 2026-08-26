# Issue 110: ballots submitted through private runtime; coordinator batch-publishes evidence

Ballot actions (`R3.plan-ballot`, `R5.compare-ballot`, every `R6.ballot` round)
stop being Git artifacts. Each agent writes one small JSON response into its own
runtime namespace plus an action-bound completion marker. When the active
denominator for a gate/round is complete, the coordinator canonicalizes the
ballots, creates exactly one commit on a coordinator-owned evidence branch,
pushes it fast-forward-only, and only then lets #109's deterministic derivation
run and the workflow advance.

Two design decisions the issue leaves to the implementation are settled here and
justified under Alternatives Rejected and Risks:

1. **Response path** is the agent's existing mailbox subtree,
   `<completesRoot>/issue-<n>/<agent>/responses/<action-id>.json`, not
   `<coordRoot>/issue-<n>/agents/<agent>/responses/`. The mailbox is the tree
   that already exists so an agent harness can write without holding a grant on
   coordinator state (`src/paths.ts` documents exactly this: `cursors.json`,
   `journal.jsonl`, and every peer's `action.md` live under the coord root).
   Granting every agent write access under `<coordRoot>/issue-N/agents/` would
   also hand every agent read access to peers' pending responses, which directly
   contradicts this issue's "no peer disclosure before the gate closes"
   requirement. The mailbox grant is already per agent
   (`<completesRoot>/issue-<n>/<agent>`), so the response path inherits the
   exact confinement the completion marker already has, with no new grant.
2. **Evidence branch** is `start.branchTemplate` rendered with the reserved
   agent token `coordinator-evidence` (default template yields
   issue-<n>/coordinator-evidence). `coord start` refuses a roster containing
   that id, so the branch can never equal an agent branch, and it is not an
   `<agent>-final` name, so it cannot collide with the product PR branch.

## Exact File List to be changed or deleted

- `src/steps.ts` — add `submissionMode: "git" | "response"` to `StepDefinition`
  and set it to `response` for `R3.plan-ballot`, `R5.compare-ballot`,
  `R6.ballot`; keep each ballot step's existing `requiredPath` but rename its
  role to the canonical coordinator publication path; add
  `RESERVED_EVIDENCE_AGENT = "coordinator-evidence"` and
  `evidenceBranchFor(branchTemplate, issue)`; extend `InternalOrder` with
  `submissionMode` and `responsePath: string | null`; add
  `ResponseObservation` (`agent`, `actionId`, `status`, `outstanding`,
  `responseSha256`, `choice?`, `disposition?`, `rationale?`); add
  `MachineDecision` variants `accept-response` and `publish-ballot-batch`.
- `src/paths.ts` — extend `AgentRuntimePaths` with `responsesDir` (under
  `completeDir`) and `acceptedResponsesDir` (under the coordinator-owned agent
  `root`); add `agentResponsePath(paths, agent, actionId)` and
  `acceptedResponseArchivePath(paths, agent, actionId)`, both validating the
  action id against the UUID pattern and both routed through `containedPath` +
  `assertNoSymlink`; create both directories in `createIssueRuntime` with mode
  `0o700`.
- `src/protocol.ts` — add `planComparisonBallotResponseSchema` (`actionId`,
  `choice`, `rationale`) and `consensusBallotResponseSchema` (`actionId`,
  `disposition`, `rationale`), both `.strict()`, with
  `rationaleSchema = z.string().min(1).max(2000)`; raise the three canonical
  ballot artifacts (`planBallotArtifactSchema`,
  `comparisonBallotArtifactSchema`, `consensusBallotArtifactSchema`) to
  `protocolVersion: z.literal(2)` and add required `actionId` (UUID) and
  `responseSha256` (`digestSchema`) fields; leave the four Git artifacts at
  `protocolVersion: 1`.
- `src/action.ts` — render and parse a strict two-variant action: Git actions
  keep `actionId`/`agent`/`requiredPath`; response actions carry
  `actionId`/`agent`/`submissionMode: response`/`responsePath` (absolute) and
  reject `requiredPath`, while Git actions reject `submissionMode` and
  `responsePath`; `PublicAction` becomes a discriminated union on
  `submissionMode`; `renderAction` emits the response body (write the response
  JSON, then write `response <action-id>` to the completion path, no
  commit/push sentence) for response orders; `parseCompletion` returns
  `{ status: "valid", kind: "sha", sha }` or
  `{ status: "valid", kind: "response", actionId }` and rejects any other
  single-line form.
- `src/evidence.ts` — delete the `plan-ballot-published`,
  `comparison-ballot-published`, and `consensus-ballot-published` branches of
  `evaluateEvidence` and their now-unused `citationsEqualInputs` ballot uses;
  `computeInputSetHash` stays and is reused by response batches.
- `src/orderScaffold.ts` — for the three ballot steps render only the response
  body (`actionId` plus `choice`/`rationale` or `disposition`/`rationale`) under
  a "Write this JSON to the response path" preamble; drop their artifact
  envelopes from `artifactScaffoldValue`.
- `src/state.ts` — `RUNTIME_FORMAT_VERSION` 3 → 4 with
  `LEGACY_RUNTIME_FORMAT_VERSION = 3` and the existing wipe/restart message
  text updated to name version 3; add `acceptedResponseSchema` (`stepId`,
  `agent`, `actionId`, `round`, `responseSha256`, `choice?`, `disposition?`,
  `rationale`, `acceptedAt`); add `ballotBatchSchema` (`kind` of
  `plan-ballot-batch` / `comparison-ballot-batch` / `consensus-ballot-batch`,
  `round`, `inputSetHash`, `responseSha256s`, `paths`, `branch`, `parentSha`,
  `commitSha`, `status` of `pending`/`published`/`invalidated`, `attempts`,
  `error`, `supersedes`); extend `cursorsStateSchema` with
  `responses: acceptedResponseSchema[]`, `ballotBatches: ballotBatchSchema[]`,
  and `evidence: { branch: string | null; tip: gitSha | null }`; add journal
  event types `response-accepted`, `ballot-batch-pending`,
  `ballot-batch-published`, `ballot-batch-failed`, `ballot-batch-invalidated`;
  seed the new fields in `initialCursors`; add
  `assertReservedAgentIdsUnused(roster)`.
- `src/mirror.ts` — extend `GitRunner` options with `env?: NodeJS.ProcessEnv`
  and thread it through `runGitCommand`; add `remoteTip(branch)` returning
  `{ ok: true; sha: string | null } | { ok: false; transient: boolean; error }`
  via `ls-remote`; add
  `createEvidenceCommit({ parentSha, files, message, identity })` which
  materializes a detached coordinator worktree from `parentSha` (or an empty
  tree for the first commit's parent when `parentSha` is the baseline), writes
  the canonical files, stages exactly those paths, commits with
  `-c user.name` / `-c user.email` set to the driver identity, returns the new
  SHA, and removes the worktree in a `finally`; reuse the existing
  `publishBranch` (already a non-forced `push <sha>:refs/heads/<branch>`) for
  fast-forward-only publication.
- `src/runLoop.ts` — in `buildOrder`, set `submissionMode` from the step
  definition and `responsePath` from `agentResponsePath`; in `runTick`, branch
  on the completion marker kind so a response marker runs the response
  acceptance sequence instead of `evaluateEvidence`; add `acceptResponse`,
  `publishBallotBatch`, and `invalidateStaleBatch` private methods; call the
  publication barrier before `applyDerivedPlanSelection`,
  `applyDerivedImplementationSelection`, `applyDerivedConsensus`, and before
  the `R6.ballot` → `R6.revise` advance; treat a transient publish/fetch
  failure as "keep pending, keep responses, do not re-nudge, return"; keep
  `deterministicWinner` and every `compute*Derived` function reading ballots —
  they read from `cursors.responses` for the ballot kinds instead of
  `cursors.accepted`.
- `src/machine.ts` — add `hasResponse(cursors, stepId, agent, round)` and use it
  for the three ballot steps in place of `hasAccepted`; emit `accept-response`
  for response observations; after a ballot denominator completes, emit
  `publish-ballot-batch` when no `published` batch exists for that
  gate/round/inputSetHash, and only then the existing
  `derive-*` / `advance-step` / escalation / revision-limit decisions; read
  `disposition` for the `R6.ballot` routing out of `cursors.responses`.
- `src/issueReport.ts` — add `Evidence branch:` and `Evidence tip:` lines and a
  `Ballot evidence: N commit(s)` line derived from published batches.
- `src/githubIssue.ts` — append the evidence branch and tip to the finalization
  PR body.
- `src/analytics.ts` — add `responseWaits` (`nudged` → `response-accepted`) and
  `publications` (`ballot-batch-pending` → `ballot-batch-published`) to
  `AnalyticsReport`, derive and render both as separate sections.
- `src/wipeIssue.ts` — keep the evidence branch by default: add it to the
  keep sets for both local and remote deletion, and delete it only when a new
  `deleteEvidence: boolean` option is true.
- `src/cli.ts` — add `coord respond` (flags `--issue`, `--agent`, `--choice`,
  `--disposition`, `--rationale`) which reads the agent's own `action.md`,
  refuses a Git-mode action, atomically writes the response to the action's
  `responsePath`, then writes the `response <action-id>` marker; add
  `--delete-evidence` to `wipe-issue`; register both in `booleanFlags` /
  `allowedFlags`.
- `src/doctor.ts` — report the evidence branch and its origin tip alongside the
  existing runtime checks.
- `AGENTS.md`, `templates/product/AGENTS.protocol.md`,
  `templates/product/AGENTS.md` — state that ballot actions are answered by
  writing the response file named in the action plus the completion marker, with
  no `git add`/`commit`/`push`, and that read-only inspection of the bound
  commits is still expected.
- `docs/coord-driver.md` — document the response submission mode, the response
  path, the completion-marker contract, the evidence branch and its retention,
  and the publication barrier.
- `docs/repo-map.md` — add the new modules.
- `docs/analytics.md` — document the two new latency sections.
- `test/action.test.ts` — strict Git/response front-matter parsing, cross-mode
  field rejection, response body rendering, `parseCompletion` marker kinds.
- `test/paths.test.ts` — response and archive path confinement, symlink
  rejection, invalid action id rejection, directory creation.
- `test/protocol.test.ts` — strict response schemas (unknown key, oversized
  rationale, empty rationale, wrong disposition, non-UUID `actionId`) and the
  protocolVersion-2 canonical ballot schemas.
- `test/state.test.ts` — format-version 3 rejection with the wipe message, new
  cursor fields round-trip, new journal event types.
- `test/machine.test.ts` — ballot satisfaction from responses, the
  `publish-ballot-batch` barrier before every derive/advance, escalate/revise/
  unanimous routing, revision-limit and tie-break behavior unchanged.
- `test/mirror.test.ts` — `remoteTip`, evidence-commit creation from a baseline
  parent, cumulative fast-forward commits, non-fast-forward push refusal,
  worktree cleanup.
- `test/evidence.test.ts` — the three ballot evidence branches are gone;
  `computeInputSetHash` unchanged.
- `test/runLoop.test.ts` — the full response acceptance and batch publication
  behavior listed under Tests.
- `test/analytics.test.ts` — the two new latency sections.
- `test/issueReport.test.ts` — evidence branch/tip lines.
- `test/wipeIssue.test.ts` — evidence branch retained by default, deleted only
  with the flag.
- `test/cli.test.ts` — `coord respond` success, wrong-agent refusal, Git-mode
  refusal, `--delete-evidence` plumbing.
- `test/integration.test.ts` — the four-agent canary answers the three ballot
  gates with responses instead of commits, and asserts one evidence commit per
  gate/round on the evidence branch with a clean final branch.
- `test/agentLanguage.test.ts` — the rendered response action and the updated
  prose files stay free of banned internal vocabulary.
- `package.json` — single pre-1.0 advance 0.0.23 → 0.0.24, made once on the
  PR-ready commit (not on ordinary issue-branch commits, which no suite gates on
  the version).

## Exact file list to be created

- `src/response.ts` — response file IO and acceptance primitives:
  `RESPONSE_MAX_BYTES = 8192`, `RATIONALE_MAX_CHARS = 2000`;
  `readAgentResponse(path)` returning
  `{ status: "missing" | "oversized" | "not-a-file" | "read" , bytes? }` after
  `assertNoSymlink` and an `lstat` regular-file check; `parseBallotResponse`
  dispatching on step kind through the `src/protocol.ts` schemas;
  `responseDigest(bytes)` (`sha256` over the exact accepted bytes);
  `archiveAcceptedResponse(paths, agent, actionId, bytes)` writing the archive
  with `wx` (so an existing archive is never overwritten) then fsync+rename;
  `clearAgentResponse(path)`; `writeAgentResponse(path, value)` for the
  `coord respond` helper (temp file + fsync + rename, mode `0o600`).
- `src/ballotEvidence.ts` — canonicalization and batch assembly:
  `canonicalBallotPath(stepId, issue, agent, round)`;
  `canonicalBallotBytes(...)` producing the protocolVersion-2 artifact with
  coordinator-derived `issue`, `issueSessionId`, `agent`, `artifact`,
  `actionId`, `responseSha256`, `inputSetHash`, citations built **only** from
  accepted Git evidence, plus the response's `choice`/`disposition` and
  `rationale`, serialized with sorted keys, two-space indent, and a trailing
  newline; `batchInputSetHash(responses)`;
  `buildBallotBatch({ stepId, round, responses, inputs, start, cursors })`
  returning the file set, digest list, hash, and commit message
  (`Coordinator: publish issue <n> <plan|comparison|consensus> ballot batch`,
  with ` round <r>` for consensus);
  `COORDINATOR_IDENTITY = { name: "coord coordination driver", email: "coord@localhost" }`.
- `test/response.test.ts` — unit coverage for every `src/response.ts` primitive.
- `test/ballotEvidence.test.ts` — byte-exact canonical ballot output, stable
  serialization across re-runs, citation derivation from Git evidence only,
  batch hash and commit-message shape.
- `.plans/issue-110/plan.md` — this plan.

## Tests

Run `pnpm check:fast` (lint, typecheck, fast tests) before every commit, and the
full `pnpm check` (build + `check:fast` + e2e) before publication.

Strict parsing and identity
- plan/comparison response: unknown key, missing `choice`, non-eligible
  `choice`, empty rationale, rationale over 2000 chars, non-UUID `actionId`,
  `actionId` for a previous action — each rejected with a concrete outstanding
  item and no accepted record.
- consensus response: `disposition` outside approve/revise/escalate rejected;
  agent-supplied `agent`, `issue`, `round`, `inputSetHash`, or citation fields
  rejected by `.strict()`.
- confinement: a `responsePath` outside the agent's mailbox subtree, a symlinked
  responses directory, a symlinked response file, a directory or FIFO at the
  response path, and a file over `RESPONSE_MAX_BYTES` are each refused before
  any parse.
- staleness: a completion marker naming a prior action id, a marker whose action
  id differs from the cursor's, a response whose `actionId` differs from the
  marker's, and a response written before the marker but for an action whose
  digest has since changed are all refused; the current action stays open.
- late write: a response appearing after acceptance and clearing does not
  produce a second accepted record.

Acceptance
- digest is computed by the coordinator over the exact accepted bytes; the agent
  never supplies one.
- an accepted response is archived under the coordinator-owned archive path, the
  working response and marker are cleared, and a re-run does not re-accept.
- archive write is idempotent: re-accepting the same action id does not
  overwrite an existing archive.
- `response-accepted` journal event carries the full bounded semantic response
  and the digest.
- a rejected response reissues the same action with concrete outstanding items,
  creates no Git commit and no accepted record, and accepts a corrected
  replacement.
- no peer disclosure: while a ballot gate is open, no other agent's `action.md`,
  `coord status`, `coord next`, or the issue report contains any pending peer
  response text.

Batch publication
- N plan responses produce exactly one commit; N comparison responses exactly
  one; each consensus round exactly one; commit count on the evidence branch
  equals the number of completed gates/rounds.
- canonical ballot bytes are exact and stable: same responses and same accepted
  Git evidence reproduce the identical tree.
- canonical ballots cite the bound plan/review, implementation, and revision
  commits taken from accepted Git evidence; a citation field present in the
  private response is ignored.
- commit author and committer are the driver identity, never a voting agent; the
  message names the coordinator and the gate/round.
- the first evidence commit descends from the issue baseline; later commits
  fast-forward from the persisted tip.
- an unexpected origin tip (someone else advanced the branch) fails closed as a
  publication conflict, keeps the batch pending, and never force-pushes.
- a transient fetch or push failure keeps the batch pending, keeps every
  accepted response, re-pushes the identical persisted commit SHA on the next
  tick, and produces no new nudge for an agent that already responded.

Barrier and routing
- no derived decision and no step advance happens while a batch is pending or
  failed, for all three gates and for the `R6.ballot` → `R6.revise` path.
- plan and implementation tie-break behavior, revise, escalate, revision-limit,
  and unanimous approval routing are unchanged from #109 with response-backed
  ballots.
- roster change while a batch is pending invalidates the pending batch, records
  `ballot-batch-invalidated`, and builds a new batch from the authoritative
  active response set; a roster change after a batch was published retains that
  commit in history and publishes a superseding batch with `supersedes` set.
- a dropped agent's pending response and marker are cleared and excluded from
  the denominator.

Retention and reporting
- normal issue cleanup and `coord wipe` retain the evidence branch locally and
  on origin; `--delete-evidence` removes it.
- the final product branch and PR contain no ballot evidence paths.
- `coord status`, the issue report, and the PR body name the evidence branch and
  tip.
- analytics reports response latency and publication latency as separate
  sections.
- a runtime state file at format version 3 is rejected with the wipe/restart
  message and no compatibility path.

End-to-end
- `test/integration.test.ts` four-agent canary: agents answer all three ballot
  gates with responses and zero ballot commits; the evidence branch accumulates
  one commit per gate/round; the workflow reaches finalization and the PR head
  is deletion-clean.

## Alternatives Rejected

- **Responses under `<coordRoot>/issue-<n>/agents/<agent>/responses/`** (the
  issue's representative path). Rejected because agent harnesses are granted
  the mailbox subtree specifically so they never hold a write grant on the coord
  root, which holds `cursors.json`, `journal.jsonl`, and every peer's
  `action.md`. Granting that tree would let each agent read peers' pending
  responses, defeating this issue's own secret-until-close requirement. The
  mailbox subtree is the same "configured runtime namespace, outside every Git
  clone" with per-agent confinement already in place.
- **Overloading `requiredPath` with an absolute runtime path.** Rejected because
  `repositoryPathSchema` forbids absolute paths and because a single field would
  make the Git/response distinction inferable rather than declared; the issue
  asks for a strict action union.
- **Making the agent compute and copy the response digest.** Rejected: it
  re-adds the mechanical work this issue removes and gives an untrusted party a
  say in the integrity value.
- **One evidence commit per accepted response.** Rejected: the whole point is
  one commit per completed gate/round.
- **Reusing an agent branch, or the final branch, for evidence.** Rejected: it
  would mix coordinator publication provenance into agent history and would put
  ballot evidence into the product PR.
- **Regenerating the commit on publish retry.** Rejected: commit metadata is in
  the SHA, so a regenerated commit is a different object; the durable outbox
  must re-push the exact persisted SHA.
- **Force-push or a lease push to resolve a non-fast-forward.** Rejected: the
  issue requires fail-closed and normal fast-forward only.
- **Migrating existing ballot artifacts or dual-accepting Git ballots.**
  Rejected: the issue is explicitly new-workflow-only; the runtime format bump
  fails closed with wipe/restart remediation instead.
- **Storing accepted responses in `cursors.accepted` as `AcceptedSubmission`.**
  Rejected: it would erase the distinction between agent intent and coordinator
  publication that the issue requires.
- **Deriving the evidence branch from a fixed literal name.** Rejected: branch
  templates are configurable, so the name must be rendered from the same
  template with a reserved agent token, and `coord start` must refuse a roster
  that uses that token.

## Risks and Mitigations

- **Same-user filesystem access.** Response privacy is a protocol property, not
  an OS or cryptographic one; agents run under one account. Mitigation: state
  this plainly in `docs/coord-driver.md` and in the PR body, keep the per-agent
  mailbox grant so no *instructed* path exposes a peer's pending response, and
  never render peer responses into any action, log, or status output.
- **A pending batch blocks the workflow.** Mitigation: pending is retried at the
  normal poll cadence with the identical persisted SHA, accepted responses are
  never discarded, agents are never re-nudged, and repeated failures surface in
  `coord status` and the journal with the branch, parent, and commit SHA.
- **Evidence branch name collision.** Mitigation: `coord start` rejects a roster
  containing the reserved id; the derived name is asserted different from every
  agent branch and every `<agent>-final` branch in `test/runLoop.test.ts`.
- **Worktree leakage from evidence-commit creation.** Mitigation: the worktree
  target is a `containedPath` under the issue runtime, removal runs in a
  `finally` with `removeWorktree` plus `rmSync`, and a test asserts no worktree
  remains after a failed commit.
- **Runtime format bump strands a live issue.** Mitigation: this is intended;
  the error names the exact `coord wipe <issue>` remediation, a test asserts the
  message, and the bump is documented in `docs/coord-driver.md`.
- **Rationale size.** A pathological rationale would bloat the journal and the
  evidence tree. Mitigation: 2000-character cap and an 8 KiB whole-file cap,
  both enforced before parsing and before journaling.
- **Roster change between freeze and push.** Mitigation: the batch records the
  roster snapshot and input-set hash it was built from; a mismatch at publish
  time invalidates the pending batch with a journal event and rebuilds it, and a
  batch already on origin is retained with an explicit `supersedes` link.
- **Loss of the ballot audit trail during the transition.** Mitigation: the
  canonical ballot paths and file names are unchanged, so anything reading
  `.plans/issue-<n>/ballot-<agent>.json` still finds the same shape at the same
  path — on the evidence branch rather than an agent branch.
- **Test surface is large.** Mitigation: the primitives live in two small new
  modules (`src/response.ts`, `src/ballotEvidence.ts`) with their own unit
  suites, so `test/runLoop.test.ts` only has to cover orchestration.

## Conclusion

Ballot actions become response actions: the agent writes
`{ actionId, choice | disposition, rationale }` to an action-scoped path in its
own mailbox subtree and a `response <action-id>` marker to the existing
completion path — no `git add`, `commit`, or `push`. The coordinator validates
strictly, hashes and archives the exact bytes, and holds the responses private
until the active denominator closes. It then canonicalizes every ballot with its
own bindings and citations, creates exactly one commit per gate/round on
issue-<n>/coordinator-evidence, pushes it fast-forward-only, and only after that
durable origin publication does #109's deterministic derivation run and the
workflow advance. The evidence branch is retained after cleanup and named in
status, the issue report, and the PR body; the product PR stays free of ballot
evidence.

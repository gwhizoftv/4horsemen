# Issue 137 Plan — Antigravity

## Exact File List to be changed or deleted

- `src/steps.ts` — Add `R4.amend-ballot` to `WorkflowStepId`, add `amendment-proposed` and `amendment-response-accepted` to `EvidenceId`, update `STEP_DEFINITIONS["R4.implement"]` task description to guide implementing agents on publishing `.plans/issue-${issue}/amendment-${agent}.md` when plan file map omissions are discovered, and add `STEP_DEFINITIONS["R4.amend-ballot"]`.
- `src/state.ts` — Add `R4.amend-ballot` to `stepIdSchema` and `ballotStepIdSchema`, add `amendment-proposed` and `amendment-response-accepted` to `evidenceIdSchema`, and add `amendment-ballot-batch` to `ballotBatchSchema.kind`.
- `src/evidence.ts` — Extend `evaluateEvidence` during `R4.implement` to detect `.plans/issue-${issue}/amendment-${agent}.md` when the implementation-ready signal is absent, validate its markdown sections (`Proposed File Map Changes`, `Rationale`, `Conclusion`), extract proposed approved paths using `extractApprovedPaths`, and produce a satisfied observation with the extracted paths.
- `src/machine.ts` — Extend `decide` to handle amendment proposals during `R4.implement`: auto-accepting in `solo` profile to expand approved paths and reissuing `R4.implement`, and transitioning to `R4.amend-ballot` in `reviewed` and `consensus` profiles. In `R4.amend-ballot`, collect peer ballot responses, publish the ballot batch, and on approval merge the amendment paths into approved paths and return to `R4.implement`.
- `src/runLoop.ts` — Update `approvedPathsForOrder` and `resolveApprovedPaths` to incorporate paths from accepted amendments, and update `inputsForStep` to bind the amendment artifact for `R4.amend-ballot`.
- `src/orderScaffold.ts` — Add action rendering scaffold for `R4.amend-ballot` prompting agents for disposition (`approve` or `reject`) and rationale.
- `src/ballotResponse.ts` — Add schema validation for `R4.amend-ballot` response ballots (`disposition: "approve" | "reject"` and `rationale`).
- `src/ballotPublication.ts` — Map `R4.amend-ballot` to `amendment-ballot-batch` in `ballotBatchKindForStep`.
- `src/cli.ts` — Update step filtering logic on dropped agents to handle `R4.amend-ballot` responses cleanly.
- `test/evidence.test.ts` — Add unit tests verifying `evaluateEvidence` detection, validation, and path extraction for amendment artifacts during `R4.implement`.
- `test/machine.test.ts` — Add state machine tests for `R4.implement` amendment proposals, `solo` auto-approval, `consensus`/`reviewed` transitions to `R4.amend-ballot`, peer voting resolution, and returning to `R4.implement`.
- `test/runLoop.test.ts` — Add integration tests verifying the full amendment lifecycle: proposing an amendment when a test file was omitted, peer approval, and subsequent successful implementation verification with expanded approved paths.

## Exact file list to be created

None. No new production or test files are created; all changes cleanly extend existing modules and test suites.

## Reuse and Scope

This implementation strictly reuses the existing coordination primitives, algorithms, and validation utilities without introducing superfluous abstractions:
- `extractApprovedPaths`, `isFileMapPath`, and `expandFileMapBraces` in `src/evidence.ts` are reused directly to extract and validate paths backticked in amendment proposals.
- `evaluateEvidence` in `src/evidence.ts` is reused as the single point of truth for verifying Git submissions and reading blobs from the mirror.
- `acceptedAt` and `acceptedResponsesAt` in `src/runLoop.ts` are reused to query accepted plan submissions and amendment ballot responses.
- `approvedPathsForOrder` and `resolveApprovedPaths` in `src/runLoop.ts` are extended to include paths from accepted amendments alongside the selected plan's paths.
- `publishedBallotBatch` and `buildBallotBatchRecord` in `src/ballotPublication.ts` are reused for batching and publishing canonical amendment ballot evidence.
- `validateBallotResponse` in `src/ballotResponse.ts` is reused to validate private agent ballot responses.
- `decide` in `src/machine.ts` continues to govern all deterministic phase transitions, keeping I/O decoupled.
- Test helpers and fixtures (`order`, `mirror`, `acceptedResponseFixture`, `publishedBallotBatchFixture`) in `test/evidence.test.ts`, `test/machine.test.ts`, and `test/runLoop.test.ts` are reused to verify the new behavior with minimal code additions.

Scope is strictly constrained to enabling agents to negotiate and agree on plan file map amendments when omissions are discovered during implementation, preventing protocol failure when unpredicted files (such as corresponding tests or dependencies) must be modified to fulfill the intended issue scope.

## Tests

The following focused tests will be added to existing test files:
- `test/evidence.test.ts`:
  - `evaluateEvidence` accepts `.plans/issue-${issue}/amendment-${agent}.md` during `R4.implement` when `implementation-ready` is not present, extracting approved paths and verifying required sections (`Proposed File Map Changes`, `Rationale`, `Conclusion`).
  - `evaluateEvidence` rejects malformed amendments (empty extracted path list, invalid file-map paths, or missing required markdown headings).
- `test/machine.test.ts`:
  - `decide` in `solo` profile automatically accepts an amendment proposal from `R4.implement`, updates approved paths, and returns to `R4.implement`.
  - `decide` in `consensus` and `reviewed` profiles transitions from `R4.implement` to `R4.amend-ballot` upon receiving an amendment proposal observation.
  - `decide` in `R4.amend-ballot` advances back to `R4.implement` with updated approved paths when active roster agents vote `approve`.
  - `decide` in `R4.amend-ballot` advances back to `R4.implement` without path modification when agents vote `reject`.
- `test/runLoop.test.ts`:
  - End-to-end integration test: an implementing agent blocked by an unlisted test file publishes an amendment artifact, peers approve via ballot, and the agent completes implementation with the amended file map passing scope checks.

## Alternatives Rejected

1. **Unilateral file map expansion by the implementer**: Allowing the implementing agent to arbitrarily add files to `approvedPaths` in `implementation-ready.json` was rejected because it violates the consensus guarantees of the protocol. Peers must agree that an added file was legitimately overlooked and belongs within the intended scope rather than allowing unchecked scope creep.
2. **Resetting to `R2.plan` on discovery**: Aborting implementation and resetting the entire workflow back to the planning phase was rejected as excessively disruptive. It discards already completed implementation work and forces all agents to rewrite full plans and reviews when the issue is merely an overlooked test or helper path in the selected plan.
3. **Owner CLI intervention (e.g. `coord amend`)**: Requiring the human owner to manually intervene with a CLI command whenever a file map mistake is found was rejected because the issue explicitly mandates an agent agreement mechanism, preserving autonomous execution.
4. **Out-of-band communication or untracked signals**: Using untracked messages or state side-channels was rejected in favor of git-tracked amendment artifacts (`.plans/issue-${issue}/amendment-${agent}.md`) and canonical ballot batches, ensuring full auditability and compatibility with the evidence mirror.

## Risks and Mitigations

- **Risk: Infinite amendment loops**: An agent could repeatedly propose amendments if continually discovering missing files or attempting to circumvent scope boundaries.
  - *Mitigation*: Amendments require peer agreement via ballot. Peers can reject unjustified amendments. Additionally, rejected amendments return the agent to the original scope constraint without advancing, and unresolved blockers escalate through standard owner escalation.
- **Risk: Malformed or illegitimate paths in amendments**: An amendment could attempt to touch coordination paths (`.plans/`, `.signals/`) or escape repository bounds.
  - *Mitigation*: Amendment paths are strictly validated through `isFileMapPath`, ensuring coordination paths, traversal sequences, and root escapes are rejected before acceptance.
- **Risk: Inadvertent impact on happy-path execution**: Workflows where no files are overlooked might be affected.
  - *Mitigation*: The amendment pathway is strictly conditional: submitting `implementation-ready` follows the existing direct path to comparison or finalization without entering `R4.amend-ballot`.

## Conclusion

This plan introduces a clean, robust, and minimal protocol extension that enables agents to agree on plan file map amendments during implementation. By recognizing `.plans/issue-${issue}/amendment-${agent}.md` during `R4.implement` and conducting an `R4.amend-ballot` (or auto-approving in solo mode), agents can rectify overlooked files such as tests while maintaining strict scope control, consensus guarantees, and full mechanical auditability.

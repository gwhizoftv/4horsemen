# Issue 254 Plan: Keep verified containment status on completed issues and after SessionEnd

## Exact File List to be changed or deleted

- `src/agentLifecycle.ts`
  - In `applyLifecycleObservation`, preserve `entry.containment` when `observation.kind === "session-end"` for the same session (`containment: sessionChanged ? null : entry.containment`), clearing recorded containment only when `sessionChanged` is `true` (a replacement session starts).
- `src/issueReport.ts`
  - In `renderIssueReport`, gate `uncertain` on `!cursors.completed` so completed issues do not downgrade the top-level `[OK] Issue <n>: complete` cue to `[WARN]` due to post-run agent health or containment state.
  - In `renderIssueReport`'s per-agent lifecycle loop, pass `undefined` instead of the live clone disk policy binding (`containmentPolicy(agent.root, agent.id)?.binding ?? null`) into `containmentCoverage(entry, ...)` when `cursors.completed` is `true`, so completed issues rely on the corroborated in-run probe (`denial.binding === probe.binding`) rather than invalidating historical runs when on-disk hook policies later change.
- `test/agentLifecycle.test.ts`
  - Update the containment lifecycle test to verify that `applyLifecycleObservation` with `kind: "session-end"` preserves a corroborated `hook-denied` containment record (`containmentCoverage(..., digest).hook === "active"`), while a subsequent replacement `session-start` with a new `sessionId` still clears `containment` to `null`.
- `test/issueReport.test.ts`
  - Extend the report test suite to verify that a completed issue renders `[OK] Issue 1: complete` and `containment hook=active` without a `runtime hook trust/activity not yet verified` warning after `SessionEnd` and when the agent clone's live on-disk policy binding differs from the corroborated historical probe binding, while an in-progress issue (`completed: false`) still reports `[WARN]` when the live disk binding does not match.

## Exact file list to be created

None. No new files will be created.

## Reuse and Scope

- **Reused functions and types**:
  - `applyLifecycleObservation`, `containmentCoverage`, `initialAgentLifecycle`, `AgentLifecycleEntry`, and `AgentLifecycleState` in `src/agentLifecycle.ts`.
  - `renderIssueReport` in `src/issueReport.ts` and `containmentPolicy` in `src/shellGuard.ts`.
  - Existing test helpers `entry`, `now`, `later`, and `digest` in `test/agentLifecycle.test.ts`.
  - Existing test fixtures `start` and `complete` in `test/issueReport.test.ts`.
- **New files justification**:
  - No new files, abstractions, or dependencies are introduced; all changes fit directly into the existing lifecycle reducer, status report renderer, and their corresponding unit test files.

## Tests

- `test/agentLifecycle.test.ts`:
  - Extend `"requires a tool-result observation plus a probe denial, and invalidates session/config changes"` to apply `{ kind: "session-end", eventName: "SessionEnd", sessionId: "s" }` after a corroborated `hook-denied` probe and assert that `ended.containment` is preserved and `containmentCoverage(ended, digest)` returns `{ hook: "active", shim: "unverified" }`, before verifying that `{ kind: "session-start", eventName: "SessionStart", sessionId: "next" }` clears `containment` to `null`.
- `test/issueReport.test.ts`:
  - Add a focused test in `describe("issue report")` that constructs a corroborated `hook-denied` lifecycle entry, applies `SessionEnd` (`applyLifecycleObservation`), and verifies that `renderIssueReport(start("coord-merged"), complete(), lifecycle)` renders `[OK] Issue 1: complete` and `containment hook=active` (with no `runtime hook trust/activity not yet verified` warning) even though `/c` on disk does not match the historical probe binding, whereas an incomplete cursor state (`{ ...complete(), completed: false }`) with the same mismatched disk binding renders `[WARN]` and `containment hook=unverified`.
- Verification commands during implementation:
  - `pnpm vitest run test/agentLifecycle.test.ts test/issueReport.test.ts`

## Alternatives Rejected

- **Persisting the historical clone policy binding in `start.json` or `cursors.json`**:
  - Rejected because `entry.containment` already records both `hookDenial.binding` and `probe.binding` from the session, and `containmentCoverage(entry, undefined)` already verifies `denial.binding === probe.binding`, `denial.policyRevision === probe.policyRevision`, `denial.sessionId === probe.sessionId`, and `denial.at <= probe.at`. No schema migration or extra state field is needed.
- **Skipping `containmentCoverage` binding checks for in-progress issues**:
  - Rejected because an active, in-progress issue must still detect if the clone's live hook policy on disk drifted from the session's probed policy. Only completed issues (`cursors.completed === true`) should skip live disk binding re-validation.

## Risks and Mitigations

- **Risk**: A replacement session starting after `SessionEnd` could inherit stale containment from the exited session.
  - **Mitigation**: `applyLifecycleObservation` computes `sessionChanged = incomingSession !== null && entry.sessionId !== null && incomingSession !== entry.sessionId`. Because `session-end` keeps `entry.sessionId`, any subsequent `session-start` or `status` with a new `sessionId` sets `sessionChanged = true` and clears `containment` to `null`.
- **Risk**: Completed issues with failed publication or active holds might erroneously show `[OK]` instead of `[ACTION]`.
  - **Mitigation**: `needsAction` takes precedence over `uncertain` and `cursors.completed` in `const cue = needsAction ? "[ACTION]" : uncertain ? "[WARN]" : cursors.completed ? "[OK]" : "[WAIT]"`, so `[ACTION]` is preserved whenever `needsAction` is true.

## Conclusion

Preserving `entry.containment` across `session-end` for the same session in `src/agentLifecycle.ts` and avoiding live disk binding invalidation and post-completion `[WARN]` downgrades when `cursors.completed` is `true` in `src/issueReport.ts` cleanly resolves the false containment warnings on completed issues with minimal, focused changes.

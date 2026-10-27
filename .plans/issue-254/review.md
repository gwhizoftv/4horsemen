# Issue 254 Plan Review

Reviewed plans:
- `muse` (`8ea5f65dd9cf9321ab3a1a9467bea19d7db0afa4`) at `.plans/issue-254/plan.md`
- `claude` (`46d506425be4ec2fb9ff6207fd7276c8e7c86e20`) at `.plans/issue-254/plan.md`
- `antigravity` (`61adde90c2fd4cf2f0a7b7b87176b9b35ccd456b`) at `.plans/issue-254/plan.md`
- `codex` (`f88e18d0584622bc231dad87277aa19ed58cc943`) at `.plans/issue-254/plan.md`

## Findings

1. **Plan claim or section**: `muse` (`8ea5f65dd9cf9321ab3a1a9467bea19d7db0afa4`), `## Exact File List to be changed or deleted` (`test/agentLifecycle.test.ts`, lines 50–57) and `## Tests` (lines 106–114); and `antigravity` (`61adde90c2fd4cf2f0a7b7b87176b9b35ccd456b`), `## Tests` (`test/agentLifecycle.test.ts`, lines 31–32) — flipping the existing line-85 `session-end` assertion in `test/agentLifecycle.test.ts` and asserting `containmentCoverage(ended, digest).hook === "active"`.
   - **Rule that must hold**: `containmentCoverage` requires `probe.vendorVersion !== "unknown"` (`src/agentLifecycle.ts:57`) to report `hook: "active"`.
   - **Concrete failure if followed as written**: In `test/agentLifecycle.test.ts`, line 80 mutates `current.containment.probe.vendorVersion = "unknown"` in place before line 85. Flipping line 85 in place without either running the `session-end` assertion before line 80 or restoring `vendorVersion` to `"1.2.3"` causes `containmentCoverage(ended, digest).hook` to return `"unverified"` instead of `"active"`, failing the test.
   - **Smallest correction**: Run the `session-end` preservation and `containmentCoverage(ended, digest)` assertions before line 80 mutates `current.containment.probe.vendorVersion = "unknown"` (or restore `vendorVersion = "1.2.3"` first), as `claude` and `codex` specify.

2. **Plan claim or section**: `claude` (`46d506425be4ec2fb9ff6207fd7276c8e7c86e20`), `## Tests` item 2 (`test/issueReport.test.ts`, lines 117–137) — testing `"keeps a completed issue [OK] with in-run containment after session end and binding drift"` by constructing `lifecycle = initialAgentLifecycle(["cursor"], at)` with `sessionId: "s"`, `health: "healthy"`, and corroborated `containment`, and then rendering `complete()`, `health: "degraded"`, and `completed: false`.
   - **Rule that must hold**: Per issue requirement 3, `test/issueReport.test.ts` must verify that a completed issue renders `[OK]` even if the session ends (`SessionEnd`) or the clone's on-disk policy binding later changes.
   - **Concrete failure if followed as written**: The steps listed in `claude`'s `test/issueReport.test.ts` case never apply a `session-end` observation (`applyLifecycleObservation(..., { kind: "session-end", ... })`) to the lifecycle entry before calling `renderIssueReport`, so `test/issueReport.test.ts` would not test report rendering after a `SessionEnd` event.
   - **Smallest correction**: Pass the seeded lifecycle entry through `applyLifecycleObservation(entry, { kind: "session-end", eventName: "SessionEnd", sessionId: "s" }, at)` and assert that `renderIssueReport` still renders `[OK] Issue 1: complete` and `containment hook=active`.

3. **Scope, reuse, new files, and test focus evaluation across all plans**:
   - All four plans stay strictly within the issue scope (`src/agentLifecycle.ts`, `src/issueReport.ts`, `test/agentLifecycle.test.ts`, and `test/issueReport.test.ts`), create no new product or test files, and preserve `containmentCoverage` and live-run checks in `src/runLoop.ts` and `src/shellGuard.ts`.
   - `claude`, `muse`, and `antigravity` reuse the existing pure in-memory fixtures in `test/issueReport.test.ts` (`start()` with non-existent root `/c` where `containmentPolicy` returns `null`), whereas `codex` proposes creating temporary on-disk shim and hook-settings files in `test/issueReport.test.ts` (`## Reuse and Scope`, lines 26–28; `## Tests`, line 37). While `codex`'s plan is mechanically sound and self-contained, in-memory fixtures already exercise the `containmentCoverage` binding parameter in `renderIssueReport` without filesystem setup/teardown.

## Conclusion

`claude` (`46d506425be4ec2fb9ff6207fd7276c8e7c86e20`) and `codex` (`f88e18d0584622bc231dad87277aa19ed58cc943`) both accurately account for the in-place `vendorVersion = "unknown"` mutation in `test/agentLifecycle.test.ts`, and `codex`, `muse`, and `antigravity` explicitly cover the post-`SessionEnd` report assertion in `test/issueReport.test.ts`. Any of the four plans is viable once the two test ordering/coverage details in Findings 1 and 2 are respected.

# Issue 254 — Keep verified containment status on completed issues and after SessionEnd

Stop two false `[WARN]` downgrades on finished issues: `SessionEnd` must not
erase a corroborated containment record for the same session, and a completed
issue's report must not re-validate that historical record against the clone's
current on-disk policy binding. Live (non-completed) reporting and probe
ingest keep their current strict checks unchanged.

## Exact File List to be changed or deleted

- `src/agentLifecycle.ts`
  - In `applyLifecycleObservation` (currently line 567), change
    `containment: sessionChanged || observation.kind === "session-end" ? null : entry.containment`
    to `containment: sessionChanged ? null : entry.containment`.
    This is the only production change in this file. `session-end` keeps its
    other effects exactly as today: `toolActivity.pending` is still zeroed via
    `endsTools` (line 559), health is still set to `healthy`, and `sessionId`
    is still retained when the event carries none (line 533), so
    `containmentCoverage` still matches `probe.sessionId === entry.sessionId`
    after the session ends. A `session-start`/`status` event carrying a
    different session still sets `sessionChanged` and therefore still clears
    containment, and events from retired sessions are still ignored (line 512).
- `src/issueReport.ts`
  - Add one module-local helper used by both containment call sites in
    `renderIssueReport`, e.g.
    `const coverageFor = (entry, root, id, completed) => containmentCoverage(entry, completed ? undefined : root === undefined ? null : containmentPolicy(root, id)?.binding ?? null)`.
    Passing `undefined` (not `null`) matters: in `containmentCoverage`
    (`src/agentLifecycle.ts` line 49) only `undefined` skips the
    `probe.binding !== binding` check, while `null` fails it.
  - Top-level cue (currently lines 94–100): compute `uncertain` through
    `coverageFor(...)` and additionally gate it with `!cursors.completed`, so
    a completed issue is never downgraded from `[OK]` to `[WARN]` by
    post-run agent health or containment state (including a missing lifecycle
    entry). The cue precedence `needsAction ? [ACTION] : uncertain ? [WARN] : cursors.completed ? [OK] : [WAIT]`
    is otherwise unchanged, so holds/pauses on a completed issue still surface
    as `[ACTION]`.
  - Per-agent lines (currently lines 233 and 247): compute `coverage` through
    the same `coverageFor(...)`, so on a completed issue an agent whose probe
    corroborated during the run (`denial.binding === probe.binding`, already
    enforced inside `containmentCoverage`) still renders
    `containment hook=active` and does not emit the
    `runtime hook trust/activity not yet verified` warning even if the clone's
    disk binding later changed or the session ended. An agent with no
    corroborated probe still renders `hook=unverified` plus the warning,
    including on completed issues.
  - The issue text names `renderAgentStatusLines`; no such function exists at
    the baseline — `renderIssueReport` holds both call sites above, and it is
    the only function changed in this file.
- `test/agentLifecycle.test.ts`
  - In the test `requires a tool-result observation plus a probe denial, and invalidates session/config changes`
    (line 65), flip the line-85 assertion: `applyLifecycleObservation(current, { kind: "session-end", eventName: "SessionEnd" }, later).containment`
    must now deep-equal `current.containment`, and `containmentCoverage(...)` on the
    result (with no binding argument and with the original `digest` binding)
    must still be `hook: "active"`. Keep the lines 82–84 assertions that a
    `session-start` with session `next` clears containment and yields
    `unverified`, and add the same-session variant
    (`{ kind: "session-end", sessionId: "s" }`) preserving containment.
- `test/issueReport.test.ts`
  - Extend the existing `complete()`/`start()` fixtures; add the cases listed
    under Tests below. No new fixture file.

No files are deleted.

## Exact file list to be created

- None. In particular no new source, helper, or test file: the report-side
  helper is module-local to `src/issueReport.ts`, and both test additions join
  the existing test files named above. (This plan file itself,
  `.plans/issue-254/plan.md`, is the coordination artifact for the planning
  action, not an implementation-created file.)

## Reuse and Scope

- Reuses `containmentCoverage(entry, binding?)` from `src/agentLifecycle.ts`
  unchanged — its existing corroboration rule (`hookDenial.probe === true`,
  matching `sessionId`/`binding`/`policyRevision`, `denial.at <= probe.at`,
  `toolResult === "hook-denied"`, non-`unknown` vendor version) is exactly the
  "already corroborated during the run" predicate requirement 2 asks for, so
  no new validation logic is introduced.
- Reuses `containmentPolicy(root, id)` from `src/shellGuard.ts` unchanged for
  all non-completed reports, and reuses the existing `start()` / `complete()`
  fixtures and `initialAgentLifecycle` in `test/issueReport.test.ts` plus the
  `identity` / `denial` / probe fixture pattern in `test/agentLifecycle.test.ts`.
- Explicitly out of scope and unchanged: `src/runLoop.ts` `reportStartup`
  (line 1084) and the R1.join acceptance journal (line 2105), which are
  live-run checks where comparing against the current disk binding is
  correct; `src/shellGuard.ts` probe ingest (line 357), which must keep
  rejecting probes whose binding no longer matches at ingest time;
  `recordContainmentEvidence`, the `containmentSchema` /
  `agentLifecycleEntrySchema` shapes, and `agent-lifecycle.json` persistence —
  no schema or format-version change, because preserved containment already
  round-trips through the existing nullable field.
- Every path the implementation may change also appears in the
  changed-or-deleted list above: `src/agentLifecycle.ts`,
  `src/issueReport.ts`, `test/agentLifecycle.test.ts`,
  `test/issueReport.test.ts`.

## Tests

All cases extend existing files, fail before the change, and pass after it.
Run focused: `pnpm exec vitest run --config vitest.config.ts test/agentLifecycle.test.ts test/issueReport.test.ts`;
the commit/push hooks own `pnpm check:fast` (lint, typecheck, fast tests),
and the coordinator owns the final suite at the approved pin — no manual
duplicate of `check:fast` immediately before committing.

- `test/agentLifecycle.test.ts` (joins `requires a tool-result observation plus a probe denial, and invalidates session/config changes`):
  after building the corroborated `hook-denied` probe on session `s`
  (coverage `active` with binding `digest`), applying
  `{ kind: "session-end", eventName: "SessionEnd" }` (and again with
  `sessionId: "s"`) leaves `containment` equal to the pre-end record and
  `containmentCoverage(result).hook === "active"`. Fails before (returns
  `null` / `unverified`); the neighbouring `session-start` session-`next`
  assertions keep passing both before and after, proving supersession still
  clears.
- `test/issueReport.test.ts` (new cases in `describe("issue report")`, built
  from `initialAgentLifecycle(["cursor"])` with `sessionId: "s"`,
  `health: "healthy"`, and a containment probe mirroring the lifecycle
  fixture: `hookDenial { sessionId: "s", policyRevision: "policy", binding: digest, at, probe: true }`,
  `probe { ..., vendorVersion: "1.2.3", toolResult: "hook-denied", shim: "active" }`):
  1. Completed renders verified: `renderIssueReport(start("coord-open-unmerged"), complete(), lifecycle)`
     contains `[OK] Issue 1: complete` and `containment hook=active`, and
     does not contain `runtime hook trust/activity not yet verified`. The
     fixture root `/c` makes `containmentPolicy` return `null`, so before
     the change the `null` live binding already yields `unverified` /
     `[WARN]`; this is the drift simulation (probe binding `digest` vs.
     whatever the disk now reports).
  2. Session-ended completed renders verified: first pass the same entry
     through `applyLifecycleObservation(entry, { kind: "session-end", eventName: "SessionEnd", sessionId: "s" }, later)`,
     then render the completed report and assert the same `[OK]` /
     `hook=active` outcome. Fails before on both mechanisms at once.
  3. Live control (must pass before and after): the identical lifecycle with
     `complete()` mutated to `completed: false` still renders `[WARN]` and
     the `not yet verified` warning, proving the relaxation is scoped to
     completed issues only and is not a blanket suppression.
  4. Never-probed completed control: `initialAgentLifecycle(["cursor"])`
     unmodified on a completed issue still prints
     `containment hook=unverified` and the warning line (top-level cue is
     still `[OK]` once case-by-case per-agent text is excluded — assert the
     first status line only), proving no probe is ever inferred from
     installation.

## Alternatives Rejected

- Clear containment on `session-end` but re-derive it from a persisted copy
  (new field or side store): rejected — a second source of truth for the same
  fact; simply not clearing is smaller and keeps one record. The record is
  already session-bound, so a replacement session supersedes it via the
  existing `sessionChanged` path.
- Change `containmentCoverage` itself to ignore the binding argument or to
  treat `null` as "skip check": rejected — `src/runLoop.ts` and
  `src/shellGuard.ts` rely on strict live-binding comparison during a run;
  weakening the shared predicate would mask genuine mid-run policy drift.
  Scoping the relaxation to the completed-issue report keeps live semantics.
- Suppress only the top-level cue and keep passing the live binding for
  per-agent lines: rejected — the completed report would still print
  `runtime hook trust/activity not yet verified` for `claude`/`codex`, which
  is half of the false warning named in the issue.
- Persist the run-time disk binding into cursors/lifecycle and compare
  against that snapshot forever: rejected — unnecessary state and migration;
  corroboration inside `containmentCoverage` already proves
  `denial.binding === probe.binding` held during the run.
- Touch `src/runLoop.ts` startup/join reporting for consistency: rejected —
  those run while containment is still a live risk; the issue scopes the
  report fix to completed issues in `src/issueReport.ts`.

## Risks and Mitigations

- Preserved containment could look current for a session that ended long
  ago. Mitigation: `containmentCoverage` still requires
  `probe.sessionId === entry.sessionId`; any new session supersedes and
  clears via `sessionChanged`, and per-agent lines still print the probe's
  `session=`/`policy=`/timestamp, so the record reads as historical.
- A `session-end` event with no `sessionId` (the claude/codex `SessionEnd`
  hook shape) must not retire or replace the session. It does not today:
  `sessionId` falls back to `entry.sessionId` (line 533) and
  `retiredSessionIds` only grows on `sessionChanged`; the new test covers
  both the no-id and same-id shapes.
- Completed-issue per-agent warnings disappear for agents that were verified
  during the run even if their hook later broke. That is the intended
  semantics (no live risk remains on a finished issue); genuinely
  never-verified agents still warn (test case 4), and live issues are
  unaffected (test case 3).
- Fixture realism: `containmentPolicy("/c", "cursor")` returning `null` in
  tests simulates binding drift only indirectly. Mitigation: the unit
  contract under test is precisely "completed reports do not consult the
  live binding", and `test/agentLifecycle.test.ts` separately pins that a
  mismatched explicit binding (`"b".repeat(64)`, line 79) still yields
  `unverified` when a binding is supplied.

## Conclusion

Two small, additive relaxations — preserve `entry.containment` across a
same-session `session-end` in `src/agentLifecycle.ts`, and evaluate/render
containment for completed issues without the live disk binding (plus no
top-level `[WARN]` downgrade) in `src/issueReport.ts` — remove both false
warnings while leaving every live-run check in `runLoop`/`shellGuard` and
the shared `containmentCoverage` predicate untouched. Four focused test
additions across the two existing test files pin the new behavior and its
non-completed controls.

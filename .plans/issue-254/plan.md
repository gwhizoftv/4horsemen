# Issue 254 implementation plan

Protocol version: 1. Issue session: `issue-254:7a8fc0272c80e364681d08437111f4534cd7a181`.
Baseline: `7a8fc0272c80e364681d08437111f4534cd7a181`.
Automation digest: `ef70d29a8e77c33d2c04ca64245b8dce4331f20697b53b8e5f1a1972c5eb4bd3`.

The frozen issue snapshot requires preserving verified containment after a same-session exit and preventing later clone policy changes or agent health from making a completed issue appear unhealthy. The implementation will retain the evidence checks already provided by `containmentCoverage` and change only evidence retention and the report's completed/live distinction.

## Exact File List to be changed or deleted

1. `src/agentLifecycle.ts`: In `applyLifecycleObservation`, change the containment reset condition to `sessionChanged` alone. A same-session `session-end`, including an event without a session ID, retains the recorded denial and probe. Keep replacement-session invalidation, retired-session filtering, session identity, pending-tool cleanup, and all other lifecycle updates unchanged.
2. `src/issueReport.ts`: Gate the top-level `uncertain` calculation with `!cursors.completed`, so completed issues do not read current clone bindings or become `[WARN]` because of agent health or containment. Keep `needsAction` and its existing precedence, so unresolved pauses, holds, owner questions, and publication failures still yield `[ACTION]`. In the existing per-agent rendering loop, use `containmentCoverage(entry)` for completed issues; for unfinished issues retain the current `containmentPolicy(agent.root, agent.id)?.binding ?? null` argument. Use an explicit completed/live branch or ternary so the live policy reader is not evaluated for completed issues. The issue mentions `renderAgentStatusLines`, but this baseline renders those lines inline in `renderIssueReport`; modify that loop without introducing a new renderer. Preserve the recorded hook/shim values, observation provenance, and truthful unverified details when evidence is missing or fails corroboration. A previously corroborated completed probe must no longer produce the runtime trust/activity warning merely because the policy changed or the session ended.
3. `test/agentLifecycle.test.ts`: Extend the existing containment/session test, replacing its obsolete expectation that `SessionEnd` clears containment. Verify evidence preservation and active coverage after exit while retaining the replacement-session and config-mismatch checks.
4. `test/issueReport.test.ts`: Extend the existing report tests with focused completed-versus-live containment, session-exit, health, and action-precedence regressions using the existing report fixtures.

No files will be deleted. No changes to hooks, policy generation, probe ingestion, runtime schemas, dependency manifests, version numbers, or workflow state are required.

## Exact file list to be created

No new product, test, or fixture files are needed. This planning action creates only `.plans/issue-254/plan.md`, the required coordinator artifact. Test setup stays within the two existing test files; any temporary policy files created by a test are cleaned up by that test's teardown.

## Reuse and Scope

- Reuse `applyLifecycleObservation`, `containmentCoverage`, `AgentLifecycleEntry`, `AgentLifecycleState`, and the existing containment schema in `src/agentLifecycle.ts`. The optional binding parameter already supports validating historical evidence without comparing it to live disk state. Its session match, denial/probe binding and policy-revision match, timestamp ordering, explicit tool-result, and known vendor-version checks remain unchanged.
- Reuse `renderIssueReport`, its `needsAction` calculation, inline agent-status loop, and `StartState`/`CursorsState` inputs. `cursors.completed` is the existing authoritative switch; do not infer completion from the step name, publication URL, or session exit.
- Reuse `containmentPolicy` from `src/shellGuard.ts` unchanged for active reports and test binding calculations. Reuse `agentLifecycleHookPath` from `src/agentHookSync.ts` and `GIT_WRAPPER_RELATIVE_PATH` from `src/setupWorkspace.ts` to locate temporary test policy bytes rather than duplicating vendor path knowledge. These referenced modules are read-only dependencies, not additional edit scope.
- Reuse `entry()`, `now`, `later`, `digest`, and the existing containment evidence setup in `test/agentLifecycle.test.ts`. Reuse `start()`, `complete()`, `initialCursors`, and `initialAgentLifecycle` in `test/issueReport.test.ts`, adapting the report fixture roster to `codex`/`claude` where needed.
- Existing temporary-directory/teardown patterns and Node filesystem APIs suffice for a small real-disk policy fixture inside the report test file. Only a shim file and vendor hook-settings file are needed to exercise the binding reader; do not install hooks or launch a harness. The larger `makeProduct` fixture in `test/support/workspaceFixture.ts` is unnecessary because this regression requires neither Git operations nor a product build.

No new production helper, shared fixture abstraction, dependency, persistent field, or migration is justified. Previously erased evidence cannot be reconstructed by this change; it must continue to render as unverified rather than being fabricated.

## Tests

Use the fewest focused additions, all in the existing files named above:

1. **Same-session exit and replacement** — In the existing containment case in `test/agentLifecycle.test.ts`, use a corroborated `hook-denied` probe with a known vendor version. Before mutating the vendor version to `unknown`, apply `session-end` with the matching ID and with the ID omitted. Both results must preserve the complete containment value and return `hook: "active"` from `containmentCoverage`. Apply a subsequent replacement `session-start` and confirm containment becomes null and coverage becomes unverified; a delayed exit from the retired session must not change that replacement. Keep the existing unknown-vendor and mismatched-binding assertions. The preservation assertions fail on the baseline; replacement and negative evidence assertions protect existing behavior.
2. **Historical policy versus active policy** — Add one compact parameterized report test for `codex` and `claude` in `test/issueReport.test.ts`. Create temporary shim/settings bytes, calculate their real policy identity, and seed matching denial/probe records and a healthy established session. Confirm the completed report begins with `[OK] Issue 1: complete` and contains `containment hook=active`. Apply `SessionEnd` through `applyLifecycleObservation`, then change the settings bytes and assert the calculated binding actually differs. The completed report must still show `[OK]`, active containment, and no runtime trust/activity warning. The same lifecycle evidence with `completed: false` must show `[WARN]` and unverified containment against the changed disk policy. Repeat the completed/live assertions after removing the temporary settings file to cover an unavailable clone policy. The completed-policy and exit assertions fail on the baseline; the unfinished controls prevent weakening live validation.
3. **Completion is workflow status, not evidence fabrication** — Extend the existing unknown-containment report case to assert an `[OK]` completed header while retaining `hook=unverified`, `shim=unverified`, and the missing-session explanation. In a small table using the report fixtures, cover unknown/degraded health and an absent lifecycle entry: completed headers remain `[OK]`, whereas unfinished reports with the same uncertainty remain `[WARN]`. With a completed cursor and failed publication, assert `[ACTION]` still takes precedence. Include a recorded probe whose denial binding differs from its probe binding and confirm completed per-agent coverage remains unverified. These assertions prevent treating completion itself as proof of active containment.

During implementation, run the focused command:

```sh
pnpm exec vitest run --config vitest.config.ts test/agentLifecycle.test.ts test/issueReport.test.ts
```

The command and test membership were checked against `package.json` and `vitest.config.ts`. For product publication in the current local-verification mode, the installed precommit hook owns `pnpm run check:fast` (lint, typecheck, fast tests, system tests) and prepush owns `pnpm run test:e2e`; do not manually duplicate those suites immediately before committing or pushing. The frozen start configuration assigns final `pnpm run check` to the coordinator (build, check:fast, e2e). If a later action switches to coordinator verification mode, follow its recorded candidate results and cheap-hook contract instead of rerunning coordinator-owned suites. Report hook results and coordinator results separately.

This plan-only action needs validation of required headings, non-empty sections, exact paths, scope, and bound identifiers, followed by the normal evidence-only commit/push hooks. No product test suite is required or claimed for publishing the plan.

## Alternatives Rejected

- Clearing evidence on every session exit loses the very observations needed to explain a finished run; replacement-session invalidation already prevents reusing it for a new process.
- Removing binding validation globally would weaken active-issue reporting. Omit the live binding argument only in completed reports.
- Forcing all completed agents to `hook=active` would invent verification for missing, mismatched, or uncorroborated evidence. Retain `containmentCoverage` unchanged.
- Giving `[OK]` unconditional precedence over every issue cue would hide actual publication failures or owner obligations. Bypass only agent uncertainty for completed issues.
- Adding archived-containment fields, a migration, another renderer, or broad fixture infrastructure would exceed this issue's needs; the current schema and optional binding argument already express the distinction.

## Risks and Mitigations

- Historical coverage could accidentally become live authorization. Keep the completed/live decision entirely within report rendering; do not change guard behavior, probe ingestion, delivery gating, or the coverage evaluator.
- A policy check could remain in one report path, leaving contradictory header and detail output. Update both the top-level uncertainty guard and inline per-agent coverage call, and exercise both outputs in the same report test.
- A new session could inherit the old session's coverage. Preserve `sessionChanged` invalidation and stale-session rejection, with regression assertions after the retained exit event.
- Completed reports could conceal genuine pending actions or imply missing evidence was verified. Preserve `needsAction` precedence and test missing/mismatched evidence explicitly.
- Real-disk tests could depend on the developer's installed hooks. Use only isolated temporary files and cleanup; never touch actual clone settings or require a vendor CLI.
- Older runtimes may already have null containment after exit. Keep them readable without schema changes, show their evidence as unverified, and base the completed header on workflow completion rather than attempting a backfill.

## Conclusion

Implement the four-file change: retain containment across same-session exit, distinguish completed historical reporting from unfinished live readiness, and extend the existing regression suites. Completion remains `[OK]` in the absence of actual issue-level action requirements, historical coverage remains evidence-based, and replacement sessions and active policy changes still invalidate coverage where they should.

# Plan — Issue 274: Select run agents from the command line (`--agents`)

## Exact File List to be changed or deleted

- `src/cli.ts`
  - Add `selectConfiguredAgents(raw: string, config: CoordinatorConfig, configPath: string): CoordinatorConfig["agents"]`:
    - Reject empty/whitespace-only input (`--agents requires at least one agent id.`).
    - Split on `,`, trim each entry, and reject any empty segment such as `claude,,codex`, `claude,`, or `,claude` (`--agents must be a comma-separated list of non-empty agent ids.`).
    - Check for duplicates (`--agents lists '<id>' more than once.`, matching `src/install.ts`).
    - Check that every requested agent id exists in `config.agents`; if not, throw `Agent '<id>' is not in <configPath> (configured: <ids>).`.
    - Return the matching `CoordinatorConfig["agents"]` entries in the exact order specified by `--agents` without mutating `config` or `config.json`.
  - Add helper `resolveAgentRoots(configPath: string, agents: CoordinatorConfig["agents"]): CoordinatorConfig["agents"]` and route `resolvedAgents(resolution)` through it.
  - Extend `StartResolution` with `selectedAgents: CoordinatorConfig["agents"] | null`.
  - In `resolveStart(parsed, io)`:
    - When `parsed.flags.has("agents")`, call `selectConfiguredAgents(parsed.flags.get("agents") ?? "", config, configPath)` (using `parsed.flags.get("agents") ?? ""` rather than `requireFlag` so `--agents ""` produces the specific agent-id error).
    - When `selectedAgents !== null && profile === "solo" && selectedAgents.length > 1`, throw an error (`Profile solo runs one agent, but --agents selected <n> (<ids>). Pass one agent or choose --profile reviewed or --profile consensus.`) instead of silently dropping extra requested agents.
    - Populate `selectedAgents` on the returned `StartResolution`.
  - Update the two direct `StartResolution` object literals in `existingContext` and `nextContext` to include `selectedAgents: null`.
  - In `startIssue(issue, resolution)`:
    - Keep `const agents = resolvedAgents(resolution)` (all configured workspace agents) for `resolveSafeCoordRoot`, `resolveSafeCompletesRoot`, and leftover orphan-session `detachIssue`, so containment and orphan cleanup still cover every configured clone.
    - Compute `const roster = resolution.selectedAgents !== null ? resolveAgentRoots(configPath, resolution.selectedAgents) : profile === "solo" ? agents.slice(0, 1) : agents;`.
    - Everything downstream in `startIssue` (`resolveAgentLauncher`, `preflightGitHubAccount`, `prepareAgentIssueBranches`, `activateCheckAdditions(roster[0]!.root, ...)`, `updateAgentVersions`, `createIssueRuntime`, `initializeOperationalState` `originalRoster`/`agents`, `initializeAgentLifecycle`, `startEffects`) already operates on `roster` and therefore applies strictly to the selected subset in `--agents` order.
  - Allow `"agents"` in `allowedFlags` for both:
    - Numeric `coord <issue>` (`["product", "profile", "config", "coord-runtime", "verbose", "agents"]`)
    - Explicit `coord start <issue>` (`["profile", "config", "coord-runtime", "product", "verbose", "agents"]`)
  - In the numeric `coord <issue>` handler, evaluate `existingIssueRuntime(resolution, issue)` before `assertNoManualSession(...)`. When `existing !== null` and `resolution.selectedAgents !== null`:
    - Read `existingRoster = readStartStateHeader(existing).originalRoster` and compare it (exact ordered list) against `resolution.selectedAgents.map((agent) => agent.id)`.
    - If equal, proceed to `assertNoManualSession(...)` and `runIssue(existing)` so re-running the same `coord N --agents ...` command from shell history resumes cleanly.
    - If different, throw an error before any manual-session prompt or runner effects: `Issue <n> already exists with agents <existing>; cannot change agents to <requested> on resume. Run \`coord <n>\` to resume, \`coord drop <agent> --issue <n>\` to remove an active agent, or \`coord wipe-issue <n>\` to start fresh.`.
  - Update `help` usage lines for `coord <issue>` and `coord start <issue>` to include `[--agents <a,b,c>]`, add a short note in `help`, and update `commandDescriptions.start` (avoiding the standalone word `product`, per the existing CLI help invariant in `test/cli.test.ts`).
- `docs/coord-driver.md`
  - Document `--agents <a,b,c>` briefly in `## Starting and running` (subset selection from `config.json` without editing it, error on unknown or repeated agents, `--profile solo` single-agent requirement, and frozen roster behavior on resume).
- `test/cli.test.ts`
  - Add focused tests covering the new `--agents` option on `coord <issue>` and `coord start <issue>` and all validation/resume edge cases.

## Exact file list to be created

- None. All CLI argument handling, start/resume orchestration, operator documentation, and CLI tests already live in `src/cli.ts`, `docs/coord-driver.md`, and `test/cli.test.ts`; no new module, schema, or test file is needed.

## Reuse and Scope

- **Reused existing symbols and mechanisms:**
  - `src/cli.ts`: `parseArgs`, `allowedFlags`, `resolveStart`, `StartResolution`, `resolvedAgents`, `startIssue`, `existingIssueRuntime`, `workflowProfile`, `assertNoManualSession`, `manualCleanup`, `runIssue`, `help`, `commandDescriptions`.
  - `src/state.ts`: `CoordinatorConfig` type and `readStartStateHeader` (already imported in `src/cli.ts`; parses `originalRoster` safely across runtime formats 2, 3, and 4).
  - `src/machine.ts`: `effectiveProfile` already treats a single-agent `activeRoster` as `"solo"`, so running `coord N --agents claude` against a `"consensus"` config works with no state-machine changes.
  - Downstream issue commands (`run`, `status`, `attach`, `detach`, `next`, `drop`, `analytics`, `hook-verify`, `detachCompletedIssue`) already read the frozen roster from `start.json` (`start.agents` / `start.originalRoster`) and `cursors.json` (`activeRoster`), so no changes outside `src/cli.ts` are required.
  - `test/cli.test.ts`: existing `setup`, `fakeLoop`, `successfulStartGit`, `issueRuntimePaths`, `agentRuntimePaths`, `readStartState`, `readCursorsState`, `readAgentLifecycle` fixtures and helpers.
- **Scope discipline:**
  - Zero new files, zero new dependencies, zero `start.json`/`config.json` schema changes, zero mutations to `config.json` on disk.
  - `--agents` is intentionally scoped to issue-starting entrypoints (`coord <issue>` and `coord start <issue>`) matching `--profile`; other commands (`run`, `status`, `attach`, `manual`, etc.) continue to reject `--agents` via `allowedFlags`.

## Tests

Extend `test/cli.test.ts` with the smallest focused test suite that fails before the change and passes after it (reusing `setup`, `fakeLoop`, `successfulStartGit`, `issueRuntimePaths`, `agentRuntimePaths`, `readStartState`, `readCursorsState`, `readAgentLifecycle`):

1. **Subset selection, order preservation, isolation, and `config.json` immutability** (`coord <issue>` and `coord start <issue>`):
   - Start with `--agents cursor,claude` (a reordered subset of the fixture's `codex, claude, cursor`, plus spaces like `"cursor, claude"`).
   - Verify `start.json` freezes `originalRoster: ["cursor", "claude"]` and `agents` in that exact order, `cursors.json` has `activeRoster: ["cursor", "claude"]`, `agent-lifecycle.json` tracks only those two, mailbox/agent runtime dirs exist only for `cursor` and `claude` (not `codex`), `startEffects` and agent maintenance (`update`/`--version`) receive only `cursor` and `claude`, and `config.json` bytes are unchanged.
   - Verify an invalid launcher on the unselected agent (`codex`) does not block starting with `--agents cursor,claude`.
2. **Error cases before any side effects** (exit code `2`, zero process/effect calls, no runtime directory created):
   - Agent not in `config.json` (e.g., `--agents claude,antigravity`).
   - Repeated agent (e.g., `--agents claude,codex,claude` and `--agents "claude, claude"`).
   - Empty or malformed list (`--agents ""`, `--agents "   "`, `--agents "claude,"`, `--agents "claude,,codex"`).
   - `--profile solo` (or `config.profile === "solo"`) with more than one agent (`--agents claude,codex`), while verifying `--profile solo --agents cursor` succeeds and runs `cursor` instead of `config.agents[0]`.
3. **Resume behavior on `coord <issue>`**:
   - After starting issue `N` with `--agents cursor,claude`, re-running `coord N --agents cursor,claude` resumes cleanly without restarting or re-running maintenance.
   - Re-running `coord N --agents claude,cursor` or `coord N --agents claude` fails with exit code `2` before `assertNoManualSession` or `runIssue`, reporting the frozen roster and recovery commands.
   - Re-running `coord N` without `--agents` still resumes normally.
4. **Help output**:
   - Verify `coord --help` and `coord start --help` advertise `[--agents <a,b,c>]` while existing help-language invariants (`test/cli.test.ts`) continue to pass.

**Verification commands:**
- Focused during implementation: `pnpm test:fast test/cli.test.ts`
- Fast check suite (also owned by pre-commit hook on product commits): `pnpm check:fast`
- Full suite (coordinator final gate): `pnpm check`

## Alternatives Rejected

1. **Supporting `--agents` on `coord manual`**: Rejected as out of scope for issue runs (`coord manual` does not accept `--profile` either) and because `coord manual` / `coord detach manual` manage one shared workspace session whose teardown checks all configured clones in `config.json`.
2. **Silently slicing `--agents` to 1 entry under `--profile solo`**: Rejected because silently discarding an explicitly named agent (`--profile solo --agents claude,codex`) violates user intent; failing closed with an actionable message is safer.
3. **Always rejecting or always ignoring `--agents` on `coord <issue>` resume**: Always ignoring would mislead operators into thinking the roster changed; always rejecting would break the common workflow of pressing Up-Arrow to re-run `coord N --agents ...` after Ctrl-C. Allowing an exact match against `originalRoster` and rejecting mismatches handles both cleanly.
4. **Reordering selected agents to match `config.json` instead of CLI order**: Rejected because `onboard`/`install` already establish that an explicit `--agents` list is used in the exact order given, and CLI order lets the owner control window order and primary agent selection.
5. **Adding `--agents` to `automationDigestMaterial`**: Rejected because `--profile` is likewise not hashed as a separate digest source; `automationDigestMaterial` hashes file-based sources (`config`, `github-issue`, `digestPaths`), while roster identity is already bound via `start.json`, `cursors.json`, and ballot/decision input hashes.

## Risks and Mitigations

- **Risk: Containment or orphan-session checks miss unselected clones.**
  - *Mitigation:* Keep `agents = resolvedAgents(resolution)` (all configured clones) for `resolveSafeCoordRoot`, `resolveSafeCompletesRoot`, and leftover orphan-session `detachIssue`, while narrowing only `roster` for launcher validation, GitHub preflight, branch prep, maintenance, runtime/mailbox creation, and tmux launch.
- **Risk: `StartResolution` type mismatch in `existingContext` / `nextContext`.**
  - *Mitigation:* Explicitly add `selectedAgents: null` to both direct `StartResolution` literals and verify with `pnpm typecheck`.
- **Risk: Resume mismatch triggers a manual-session close prompt before failing.**
  - *Mitigation:* In `coord <issue>`, resolve `existingIssueRuntime` and validate any `--agents` resume match before calling `assertNoManualSession`.
- **Risk: Help prose violates the existing CLI help invariant forbidding standalone `product`.**
  - *Mitigation:* Avoid the bare word `product` in `help` and `commandDescriptions`, and verify with `test/cli.test.ts`.

## Conclusion

Adding `--agents <a,b,c>` to `coord <issue>` and `coord start <issue>` via a small validation helper in `src/cli.ts` lets owners run any ordered, non-repeating subset of agents already configured in `config.json` without editing the file. Validation runs fail-closed before any side effects, `start.json` freezes the selected roster so all downstream commands and hooks work unchanged, resume accepts matching `--agents` while rejecting mismatches, and focused tests in `test/cli.test.ts` cover every contract and edge case.

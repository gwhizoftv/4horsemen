# Implementation Plan — Issue #161: Interactive Coord CLI Improvements and UX Fixes

## Exact File List to be changed or deleted

- `src/interactive.ts` (interactive terminal session controls, prompt handling, key routing, verbose help, status framing)
- `src/cli.ts` (CLI command routing, `commands.nudge` integration, `--repository` flag alias, `--coord-root` defaulting, hook preflight check at start, help text updates)
- `src/runLoop.ts` (action completion logging, verification and git push progress logs, missing Stop hook warning, agent re-nudge execution, human-readable deferral rationales)
- `src/issueReport.ts` (status indicators for health/intervention, human-readable turn/delivery labels, commit/pin clarification, hold reason and recovery explanation)
- `src/workspace.ts` (error message terminology update from "product" to "repository")
- `test/interactive.test.ts` (test cases for 'n' nudge command, empty return liveness, unknown key handling, verbose help)
- `test/issueReport.test.ts` (test cases for status indicator symbols, clarified delivery/commit strings, hold explanations)
- `test/cli.test.ts` (test cases for `--repository` alias, `--coord-root` defaulting from current worktree in `resume`, hook preflight warning)
- `test/runLoop.test.ts` (test cases for progress logs on agent completion, verification runs, branch publishing, and missing Stop hook warning)

## Exact file list to be created

None. All enhancements and bug fixes extend existing modules and test suites without introducing unnecessary new files or abstractions.

## Reuse and Scope

### Reuse of Existing Functions, Types, and Helpers
- `startInteractiveSession` and `InteractiveCommands` (`src/interactive.ts`): Extend `InteractiveCommands` interface with `nudge(): Promise<string> | string` without disrupting existing key event flow or confirmation menus.
- `inspectAgentLifecycleHooks` (`src/agentHookSync.ts`): Reuse the existing hook inspection utility to check agent hooks during coordinator startup in `src/cli.ts`.
- `resolveWorkspaceFromProduct` and `workspaceLocationFromConfig` (`src/workspace.ts`): Reuse to dynamically resolve the workspace and coord-root from the current worktree directory when `--coord-root` is omitted in `existingContext` (`src/cli.ts`).
- `renderIssueReport` and `holdRecoveryCommand` (`src/issueReport.ts`): Maintain existing reporting contract while adding status symbols (`✓`, `⚠`), clarifying pin/commit language, and demystifying hold reasons and delivery states.
- `CoordinatorRunLoop` (`src/runLoop.ts`): Reuse existing logging mechanisms (`this.log`), journal append helpers, and agent delivery/observation routines to expose progress milestones and provide an interactive re-nudge entrypoint.
- Test fixtures in `test/support/workspaceFixture.ts`, `test/interactive.test.ts`, and `test/issueReport.test.ts`: Reuse stream and workspace mocks to validate new interactive input behavior and report formatting.

### Justification of Scope
No new files are created. All 12 items in Issue #161 represent usability, observability, and ergonomics issues in the existing coordinator CLI and run loop. Modifying the existing cohesive files maintains architectural integrity and minimizes diff footprint.

## Tests

The following focused tests will be added to existing test files:

1. `test/interactive.test.ts`:
   - `it("echoes newline and redraws prompt on empty return (liveness check)")`: Send `\r` and `\n` in `"keys"` mode; assert output contains newline and redisplays prompt without error. Fails before change because CR/LF is ignored in `"keys"` mode.
   - `it("warns on unknown command and displays help")`: Send an unmapped character (e.g. `'x'`); assert output displays `Unknown command 'x'` and displays help text. Fails before change because unmapped keys are silently ignored.
   - `it("routes 'n' key to commands.nudge and prints result")`: Send `'n'`; assert `commands.nudge` is called once and printed. Fails before change because `'n'` is not recognized.
   - `it("prints verbose sentence help on '?' and 'h'")`: Send `'?'` and `'h'`; assert output contains full-sentence command descriptions (e.g., status, manual pause, re-nudge, attach, drop, release hold, steer, quit). Fails before change because only a single-line summary is printed.

2. `test/issueReport.test.ts`:
   - `it("displays leading status indicators (good vs intervention needed)")`: Assert report contains `✓` for healthy agents and progressing status, and `⚠` when holds, alerts, or manual pause are active. Fails before change because no status icons are included.
   - `it("clarifies pin and delivery states in human-readable terms")`: Assert report contains "Implementation commit (pin)" and readable delivery descriptions ("action issued", "action delivered to pane", "action accepted") instead of bare internal enum tokens. Fails before change because legacy strings are used.

3. `test/cli.test.ts`:
   - `it("defaults --coord-root from current worktree when omitted in coord resume")`: Run `coord resume --issue <n> --agent <agent>` without `--coord-root` from within an onboarded repository worktree; assert runtime paths resolve successfully rather than throwing `--coord-root is required`. Fails before change due to `requireFlag(parsed, "coord-root")`.
   - `it("accepts --repository as an alias for --product")`: Run CLI command with `--repository <path>`; assert command parses and behaves identically to `--product`. Fails before change because `--repository` is rejected as an unknown flag.
   - `it("warns at coord start if an agent's hooks are missing or modified")`: Simulate start with an un-synced hook; assert stdout receives warning about agent lifecycle hooks. Fails before change because start does not inspect hooks.

4. `test/runLoop.test.ts`:
   - `it("logs progress when completion marker is received, verification runs, and branches push")`: Assert `this.log` output logs completion receipt, verification start/passed status, and branch publication. Fails before change because these operations run silently.
   - `it("warns when no Stop hook is received after repeated turns")`: Simulate consecutive prompt submissions from Codex without a Stop event; assert warning is emitted to log. Fails before change because silence is maintained.

## Alternatives Rejected

1. **Adding an interactive command to force-advance / force-complete the turn (Issue #5)**:
   - Rejected: Arbitrarily completing a turn without valid agent submission or verification would bypass safety invariants, corrupt consensus ballots, and violate the state machine. Adding the `'n'` (re-nudge) command (Issue #6) directly solves the underlying problem (nudging stalled agents or re-evaluating completed but un-signaled work) safely without breaking protocol guarantees.
2. **Replacing `--product` flag entirely with `--repository` (Issue #12)**:
   - Rejected: Completely removing `--product` would break existing automation scripts and documentation. Accepting `--repository` as a primary alias while keeping `--product` backwards-compatible satisfies the UX requirement without breaking backwards compatibility.
3. **Adding a separate CLI sub-command for status reporting formatting**:
   - Rejected: Adding a new sub-command adds cognitive overhead. Enhancing `renderIssueReport` and framing interactive status output with `----` directly satisfies user needs in-place.
4. **Requiring `--reset-nudge-budget` in interactive hold release**:
   - Rejected: Operators using interactive key `'r'` have already inspected the agent and selected release; forcing them to switch to a separate CLI invocation with internal flags defeats the purpose of interactive recovery.

## Risks and Mitigations

- **Risk**: Changing status strings in `renderIssueReport` could break existing tests or external tooling relying on exact regular expression matches.
  - **Mitigation**: Retain core identifiable substrings (such as issue numbers, hold IDs, agent IDs, and essential path references) while prefixing readable status indicators and clearer section delimiters (`----`). Update affected repository unit tests to reflect the improved phrasing.
- **Risk**: Re-nudging agents via interactive key `'n'` could cause race conditions with in-flight tmux sends.
  - **Mitigation**: Route `nudge` through `CoordinatorRunLoop`'s existing debounced delivery protection (`ensureActionSafety` and `paneObservations`), resetting deferral delays without violating delivery locks.
- **Risk**: Defaulting `--coord-root` in `existingContext` might mistakenly resolve an unrelated workspace if run in an arbitrary directory.
  - **Mitigation**: Only fallback to `io.cwd` if `resolveWorkspaceFromProduct(io.cwd)` succeeds; otherwise preserve the existing descriptive error asking for `--coord-root` or `--repository`.

## Conclusion

This plan addresses all 12 usability and diagnostic issues raised in Issue #161. By introducing leading status symbols, human-readable turn and hold explanations, clear `----` status delimiters, interactive `'n'` re-nudging, responsive prompt echo and unknown-key handling, verbose help, `--repository` flag aliasing, `--coord-root` worktree defaulting, hook startup verification, and comprehensive progress logging, the coordinator CLI becomes significantly more transparent and intuitive for operators while preserving all underlying state and safety invariants.

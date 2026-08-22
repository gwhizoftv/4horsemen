# Comparison of Issue 92 Implementations

## Comparison

This review compares the four bound implementation pins for issue #92:
- **Antigravity**: `4193d2fadf1d277e50cb773d07171011aa58eacc` (from `.signals/issue-92/implementation-ready-antigravity.json`)
- **Claude**: `be82d90cb07361d877e073c17f0506ef0963ed22` (from `.signals/issue-92/implementation-ready-claude.json`)
- **Cursor**: `60f729bc142831d7f5aa45057fa6a33a23d6b286` (from `.signals/issue-92/implementation-ready-cursor.json`)
- **Codex**: `b8a00f760497ed75d561ff5054db33a95adf08f8` (from `.signals/issue-92/implementation-ready-codex.json`)

All four agents successfully executed the selected Claude plan (`3c9b810b4ab3f329cae009004609d76bbfecfc09`), strictly modifying only the 17 approved files:
1. `config.example.json`
2. `config.product.example.json`
3. `docs/coord-driver.md`
4. `docs/repo-map.md`
5. `docs/setup-workspace.md`
6. `package.json`
7. `scripts/lib/launcher.sh`
8. `src/action.ts`
9. `src/cli.ts`
10. `src/runLoop.ts`
11. `src/setupWorkspace.ts`
12. `src/state.ts`
13. `src/steps.ts`
14. `test/action.test.ts`
15. `test/install.test.ts`
16. `test/runLoop.test.ts`
17. `test/state.test.ts`

### 1. Version Bump and Launcher Configuration
- **Package Version**: All implementations correctly bumped `package.json` to `"0.0.15"` and updated `config.product.example.json` and `test/install.test.ts`.
- **Launcher Flag**: In `scripts/lib/launcher.sh`, all four implementations preserve `--mode accept-edits` and append `--dangerously-skip-permissions` for the Antigravity launcher. This directly resolves the permission wait tail identified in the analytics baseline without breaking interactive or unattended execution modes.

### 2. State & Configuration Schema (`src/state.ts`, `src/setupWorkspace.ts`, `src/cli.ts`)
- **Schema Validation**: All implementations add `contextPaths` with path confinement (`refine`) and uniqueness (`superRefine`) to `coordinatorConfigSchema` (defaulting to `[]`), optional `contextPaths` to `workspaceDeclarationSchema`, and `contextPaths: z.array(z.string()).default([])` to `startStateSchema`.
- **Constructor Interface**: All implementations update `StartStateInput` (`Omit<StartState, "formatVersion" | "createdAt" | "contextPaths"> & { contextPaths?: readonly string[] }`), preventing breaking changes across existing typed initializers.
- **Propagation**: `src/setupWorkspace.ts` and `src/cli.ts` cleanly forward `contextPaths` into workspace configuration and start state.

### 3. Change Scope Derivation & Error Resilience (`src/runLoop.ts`)
- **Claude (`be82d90cb07361d877e073c17f0506ef0963ed22`)**: Implements `resolveChangeScope(mirror, start, inputs)` as a modular top-level helper. Filters `inputs` for `implementation`, `revision`, and `prior-revision` kinds, memoizes calls to `mirror.changedPaths` per pin SHA, caps paths at `CHANGE_SCOPE_PATH_LIMIT = 200` with `truncated: boolean`, and catches git diff errors gracefully so unreadable pins omit scope rather than crashing action preparation.
- **Antigravity (`4193d2fadf1d277e50cb773d07171011aa58eacc`)**: Implements `resolveChangeScope` with memoization per pin, 200 path capping, and try-catch error resilience.
- **Cursor (`60f729bc142831d7f5aa45057fa6a33a23d6b286`) & Codex (`b8a00f760497ed75d561ff5054db33a95adf08f8`)**: Implement `resolveChangeScope` with identical logic and memoization.
- Claude's approach is the cleanest, defining `resolveChangeScope` as an exported helper with an explicit `CHANGE_SCOPE_PATH_LIMIT` constant, enabling direct unit testability.

### 4. Action Rendering & Injection Guards (`src/action.ts`, `src/steps.ts`)
- All implementations extend `InternalOrder` with optional `contextPaths` and `changeScope`.
- In `renderAction`, all implementations enforce that no path contains backticks or newline characters, preventing prompt escape injection or malformed markdown headers.
- When `contextPaths` is non-empty, `## Repo context` is emitted.
- When `changeScope` is non-empty, `## Changed paths for the bound pins` is emitted with per-agent subheadings and truncation markers.
- When both are empty, both sections are omitted entirely, ensuring unconfigured and unpinned actions remain byte-identical to prior outputs.

### 5. Documentation (`docs/repo-map.md`, `docs/coord-driver.md`, `docs/setup-workspace.md`)
- **Repo Map**: All implementations create `docs/repo-map.md`. Claude's version provides an exemplary structural breakdown of the codebase (entry points, state/protocol, workflow engine, evidence/git, lifecycle, key invariants, and standard verification commands) without brittle line numbers.
- **Driver & Workspace Docs**: Both `docs/coord-driver.md` and `docs/setup-workspace.md` are updated to document `contextPaths` and clarify that it is deliberately excluded from `automationDigest` calculation so documentation changes do not invalidate active sessions.

### 6. Test Suite Coverage
- **Claude (`be82d90cb07361d877e073c17f0506ef0963ed22`)**:
  - `test/state.test.ts`: Verifies default empty lists, valid confined paths, escape/duplicate rejection, legacy `start.json` parsing, and typed initializer optionality.
  - `test/action.test.ts`: Verifies `Repo context` and `Changed paths` rendering, truncation markers, backtick/newline rejection, and `parseAction` round-tripping.
  - `test/runLoop.test.ts`: Uses `countingMirror` to verify that `mirror.changedPaths` is called exactly once per distinct pin across multiple inputs, diffs exceeding the limit are truncated, unreadable pins fail open without crashing, and unpinned steps make zero git calls.
  - `test/install.test.ts`: Verifies version bump `0.0.15` and unattended Antigravity launcher flag.
- **Antigravity, Cursor, Codex**: All provide comprehensive test coverage across the modified modules.

### Verdict
All four implementations are high quality, fully passing all tests and pre-push verification gates. Claude's implementation (`be82d90cb07361d877e073c17f0506ef0963ed22`) stands out for its modular helper architecture, explicit constant definitions, comprehensive repo map documentation, and rigorous unit testing of memoization and edge cases.

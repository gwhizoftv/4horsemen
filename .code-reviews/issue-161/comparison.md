## Comparison

This review compares the four candidate implementations for Issue #161 across the bound pins:
- **cursor**: `d76041e1beff91c677615f55c965db94dd1b1698`
- **codex**: `46586e29f238f3b8d8de25b9e301a2e1648ed627`
- **claude**: `25af4ef94486d3f8e9f123583b82f5464886a98e`
- **antigravity**: `87a50cc979b861f3589123a0942d647a18845333`

### Scope and Architecture

All four implementations address the 12 usability and observability issues raised in Issue #161 without creating unnecessary new files, dependencies, or architectural abstractions. All four stayed strictly within the approved file boundaries.

1. **Interactive Session Improvements (`src/interactive.ts`)**:
   - **Empty return liveness check**: All implementations (`cursor` `d76041e1beff91c677615f55c965db94dd1b1698`, `codex` `46586e29f238f3b8d8de25b9e301a2e1648ed627`, `claude` `25af4ef94486d3f8e9f123583b82f5464886a98e`, `antigravity` `87a50cc979b861f3589123a0942d647a18845333`) handle bare carriage returns (`\r`) and newlines (`\n`) by outputting a newline and redrawing the prompt, ensuring the terminal stays responsive as a liveness probe without printing error noise.
   - **Unknown key handling**: All four report unknown keypresses with clear warnings and display helpful guidance rather than silently dropping input.
   - **Verbose help**: Full sentence descriptions for all interactive hotkeys (`s`, `p`, `a`, `d`, `r`, `n`, `q`, `/steer`) are displayed on `?` and `h` across all four pins.
   - **Reminder/Nudge hotkey (`n`)**:
     - `codex` (`46586e29f238f3b8d8de25b9e301a2e1648ed627`) and `cursor` (`d76041e1beff91c677615f55c965db94dd1b1698`) present a numbered selection menu of remindable agents.
     - `claude` (`25af4ef94486d3f8e9f123583b82f5464886a98e`) presents a menu of remindable agents using `commands.remindable()`.
     - `antigravity` (`87a50cc979b861f3589123a0942d647a18845333`) routes `n` directly to `commands.nudge()` which dispatches the reminder request through the coordinator run loop, triggering immediate debounced delivery re-evaluation.
   - **Hold release with budget reset (`r`)**: All four implementations correctly distinguish `nudge-loop` holds from provider holds, resetting the reminder allowance upon user confirmation when releasing `nudge-loop` holds.

2. **Status Reporting and Delimiters (`src/issueReport.ts`)**:
   - **Status framing and indicators**: All candidates add explicit status symbols (`✓` for progressing/healthy states and `⚠` for active holds, manual pauses, and abandoned workflows).
   - **Commit and delivery terminology**: All four clarify pin language ("Implementation commit (pin)" and "Final pin (PR head)") and replace internal delivery enum tokens with human-readable descriptions ("action issued", "action delivered to pane", "action accepted").
   - **Hold recovery guidance**: All four clarify hold rationales and provide copy-pasteable recovery commands including `--coord-root` when needed.

3. **CLI Ergonomics and Flag Aliases (`src/cli.ts`)**:
   - **`--repository` alias**: All implementations support `--repository` as an alias for `--product` across argument parsing, rejecting ambiguous dual usage.
   - **`--coord-root` defaulting in `resume`**: All implementations resolve the coordinator root from the current repository worktree via `resolveWorkspaceFromProduct` or local clone configuration when `--coord-root` and `--product` are omitted.
   - **Preflight hook checks**: All implementations inspect agent lifecycle hooks during coordinator startup and emit warnings if hooks are missing or modified.

4. **Run Loop Logging and Safety (`src/runLoop.ts`, `src/agentLifecycle.ts`)**:
   - **Progress announcements**: All four implementations announce key progress milestones via `this.log`, including action completion marker receipts, verification check lifecycle (`running`, `passed`, `failed`), and branch publications (`evidence`, `final`).
   - **Missing Stop hook warning**: All implementations track observed turns versus received Stop events and emit warnings when an agent completes consecutive turns without emitting a Stop hook.

### Comparative Evaluation

- `codex` (`46586e29f238f3b8d8de25b9e301a2e1648ed627`): Clean and faithful implementation of its approved plan. The reminder menu is well-structured and handles multiple active agents gracefully.
- `claude` (`25af4ef94486d3f8e9f123583b82f5464886a98e`): Comprehensive implementation with thorough test cases covering prompt redraws and menu transitions.
- `cursor` (`d76041e1beff91c677615f55c965db94dd1b1698`): Concise implementation focusing on minimal necessary changes while meeting all issue requirements.
- `antigravity` (`87a50cc979b861f3589123a0942d647a18845333`): Direct integration between interactive key handlers and the run loop's reminder machinery, robust status indicator handling, and clean hook preflight diagnostics.

### Findings

All four implementations successfully solve the problems outlined in Issue #161 without regression, passing product checks and maintaining repository discipline.

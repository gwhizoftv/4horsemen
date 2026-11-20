# Implementation Plan — Issue #267: Restore Mouse Drag-to-Copy in Codex and Cursor Terminals

## Root Cause (Measured on Live `coord-267` Tmux Server)

Issue #204 enabled tmux mouse scrolling (`mouse on`) on the primary issue session and on linked owner Terminal.app client sessions for `claude`, `cursor`, and `codex` (`mouseScrollingAgent` in `src/tmux.ts:529`), while launching `codex` with `--no-alt-screen` (`scripts/lib/launcher.sh:142`). Comparing the live pane flags and client options across agents explains why drag-to-copy works in every other agent but fails in `codex` and `cursor`:

- **Antigravity, Muse, OpenCode, Gemini** (`mouseScrollingAgent` is `false`): their linked Terminal.app clients (`coord-<n>-<agent>`) keep tmux `mouse off`. Dragging performs native macOS Terminal.app selection, so `Cmd+C` copies to the macOS pasteboard.
- **Claude** (`mouseScrollingAgent` is `true`, live flags `mouse_any=1 mouse_sgr=1 alt=1`): Claude Code enables xterm mouse tracking itself. tmux's default `MouseDrag1Pane` forwards drags directly to Claude (`send-keys -M`), and Claude copies the selection to the macOS clipboard on release.
- **Codex and Cursor** (`mouseScrollingAgent` is `true`, live flags `mouse_any=0 alt=0` for Codex and no app mouse tracking for Cursor):
  1. Because `mouse` is `on` on `coord-<n>-codex` and `coord-<n>-cursor`, macOS Terminal.app forwards mouse drag events to tmux instead of creating a native Terminal selection. Pressing `Cmd+C` therefore has no native selection to copy.
  2. tmux intercepts `MouseDrag1Pane` with `copy-mode -M` and highlights the dragged text. On mouse release, tmux's default `MouseDragEnd1Pane` (in both `copy-mode` and `copy-mode-vi`, as well as `DoubleClick1Pane` and `TripleClick1Pane`) runs `send-keys -X copy-pipe-and-cancel` with no command argument.
  3. On this tmux server (`tmux 3.7b`, default config), server option `copy-command` is `''` (empty) and `set-clipboard` is `external`. Without a `copy-command`, `copy-pipe-and-cancel` only saves to tmux's internal paste buffer, emits an OSC 52 escape sequence that macOS Terminal.app ignores, and exits copy-mode (clearing the selection). Neither releasing the mouse nor pressing `Cmd+C` captures the selected text into the macOS clipboard.

## Exact File List to be changed or deleted

Changed:
- `src/tmux.ts`
- `test/tmux.test.ts`

Deleted:
- None.

## Exact file list to be created

None. All production logic belongs in `src/tmux.ts` alongside the existing tmux scrolling options, and all regression tests extend `test/tmux.test.ts`.

## Reuse and Scope

This change stays strictly within `src/tmux.ts` and `test/tmux.test.ts`, with no new files, no new dependencies, and no changes to `scripts/lib/launcher.sh`, `src/cli.ts`, `src/runLoop.ts`, `src/setupWorkspace.ts`, `githooks/`, or `package.json`.

Existing symbols and patterns reused in `src/tmux.ts`:
- `platform()` from `node:os` (already imported at `src/tmux.ts:3`, matching `openDarwinTerminalWindows`, `closeDarwinTerminalWindows`, and `defaultOwnerTerminalTitleProbe`).
- `mouseScrollingAgent(agentId)` (`src/tmux.ts:529`), `sessionScrollOptions(session, mouse)` (`src/tmux.ts:531`), and `agentClientAttachCommand(session, agentId)` (`src/tmux.ts:549`).
- `TmuxController` (`src/tmux.ts:814`), specifically `configureSessionScrolling`, `startSession` (`src/tmux.ts:953`), and `ensureSession` (`src/tmux.ts:1083`), preserving `assertAuthority()` checks between awaited `this.runner(...)` calls in `ensureSession`.
- `TmuxRunner` / `runTmux` (`src/tmux.ts:12-28`).

Exact behavioral changes in `src/tmux.ts`:
1. Add exported constant/helpers near `sessionScrollOptions`:
   - `const COORD_COPY_TO_CLIPBOARD_ENV = "COORD_COPY_TO_CLIPBOARD";`
   - `export const defaultClipboardCommand = (osPlatform: NodeJS.Platform = platform()): string | null => osPlatform === "darwin" ? "pbcopy" : null;`
   - `export const scopedCopyCommand = (clipboardCommand: string): string => \`if [ "\${${COORD_COPY_TO_CLIPBOARD_ENV}:-}" = 1 ]; then ${clipboardCommand}; else cat >/dev/null; fi\`;`
2. Extend `sessionScrollOptions(session, mouse = true)` so that whenever `mouse` is `true`, it emits both:
   - `["set-option", "-t", session, "mouse", "on"]`
   - `["set-environment", "-t", session, COORD_COPY_TO_CLIPBOARD_ENV, "1"]`
   This automatically tags:
   - The primary session (`coord-<n>` / `coord-manual-<group>`) via `configureSessionScrolling(session)` in `startSession` and `ensureSession`.
   - Already-open linked clients (`coord-<n>-claude`, `coord-<n>-cursor`, `coord-<n>-codex`) on `coord resume` / `coord attach` via `ensureSession` -> `configureSessionScrolling(client, mouseScrollingAgent(agent.id))`.
   - Newly attached Terminal.app linked clients via `agentClientAttachCommand(session, agentId)` (all tokens are simple identifiers/digits, requiring no additional quoting inside `join(" ';' ")`).
   - Non-mouse-scrolling clients (`antigravity`, `gemini`, `muse`, `opencode`) keep `mouse = false` and receive neither `mouse on` nor `COORD_COPY_TO_CLIPBOARD`.
3. Add an optional trailing constructor parameter to `TmuxController`:
   `private readonly clipboardCommand: string | null = defaultClipboardCommand()`
   (preserves all existing `new TmuxController(...)` call sites in `src/cli.ts`, `src/runLoop.ts`, `src/detachIssue.ts`, and tests while enabling deterministic cross-platform testing without touching the host clipboard).
4. Add `private async configureServerCopyCommand(assertAuthority: () => void = () => undefined): Promise<void>` on `TmuxController`:
   - If `this.clipboardCommand === null || this.clipboardCommand.trim() === ""`, return immediately.
   - Run `await this.runner(["show-options", "-sv", "copy-command"])`, then `assertAuthority()`.
   - If `exitCode !== 0` (older tmux without `copy-command`), return without throwing (same fail-open compatibility as `pane-scrollbars -q`).
   - If `stdout.trim() !== ""` (owner already configured `copy-command` in `~/.tmux.conf`, or a prior `coord` run already configured it), return without modifying it.
   - Otherwise (`exitCode === 0 && stdout.trim() === ""`), run `await this.runner(["set-option", "-s", "-q", "copy-command", scopedCopyCommand(this.clipboardCommand)])`, then `assertAuthority()`, throwing on non-zero exit just like `configureSessionScrolling`.
5. Invoke `await this.configureServerCopyCommand()` in `startSession` right after `await this.configureSessionScrolling(session)` (inside the `try` block so failures roll back via `kill-session`), and `await this.configureServerCopyCommand(assertAuthority)` in `ensureSession` right after `await this.configureSessionScrolling(session); assertAuthority();`.

Why this solves Issue #267 cleanly:
- When tmux executes `copy-pipe-and-cancel` on `MouseDragEnd1Pane` (as well as `DoubleClick1Pane`, `TripleClick1Pane`, and copy-mode keyboard copy in both emacs and vi modes), tmux runs `copy-command` with the copying session's environment.
- In `coord-<n>-codex`, `coord-<n>-cursor`, `coord-<n>-claude`, and `coord-<n>`, `COORD_COPY_TO_CLIPBOARD=1` is set in that session's environment, so dragging and releasing immediately pipes the selection to `pbcopy` (capturing it into the macOS clipboard) and exits copy-mode (so `coord` nudges are never blocked by `pane_in_mode=1`). Pressing `Cmd+C` afterward in Terminal.app is a harmless no-op because Terminal.app has no native selection, leaving the copied text intact on the clipboard for `Cmd+V`.
- In any unrelated tmux session on the same server, `COORD_COPY_TO_CLIPBOARD` is unset, so the command drains stdin to `/dev/null` and leaves the system clipboard untouched.
- Trackpad/mouse-wheel scrolling and Cursor/Claude pane scrollbars from Issue #204 remain intact.

Existing test helpers and suites reused in `test/tmux.test.ts`:
- `ok`, `commandsIn`, `noopSleep`, `tmuxInstalled`, `agentClientAttachCommand` test (`test/tmux.test.ts:422-452`), `ensureSession` scrolling test (`test/tmux.test.ts:529-591`), and the `describe.skipIf(!tmuxInstalled)` isolated real-tmux suite (`test/tmux.test.ts:1584-1671`).

## Tests

All test changes join `test/tmux.test.ts` (zero new test files):

1. **Attach-command and session-option unit assertions** (extend existing tests at `test/tmux.test.ts:422-452` and `test/tmux.test.ts:529-591`):
   - Verify `agentClientAttachCommand` emits `set-environment -t coord-7-<agent> COORD_COPY_TO_CLIPBOARD 1` for `claude`, `codex`, and `cursor`, and omits `mouse`, `pane-scrollbars`, `COORD_COPY_TO_CLIPBOARD`, and `-g` for `antigravity` and `gemini`.
   - Verify `ensureSession` repairs `COORD_COPY_TO_CLIPBOARD=1` on both the primary session and already-open mouse-scrolling linked clients while keeping `calls.some((args) => args.includes("-g") || args[0] === "bind-key")` false.
2. **Focused unit test for `configureServerCopyCommand` and platform helpers** (new `it(...)` in `test/tmux.test.ts`):
   - `defaultClipboardCommand("darwin")` is `"pbcopy"` and `defaultClipboardCommand("linux")` is `null`.
   - `startSession` and `ensureSession` with injected `clipboardCommand: "pbcopy"` query `show-options -sv copy-command` and emit `set-option -s -q copy-command <scopedCopyCommand("pbcopy")>` when empty.
   - Preserves any non-empty existing `copy-command` (no `set-option ... copy-command` emitted).
   - Ignores older tmux (`show-options -sv copy-command` returning `exitCode: 1`) without failing session start/ensure.
   - Emits no `copy-command` calls when `clipboardCommand` is `null`.
   - Calls `assertAuthority()` after `show-options` in `ensureSession` so losing authority aborts before writing `set-option`.
3. **Focused isolated real-tmux integration test** (new `it(...)` inside `describe.skipIf(!tmuxInstalled)` in `test/tmux.test.ts`):
   - Spawns a private tmux server (`-L <socket> -f /dev/null`) with `COORD_COPY_TO_CLIPBOARD` removed from the spawned process environment (so the test stays hermetic even when run inside an active `coord` pane).
   - Injects a temp-file sink (`cat > '<clipFile>'`) as `clipboardCommand` so the test never touches the host pasteboard and runs identically on macOS and Linux.
   - Creates an unrelated session `hook-holder` and runs `startSession` / `ensureSession` for `codex` and `cursor` plus linked clients configured with the `agentClientAttachCommand` options.
   - Executes `copy-mode`, `begin-selection`, `end-of-line`, and `copy-pipe-and-cancel` (the exact action bound to `MouseDragEnd1Pane`, `DoubleClick1Pane`, and `TripleClick1Pane`):
     - Fails before this change (empty `copy-command`, `<clipFile>` stays empty) and passes after: selections from `coord-3-codex` and `coord-3-cursor` write the selected text to `<clipFile>` and exit copy-mode (`pane_in_mode === "0"`).
     - Selection from unrelated `hook-holder` does **not** write to `<clipFile>`.
     - On a server with an owner-configured `copy-command`, `startSession`/`ensureSession` preserves that exact value unchanged.

Verification commands (from `package.json`):
- Focused during development: `pnpm vitest run --config vitest.config.ts test/tmux.test.ts`
- Mandatory pre-commit/pre-push hook suite (`verify.precommit`): `pnpm check:fast` (`pnpm lint && pnpm typecheck && pnpm test:fast && pnpm test:system`), owned by the git hook (not manually duplicated immediately before commit).
- Coordinator-owned final acceptance suite: `pnpm check` (`pnpm build && pnpm check:fast && pnpm test:e2e`).

## Alternatives Rejected

1. **Turn `mouse off` on `codex` and `cursor` linked clients**: Restores native Terminal.app selection + `Cmd+C`, but directly regresses Issue #204 by breaking trackpad/mouse-wheel scrolling on both agents and breaking Cursor's `pane-scrollbars`.
2. **Override `MouseDragEnd1Pane` with `bind-key -T copy-mode` / `copy-mode-vi`**: `bind-key` mutates server-wide key tables (explicitly forbidden by Issue #204 and `test/tmux.test.ts:590`), would clobber custom owner keybindings in `~/.tmux.conf`, and would miss `DoubleClick1Pane`/`TripleClick1Pane`/keyboard copy unless every binding were duplicated. Using `copy-command` integrates cleanly with tmux's existing default bindings across both emacs and vi copy modes.
3. **Set `set-option -s copy-command pbcopy` unconditionally (without the session-env guard)**: Empirically verified on tmux 3.7b that `copy-command` is strictly server-scoped (`set-option -t <session> copy-command` mutates the server option for every session). Without the `COORD_COPY_TO_CLIPBOARD=1` guard, copying in unrelated sessions on the same tmux server would unexpectedly write to the macOS clipboard.
4. **Use `set-option -s -o -q copy-command ...` to avoid overwriting user config**: Empirically verified on tmux 3.7b that `-o` treats tmux's built-in empty default (`copy-command ''`) as already set and silently refuses to update it. Explicitly reading `show-options -sv copy-command` first is required to distinguish unset (`""`), owner-configured (non-empty), and unsupported (`exitCode !== 0`).
5. **Use `copy-pipe-no-clear` so the selection stays highlighted for `Cmd+C`**: Leaves `pane_in_mode=1`, which `TmuxController.injectionGate` (`src/tmux.ts:1218,1236`) treats as `owner-typing` / scrollback wait and blocks coordinator action delivery; moreover, Terminal.app still does not see a tmux highlight as a native selection for `Cmd+C`.
6. **Rely on OSC 52 (`set-clipboard on`)**: macOS Terminal.app does not support OSC 52 clipboard writes, which is why default `set-clipboard external` already fails today.
7. **Isolate `coord` onto a dedicated `tmux -L coord` server**: Out of scope and breaking for existing running sessions, `tmux attach` muscle memory, scripts, and tests.

## Risks and Mitigations

- **Server-level `copy-command` option visibility**: `copy-command` is a tmux server option (`-s`), so `show-options -s copy-command` will reflect the scoped command once set by `coord`.
  - *Mitigation*: Only set when currently empty (never overwrite owner `~/.tmux.conf`), and gate execution on per-session `COORD_COPY_TO_CLIPBOARD=1` so unrelated sessions drain stdin to `/dev/null` with identical observable clipboard behavior. Verified by the isolated real-tmux test against `hook-holder`.
- **Older tmux versions (< 3.2) without `copy-command`**:
  - *Mitigation*: Check `show-options -sv copy-command` first and skip cleanly when `exitCode !== 0`, plus use `-q` on `set-option`, so startup/resume never fails on older tmux.
- **Already-open linked clients from before upgrading `coord`**:
  - *Mitigation*: `ensureSession` already runs `configureSessionScrolling(client, mouseScrollingAgent(agent.id))` for each attached linked client and will now also call `configureServerCopyCommand(assertAuthority)`, so `coord resume` or `coord attach` repairs live sessions without needing a restart.
- **Inherited `COORD_COPY_TO_CLIPBOARD=1` in child processes spawned from `coord-<n>`**:
  - *Mitigation*: Unrelated user sessions on the host tmux server inherit from the server global environment (which `coord` never modifies), not from an agent pane. For isolated tmux servers started by tests inside an agent pane, `test/tmux.test.ts` strips `COORD_COPY_TO_CLIPBOARD` when spawning its private `-L` test server.
- **Owner `~/.tmux.conf` replacing `MouseDragEnd1Pane` with `copy-selection-and-cancel` (no pipe)**:
  - *Mitigation*: Deliberately do not overwrite owner `bind-key` customizations; default tmux binds `MouseDragEnd1Pane` to `copy-pipe-and-cancel` in both `copy-mode` and `copy-mode-vi`.
- **Non-macOS platforms**:
  - *Mitigation*: `defaultClipboardCommand()` returns `null` off `darwin`, avoiding speculative Linux clipboard tool guesses while keeping `TmuxController`'s `clipboardCommand` injectable for deterministic cross-platform tests.

## Conclusion

Codex and Cursor lost mouse drag-to-copy after Issue #204 enabled tmux `mouse on` for their clients without configuring tmux's `copy-command`, leaving `copy-pipe-and-cancel` with only OSC 52 (unsupported by macOS Terminal.app). Setting a session-scoped `COORD_COPY_TO_CLIPBOARD=1` environment marker on `coord`'s mouse-scrolling sessions and configuring an empty tmux server `copy-command` to pipe to `pbcopy` on macOS only when that marker is set restores drag-release copying for Codex and Cursor (as well as double/triple-click and copy-mode copy), keeps `Cmd+C` harmless afterward, preserves Issue #204's mouse scrolling and scrollbars, never leaves panes stuck in copy-mode, and leaves unrelated tmux sessions and owner `~/.tmux.conf` settings untouched.

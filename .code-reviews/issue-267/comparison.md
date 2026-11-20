# Implementation Comparison — Issue #267

Bound implementation pins compared:
- **antigravity**: `e5c9a43f1b050d6e6e551c9b56d7b295f4a60378`
- **claude**: `ea9a12ba08a62bf179911997ce292ab7438de3c2`
- **codex**: `adfe985c7853c748ae1855268235cc6f8a045265`

## Comparison

### Scope, Reuse, and Plan Fidelity

All three implementations keep product edits strictly within `src/tmux.ts` and `test/tmux.test.ts`, create zero new files, add zero dependencies, and reuse `sessionScrollOptions`, `agentClientAttachCommand`, `TmuxController.startSession`, `TmuxController.ensureSession`, `commandsIn`, `ok`, and the isolated tmux test harness.

- **antigravity (`e5c9a43f1b050d6e6e551c9b56d7b295f4a60378`)** and **claude (`ea9a12ba08a62bf179911997ce292ab7438de3c2`)** follow the selected plan (`efac99cd`) faithfully: both export `defaultClipboardCommand` (`/usr/bin/pbcopy` on `darwin`, `null` otherwise) and `scopedCopyCommand` (POSIX `sh` gating on `COORD_COPY_TO_CLIPBOARD=1` with `cat >/dev/null` drain for unrelated sessions), add `set-environment -t <session> COORD_COPY_TO_CLIPBOARD 1` inside `sessionScrollOptions` when `mouse` is `true`, add an optional trailing `clipboardCommand` constructor parameter to `TmuxController`, and add `configureServerCopyCommand` (inspecting `show-options -sv copy-command` first, preserving owner config and skipping older tmux without `-g` or `bind-key`). Their `src/tmux.ts` implementations are functionally identical; differences lie in `test/tmux.test.ts`.
- **codex (`adfe985c7853c748ae1855268235cc6f8a045265`)** departs substantially from the selected plan: it turns `mouse on` for non-mouse-scrolling agents (`antigravity`, `muse`, `gemini`, `opencode`) on macOS, rewrites the server-global `root` `MouseDrag1Pane` binding via `bind-key`, adds a window option `@coord-copy-window` to exclude the `control` window, and spawns a nested `tmux display-message` subprocess inside `copy-command`. While its PTY drag test using `script` + SGR mouse sequences and `tmux wait-for` synchronization is strong, the production deviations introduce concrete regressions below.

---

### Findings — Codex (`adfe985c7853c748ae1855268235cc6f8a045265`)

1. **`src/tmux.ts:535-545` and `src/tmux.ts:560-571` — enables `mouse on` for non-mouse-scrolling agents (`antigravity`, `muse`, `gemini`, `opencode`) on macOS**:
   - *Rule that must hold*: Linked clients for agents outside `mouseScrollingAgent` (`antigravity`, `muse`, `gemini`, `opencode`) must keep tmux `mouse off` so native macOS Terminal.app selection + `Cmd+C` continues to work unchanged and accidental wheel scrolling does not enter tmux copy-mode (`pane_in_mode=1`, blocking automatic coordinator nudges). This is explicitly required by the selected plan (`efac99cd`) and preserves Issue #204's per-agent mouse allowlist.
   - *Concrete failure*: When `clipboard` is `true` on macOS and `copy-command` is non-empty, `sessionScrollOptions` runs `if-shell -F "#{!=:#{copy-command},}" "set-option -t <client> mouse on"`, turning tmux mouse mode on for `antigravity`, `muse`, `gemini`, and `opencode`. That breaks native Terminal.app `Cmd+C` selection on all four clients (and causes wheel movement in Antigravity/Muse to stall nudges on `scrollbackWait`). Codex's own unit test at `test/tmux.test.ts:449` had to pass `clipboard = false` (`agentClientAttachCommand("coord-7", id, false)`) to avoid failing the pre-existing `not.toMatch(/mouse/)` check.
   - *Smallest illustrative test*:
     ```ts
     expect(agentClientAttachCommand("coord-7", "antigravity", true)).not.toMatch(/\bmouse\b/);
     ```

2. **`src/tmux.ts:1035-1044` — mutates the global `root` `MouseDrag1Pane` key binding and overrides `mouse_any_flag` for Claude and OpenCode**:
   - *Rule that must hold*: Coordinator session setup must not modify server-wide tmux key tables (`bind-key` is disallowed by Issue #204, the selected plan, and `test/tmux.test.ts:591`), and must not intercept `MouseDrag1Pane` away from TUIs that enable xterm mouse tracking and handle drag-copy natively (`claude` and `opencode`, both measured live with `mouse_any_flag=1, alternate_on=1`).
   - *Concrete failure*: On any real tmux 3.6/3.7 server with stock bindings, `configureClipboard` issues `bind-key -T root MouseDrag1Pane ...`, permanently altering the server's `root` key table after coord exits (the mock test at `test/tmux.test.ts:591` passes only because its mock runner returns empty stdout for `list-keys -T root`). Worse, because `@coord-copy-window` is set on every agent window including `claude` and `opencode`, `#{?${managedWindow},0,#{mouse_any_flag}}` forces drags in Claude Code and OpenCode out of their native mouse handlers into tmux `copy-mode -M` on the alternate screen (preventing Claude Code's native selection/auto-scroll drag while leaving `DoubleClick1Pane`/`TripleClick1Pane` routed to the app). Additionally, matching the exact brace-formatted string `{ send-keys -M } { copy-mode -M }` fails on tmux 3.2–3.5 where `list-keys` prints quoted `"send-keys -M" "copy-mode -M"`.
   - *Smallest illustrative test*:
     ```ts
     // Mock runner returning stock `list-keys -T root` output causes `ensureSession`
     // to emit `bind-key`, violating the no-bind-key invariant at test/tmux.test.ts:591.
     ```

3. **`src/tmux.ts:1019-1025` — `copy-command` invokes bare `tmux` and exits without draining stdin**:
   - *Rule that must hold*: The installed `copy-command` must not depend on Homebrew/custom `PATH` entries inside the tmux server environment, and no-op branches must drain stdin so large copies do not hit broken-pipe writes.
   - *Concrete failure*: On macOS where `tmux` lives in `/opt/homebrew/bin/tmux`, a tmux server started with a minimal `PATH` (such as `/usr/bin:/bin`) fails `tmux display-message ...` with exit 127, hitting `|| exit 0` and silently discarding every dragged selection even though `/usr/bin/pbcopy` is present. Exiting `0` without draining stdin (`cat >/dev/null`) also closes the pipe unread on skipped sessions/windows when selections exceed the OS pipe buffer.
   - *Smallest illustrative test*:
     ```ts
     // Executing the installed copy-command with PATH=/usr/bin:/bin drops copied bytes
     // even when COORD_COPY_SESSION and @coord-copy-window are set.
     ```

4. **`src/tmux.ts:1011` and `test/tmux.test.ts` — missing whitespace guard and missing unit tests for `copy-command` edge cases**:
   - *Rule that must hold*: `configureClipboard` should ignore blank `clipboardCommand` strings and have unit coverage for `assertAuthority()` loss between `show-options` and `set-option`, non-darwin (`null`) skipping, and older tmux (`show-options` exit 1).
   - *Concrete failure*: Passing `"   "` as `clipboardCommand` attempts to install an invalid `exec    ` copy-command, and authority loss between `show-options`, `if-shell`, `list-keys`, and `bind-key` is untested.
   - *Smallest illustrative test*: Pass `clipboardCommand = "   "` (or throw in `assertAuthority` after `show-options`) to `ensureSession` and assert no `set-option`/`bind-key` runs.

---

### Findings — Claude (`ea9a12ba08a62bf179911997ce292ab7438de3c2`)

No product defects found in `src/tmux.ts`. Two focused test gaps in `test/tmux.test.ts`:

1. **`test/tmux.test.ts:1744-1745` — mutates shared `process.env` and does not strip `TMUX`/`TMUX_PANE`**:
   - *Rule that must hold*: Async tests must not mutate global `process.env` and should pass an isolated environment map to spawned private tmux servers so parent `TMUX`, `TMUX_PANE`, and `COORD_COPY_TO_CLIPBOARD` variables cannot leak or race with concurrent tests.
   - *Concrete failure*: `delete process.env.COORD_COPY_TO_CLIPBOARD` mutates process-wide state for the duration of the async real-tmux test, and leaves parent `TMUX`/`TMUX_PANE` intact in `runTmux`'s child environment.
   - *Smallest illustrative fix*: Clone `process.env`, delete `TMUX`, `TMUX_PANE`, and `COORD_COPY_TO_CLIPBOARD` on the clone, and pass `{ env: cleanEnv }` to `spawn("tmux", ...)`.

2. **`test/tmux.test.ts:605-639` and `test/tmux.test.ts:1720-1776` — incomplete 7-agent coverage in `ensureSession` unit test and isolated tmux test, plus unescaped single quotes in sink path**:
   - *Rule that must hold*: Per owner guidance, acceptance tests should cover all seven supported agent IDs (`codex`, `cursor`, `claude`, `antigravity`, `muse`, `gemini`, `opencode`) across both `ensureSession` linked-client repair and isolated tmux verification, and test temp paths must escape single quotes if interpolated into a single-quoted shell command.
   - *Concrete failure*: The unit test at `test/tmux.test.ts:605-639` passes an empty roster `[]` (skipping linked-client repair across the 7 agents), and the isolated tmux test at `test/tmux.test.ts:1729` exercises only 3 agents (`codex`, `cursor`, `muse`), omitting `claude`, `antigravity`, `gemini`, and `opencode` as well as primary-session `coord-3:<agent>` copy for non-mouse clients. At line 1725, `cat >> '${sink}'` also breaks if `tmpdir()` contains an apostrophe.
   - *Smallest illustrative test*: Parameterize both `ensureSession` and the isolated tmux test over all seven IDs (`codex`, `cursor`, `claude`, `antigravity`, `muse`, `gemini`, `opencode`) and escape single quotes in `sink`.

---

### Findings — Antigravity (`e5c9a43f1b050d6e6e551c9b56d7b295f4a60378`)

No product defects found in `src/tmux.ts`. Two minor test-strength notes in `test/tmux.test.ts`:

1. **`test/tmux.test.ts:600-660` — `copy-command` edge-case unit test exercises `ensureSession` but not `startSession` directly**:
   - *Rule that must hold*: Both `startSession` and `ensureSession` entry points should be asserted against empty, owner-configured, older-tmux, and `null` `clipboardCommand` cases in unit tests.
   - *Concrete failure*: While `startSession` is covered for the empty-option case in the real-tmux test (`test/tmux.test.ts:1799`), a regression dropping `configureServerCopyCommand()` or its owner-preservation guard from `startSession` on non-darwin or older tmux would not fail the mocked unit test at `test/tmux.test.ts:600-660` (unlike Claude's `for (const start of [false, true])` loop at `test/tmux.test.ts:620`).
   - *Smallest illustrative test*: Loop `startSession` and `ensureSession` over the four `copy-command` mock cases in the existing unit test.

2. **`test/tmux.test.ts:1828-1832` — fixed 250ms sleep to assert unrelated-session isolation**:
   - *Rule that must hold*: Asynchronous no-op assertions in isolated tmux tests should avoid relying solely on a fixed wall-clock sleep when deterministic completion synchronization is available.
   - *Concrete failure*: Under heavy host load, if the `hook-holder` copy job were delayed past 250ms, the assertion `expect(readFileSync(clipFile, "utf8")).toBe("sentinel-untouched")` could pass before the job ran. (Synchronizing with `tmux wait-for` or polling `show-buffer` plus a subsequent managed copy avoids a race.)
   - *Smallest illustrative fix*: Wait on a completion marker (or follow `hook-holder` copy with a managed copy and check the sink contains only the managed text).

---

### Verification Performed During This Comparison

- Read `src/tmux.ts` and `test/tmux.test.ts` directly from all three bound worktrees (`e5c9a43f1b050d6e6e551c9b56d7b295f4a60378`, `ea9a12ba08a62bf179911997ce292ab7438de3c2`, `adfe985c7853c748ae1855268235cc6f8a045265`) and diffed `src/tmux.ts` between `antigravity` and `claude`.
- Ran one isolated scratch `tmux -L` probe on tmux 3.7b to verify `#{COORD_COPY_SESSION}` env expansion and comma handling in `#{==:#{copy-command},}` when evaluating Codex's code. Did not run peer test suites.

### Summary Ranking

1. **antigravity (`e5c9a43f1b050d6e6e551c9b56d7b295f4a60378`)** — Cleanest overall: exact two-file adherence to the selected plan, zero `bind-key` mutations, preserves `mouse off` native Terminal selection on `antigravity`/`muse`/`gemini`/`opencode` and native mouse handling on `claude`/`opencode`, clean `cleanEnv` isolation without mutating `process.env`, and full 7-agent coverage in both unit and real-tmux integration tests. Only minor test-tightening items (looping `startSession` in the unit test and replacing the 250ms sleep in the `hook-holder` check).
2. **claude (`ea9a12ba08a62bf179911997ce292ab7438de3c2`)** — Functionally identical `src/tmux.ts` with clear comments and clean `startSession`+`ensureSession` unit coverage for `copy-command` branches, behind `antigravity` only on test isolation (`process.env` mutation) and incomplete 7-agent coverage in `ensureSession` and isolated tmux tests.
3. **codex (`adfe985c7853c748ae1855268235cc6f8a045265`)** — Strong PTY drag test and `control`-window exclusion, but introduces three concrete issues: turns `mouse on` for non-mouse-scrolling agents (regressing native Terminal `Cmd+C`), mutates server-wide `bind-key -T root MouseDrag1Pane` (overriding Claude/OpenCode native drag and violating the selected plan/`no bind-key` invariant), and relies on bare `tmux` on `PATH` inside `copy-command`.

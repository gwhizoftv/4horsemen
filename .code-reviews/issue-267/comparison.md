# Issue 267 implementation comparison (claude)

## Comparison

### Bound pins

| Agent | Implementation pin |
|---|---|
| antigravity | `e5c9a43f1b050d6e6e551c9b56d7b295f4a60378` |
| claude | `ea9a12ba08a62bf179911997ce292ab7438de3c2` |
| codex | `adfe985c7853c748ae1855268235cc6f8a045265` |

Each pin changes only `src/tmux.ts` and `test/tmux.test.ts` among product paths. All three stay within the approved map, add no files or dependencies, and leave the launcher, config and docs alone. I read each pin's product diff against the issue baseline `96c68525200c778d65d50a7f2f8d9c8c0fc05b1f` in its bound worktree.

### Approach

**antigravity `e5c9a43f` and claude `ea9a12ba`** both implement the selected plan, and their `src/tmux.ts` changes are functionally identical. Each:

- adds `defaultClipboardCommand`, which returns `/usr/bin/pbcopy` on darwin and null elsewhere;
- adds `scopedCopyCommand`, which runs the clipboard command only when `COORD_COPY_TO_CLIPBOARD=1` and otherwise runs `cat >/dev/null`;
- has `sessionScrollOptions` set that marker next to `mouse on`;
- adds a trailing `clipboardCommand` constructor parameter;
- adds `configureServerCopyCommand`, which reads `show-options -sv copy-command`, skips on old tmux or an owner value, writes `set-option -s -q` only when the option is empty, and calls `assertAuthority()` after each awaited call;
- calls it from `startSession` and `ensureSession`.

Neither pin issues `bind-key` or `-g`, and neither changes which clients get `mouse on`. Only comments and one error string differ (antigravity `src/tmux.ts:1021`, claude `src/tmux.ts:1029`).

**codex `adfe985c`** departs from the selected plan. Like the other two, it guards `copy-command` and installs it only when empty, with a script that checks the copying session and a per-window `@coord-copy-window` marker. It also does three things the plan did not:

- turns `mouse on` for the Antigravity, Muse, Gemini and OpenCode clients whenever `copy-command` is non-empty (`src/tmux.ts:539-541`);
- rewrites the server-global root `MouseDrag1Pane` binding when it matches the stock text, forcing `copy-mode -M` in marked windows even when the app requests the mouse (`src/tmux.ts:1037-1041`);
- marks every managed window, including Claude and OpenCode, so their drags are taken away from the app.

### Measured agent behavior

I ran these on isolated `tmux -L` scratch servers with tmux 3.7b, sending no prompts:

- **Leave the mouse to tmux** (`mouse_any_flag=0`): Codex (live coord pane), Cursor `agent` (main screen, after trust), Muse 1.4.24, Antigravity (live).
- **Capture the mouse** (`mouse_any_flag=1`, SGR, alternate screen): Claude (live) and OpenCode 2.2.2.
- **OpenCode copies its own selection.** A synthetic SGR drag put exactly the dragged text (`nything… "Wha`) on the macOS pasteboard; I saved and restored the owner's clipboard around the check.
- **Gemini** is not installed here and was not measured.

So the selected design (copy-command only) covers every measured window. Codex's drag override is only needed for an app that captures the mouse without copying, and no measured agent does that.

### Verification

**Recorded runs** (coordinator journal, hook observations):

- antigravity `check:fast` exit 0, then `test:e2e` exit 0.
- claude `check:fast` exit 0 (journal sequence 143), then `test:e2e` exit 0 (sequence 151).
- codex `check:fast` **exit 1** (sequence 158), then exit 0 (sequence 160), on the **same** staged index `ab85e6207dbbac0982345929517482e83da26be8`; then `test:e2e` exit 0.

**My runs, to investigate F3** (each pin copied to my scratchpad with this clone's `node_modules`; `pnpm exec vitest run --config vitest.config.ts test/tmux.test.ts -t <name>`):

| Pin | Result | Failures |
|---|---|---|
| codex `adfe985c` real-client test | 5/5 alone; 3 of 8 failed with four concurrent runs | All at `controller.startSession` (`test/tmux.test.ts:1613`): `cannot launch gemini in coord-7:gemini: respawn pane failed: fork failed: Device not configured`, and two more at about 207 ms with the same symptom. 33 of 511 ptys were in use, so this is not pty exhaustion. |
| antigravity `e5c9a43f` seven-pane real test | 4/4 concurrent | — |
| claude `ea9a12ba` real test | 4/4 concurrent | — |

I did not run the full product suite on any pin. The final checks belong to the coordinator.

### Findings

**F1. codex `adfe985c`: global key-binding rewrite takes drags away from apps that copy themselves (blocking)**

- **Where:** `src/tmux.ts:1037-1041`, with the window marker installed through `agentWindowOptions` (`src/tmux.ts:1256-1259`).
- **Rule:** The selected plan rejects `bind-key`. A window whose program already copies its own selection to the pasteboard (Claude, OpenCode, as measured) must keep that behavior, because Claude was the working reference case in issue 267.
- **Failure:**
  - In a marked Claude or OpenCode window, `#{?managed,0,#{mouse_any_flag}}` forces `copy-mode -M`, so the app never sees the drag.
  - tmux then copies raw screen cells. A two-line drag in OpenCode's prompt panel (`                       ┃  Ask anything…`) puts the left border glyph `┃` and 23 padding spaces of the second line on the pasteboard. OpenCode's own selection, which I measured, copies only the text.
  - In Claude's alternate-screen UI, tmux copy-mode has no history, so a drag can no longer select past the visible screen.
  - The rebinding stays in the owner's server key table after every coord session ends.
  - The suite's "no `bind-key`" assertion (`test/tmux.test.ts`, the resume test) still passes only because the mocked `list-keys` returns nothing, so it no longer checks what it claims to.
- **Test sketch:** in the real-client test, launch a pane that enables `?1002h?1006h` and echoes the mouse bytes it receives. After a drag, assert the pane received the SGR sequence and `#{pane_in_mode}` stayed `0`. This fails at `adfe985c` and passes at the other two pins.

**F2. codex `adfe985c`: turns mouse mode on for agents whose native selection already worked (blocking)**

- **Where:** `src/tmux.ts:539-541`, in the `else if (clipboard)` branch of `sessionScrollOptions`.
- **Rule:** The issue fixes Codex and Cursor. Windows the owner reported as working (Antigravity, Muse; Gemini and OpenCode kept tmux mouse off) must keep their behavior, and the selected plan says non-mouse clients keep `mouse off`. Delivery must not gain new blocking states.
- **Failure:**
  - On any server with a non-empty `copy-command`, which coord itself just installed, the Antigravity, Muse, Gemini and OpenCode clients get `mouse on`. The real test asserts this for all seven (`test/tmux.test.ts:1645`).
  - Terminal.app's native selection and Cmd-C in those windows stop working.
  - A wheel scroll in the Antigravity or Muse window now enters tmux copy-mode. `inspectPane` reports `ownerTyping` whenever `#{pane_in_mode}` is 1, so `injectionGate` returns `busy`/`owner-typing` and automated nudges to those agents wait until the owner leaves copy-mode. Only the explicit `remind` path cancels copy-mode. Before this pin, those agents could not enter that state from the mouse.
- **Test sketch:** assert `agentClientAttachCommand("coord-7", id, true)` contains neither `mouse on` nor `if-shell` for `antigravity`, `muse`, `gemini` and `opencode`.

**F3. codex `adfe985c`: the real-client test is unreliable under load (blocking for the test)**

- **Where:** `test/tmux.test.ts:1585-1680`.
- **Rule:** A fast-tier test must be deterministic under the parallel load that `pnpm check:fast` produces.
- **Failure:** In my runs the test failed 3 of 8 times when four suites ran at once, each time while launching seven panes plus `script`. The recorded hook history shows `check:fast` failing and then passing on the identical index `ab85e620…`, which is consistent with this. The coordinator's final checks could fail intermittently at an approved pin.
- **Fix sketch:** if this test is kept, launch only the windows each assertion needs. The antigravity and claude seven-agent coverage gets the same assurance from attach-command and session assertions without seven live drags.

**F4. antigravity `e5c9a43f` and claude `ea9a12ba`: the primary-session marker also covers the control window (non-blocking)**

- **Where:** `src/tmux.ts:549` (antigravity) and `src/tmux.ts:557` (claude). `configureSessionScrolling(session)` marks `coord-<n>` itself.
- **Rule:** Owner guidance scopes clipboard writes to coordinator-managed **agent** windows.
- **Failure:** An owner attached to `coord-<n>` who drags in the `control` window sends that selection to the pasteboard. Codex's per-window `@coord-copy-window` marker avoids this. The effect is limited to coord's own session; unrelated sessions are unaffected.
- **Test sketch:** copy the first line of `coord-9:control` and assert the sink still holds its sentinel. This would need a window-level marker check in `scopedCopyCommand`.

**F5. antigravity `e5c9a43f` and claude `ea9a12ba`: negative clipboard assertions depend on timing (non-blocking)**

- **Where:** antigravity `test/tmux.test.ts:1829-1832` (a fixed 250 ms sleep); claude `test/tmux.test.ts:1763-1767` (relies on earlier copy jobs having finished before a later positive copy is seen).
- **Rule:** An "unrelated session never writes" assertion must wait for that copy job to finish.
- **Failure:** If the scope guard regresses and the unrelated job runs slowly, it can write after the check, and the test passes anyway.
- **Fix sketch:** reuse codex's technique: append `; tmux wait-for -S copy-finished` to the installed `copy-command` in the test, and `wait-for copy-finished` after each negative copy.

### Scope, reuse and coverage

- **antigravity:**
  - Reuses `sessionScrollOptions`, `configureSessionScrolling`, `commandsIn`, `ok()` and the isolated `-L` suite.
  - Its real test reimplements `runTmux`'s spawn logic in about 12 lines (`test/tmux.test.ts:1762`) to pass a clean environment.
  - It is the only pin whose mocked and real tests both enumerate all seven agent ids, and it checks clipboard delivery from the primary session for the non-mouse agents.
- **claude:**
  - Same reuse. It removes the marker from `process.env` around the private server instead of duplicating the runner.
  - Seven-agent coverage is in the attach-command test; the real test uses Codex, Cursor and Muse plus an unrelated session and an owner value.
  - Narrower than antigravity, with no extra code.
- **codex:**
  - Reuses `shellQuote` and the existing fixtures.
  - Adds the most code: a shell-script copy command, a global binding and per-window options. It also changes the `agentClientAttachCommand` signature.
  - Its coverage drives real drags through `script`, which is valuable, but F1 to F3 apply.

### Recommendation

Adopt **antigravity `e5c9a43f1b050d6e6e551c9b56d7b295f4a60378`**. Its product code matches claude `ea9a12ba08a62bf179911997ce292ab7438de3c2`, and it has the most complete focused seven-agent coverage. F4 and F5 are optional follow-ups.

Do not adopt **codex `adfe985c7853c748ae1855268235cc6f8a045265`** as it stands: F1 and F2 change working behavior in Claude, OpenCode, Antigravity and Muse windows, and F3 makes the fast tier flaky.

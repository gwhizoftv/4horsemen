# Issue 213 implementation comparison (claude)

Bound implementation pins:
- codex `b533cb49a583b3410ad8f465973967f0cdee6fb0`
- claude `36ed2ce76ed196bdc9f81b94d560a00e08f095d7`
- cursor `12a121c53b47d191741ef0b6095a55903d1a3b08`
- antigravity `2f91238869e37480e364406de7c370da2c2a31a2`

All four were read from the bound worktrees, with each peer's source, tests and
docs compared file by file against the claude pin using `diff`.

## Comparison

### Shared behavior

All four pins implement the selected plan the same way and change the same
product files:
- Claude gets `editorMode: "normal"` in the clone-local
  `.claude/settings.local.json`, and an explicit owner value is kept.
- Codex launches with `-c tui.vim_mode_default=false`.
- Codex sends `i` only when its footer shows `Vim: Normal`, at both send sites.
- Claude skips the `a` prelude when the clone-local `editorMode` is
  `"normal"`.
- `pipe-pane` runs a `sysread` perl filter that stamps the first byte of each
  line. Both `#` and `%` are doubled, and `cat` is the fallback when perl is
  missing.
- `documentationProfileSchema.checks` may be empty.
- Onboard and install propose an exact tracked prose allowlist: root `*.md`
  minus agent-instruction files, plus `docs/**/*.md`, minus critical paths.
  Its hook and final command lists are empty.
- `coord onboard --declare` is forwarded to `install`.

None of the pins adds a file, a dependency, a `--settings` launcher flag or a
Cursor `editor` overlay. Each extends only the existing test files and the two
docs.

### Findings

1. **Uninstall removes an owner's pre-existing `editorMode: "normal"`.**
   - **Where:** claude `src/agentHookSync.ts:243`, cursor
     `src/agentHookSync.ts:266`, antigravity `src/agentHookSync.ts:263`.
   - **Rule:** uninstall removes only what coordination added. Sync keeps an
     owner's explicit `editorMode`, so removal must not treat the default
     value as proof that coord owns it.
   - **Failure:** the owner's `.claude/settings.local.json` already has
     `{"editorMode":"normal"}` before install. Install keeps it; uninstall
     then deletes it, because `next.editorMode === "normal"` is the only test.
     The owner's setting is lost.
   - **Codex** fixes this. A `COORD_CLAUDE_EDITOR_MODE=normal` assignment on
     the managed SessionStart hook records that coord added the key
     (`src/agentHookSync.ts:11`, `:78-85`), and removal checks it (`:277`).
   - **Test (exists in codex's pin):** `test/agentHookSync.test.ts:118`,
     `it.each(["normal", "vim"])("preserves an owner's Claude editorMode %s
     through install and uninstall", …)`. It fails on the claude, cursor and
     antigravity pins for `"normal"`.

2. **Only codex tests that a prompt without a newline is recorded before EOF.**
   - **Where:** claude `test/tmux.test.ts` ~L1437, plus the matching assertions
     in cursor and antigravity.
   - **Rule:** terminal logs must record a TUI prompt line when it arrives,
     not at the next newline or process exit. That is the reason for the
     `sysread` filter.
   - **Failure:** the claude, cursor and antigravity tests check stamps only
     after the panes exit. A regression to a line-buffered filter (such as
     `perl -pe`) would still pass them while live prompts went missing from
     the log.
   - **Codex** covers this. Its direct recorder test
     (`test/tmux.test.ts:1368`, "flushes partial terminal chunks…") polls for
     a stamped `prompt without newline` before ending stdin. Its isolated tmux
     run waits for the startup line before letting the script continue, and
     puts `%Y` in the log directory name to exercise the escaping for real.
   - **Behavior:** all four filters use `sysread` and stamp at first byte. I
     ran antigravity's filter directly on a split line and it stamped
     correctly. This is a coverage gap, not a defect.

3. **antigravity: unnecessary churn.**
   - **Where:** antigravity `src/setupWorkspace.ts:178`, `src/state.ts:30`,
     `src/cli.ts:277`.
   - **Rule:** make the smallest change that solves the issue, without
     unrelated refactors or exports.
   - **Failure:**
     - The whole ecosystem proposal is re-indented into an inner
       `baseProposal` closure and then mutated. That is a ~100-line diff of
       unchanged logic in a file other issues also edit.
     - `state.ts` re-exports `repositoryPathSchema`, which is already exported
       from `protocol.js`.
     - The top-level usage line for `coord onboard` still omits
       `[--declare <file>]`, while the per-command help example uses it. The
       main `coord --help` does not list the new flag.
   - **Smallest fix:** keep the proposal as a wrapper (claude, cursor) or a
     sibling function (codex), drop the re-export, and add `[--declare <file>]`
     to the usage line.

4. **cursor and antigravity: minor redundancy.**
   - **Where:** cursor `src/setupWorkspace.ts:335-337`; cursor
     `src/tmux.ts:1311` and antigravity `src/tmux.ts:1296`.
   - **Rule:** each expression should state its condition once.
   - **Failure:** none at runtime.
     - Cursor evaluates `declared.documentation ??
       input.proposal.documentation` twice.
     - `staleOverride !== undefined && requireSentinel` equals
       `requireSentinel`, since `requireSentinel` is
       `staleOverride?.source === "idle-sentinel"`.
   - These are readability notes only.

### Scope, reuse and coverage

| | codex | claude | cursor | antigravity |
| --- | --- | --- | --- | --- |
| Stays within the issue and the approved map | yes | yes | yes | yes |
| New files or dependencies | none | none | none | none |
| Ownership-safe `editorMode` uninstall | yes | no (F1) | no (F1) | no (F1) |
| Docs allowlist filter | tracked mode `100644` only; also excludes `SKILL.md` and any-depth agent files | root agent files excluded | same as claude | same as claude |
| Live-prompt (no newline) log test | yes | no (F2) | no (F2) | no (F2) |
| `%` escaping proven by real tmux | yes (`%Y` path plus stamp regex) | yes (stamp regex) | stamp regex | stamp regex |
| Churn | small | small | small | large (F3) |

All four extend the existing tests:
- `tmux.test.ts`: a Claude `editorMode` case and the updated Codex
  no-footer case.
- `agentHookSync.test.ts`: sync and removal of `editorMode`.
- `verify-config.test.ts`: the prose allowlist proposal.
- `install.test.ts`: the exact codex argv.
- `onboard.test.ts`: `--declare`.

### Ranking

1. **codex.** It has the same behavior as the others, the only
   ownership-correct uninstall, and the strongest focused tests. Its ownership
   marker on the SessionStart hook command is indirect, but it is documented
   in the code and tested.
2. **claude.** Small and correct apart from F1, but it lacks the no-newline
   test.
3. **cursor.** Effectively the claude design. It shares F1 and F2 and adds the
   minor redundancy in F4.
4. **antigravity.** Correct behavior, but it shares F1 and F2 and has the
   churn and help-text gap in F3.

### Checks I ran

- `diff -u` of every changed product, test and doc file in each peer worktree
  against the claude pin.
- A direct run of antigravity's perl filter on a split line.

I did not run the peer test suites. No coordinator verification results are
bound to this action, so missing peer results are not counted as a pass.
Final checks at the approved pin are coordinator-owned.

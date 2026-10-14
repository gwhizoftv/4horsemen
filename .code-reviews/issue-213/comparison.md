## Comparison

This review compares the four bound implementation pins for issue 213:

- codex: `b533cb49a583b3410ad8f465973967f0cdee6fb0`
- claude: `36ed2ce76ed196bdc9f81b94d560a00e08f095d7`
- cursor: `12a121c53b47d191741ef0b6095a55903d1a3b08`
- antigravity: `2f91238869e37480e364406de7c370da2c2a31a2`

All four implementations address the core requirements from Claude's approved plan:
1. Turning off vim mode for Claude (`editorMode: "normal"` in `.claude/settings.local.json`) and Codex (`-c tui.vim_mode_default=false` in `scripts/lib/launcher.sh`).
2. Streaming ISO-8601 UTC millisecond timestamps on every terminal log line in `tmux.ts` (`pipeToLog`).
3. Adding `--declare` support to `coord onboard` in `src/cli.ts` and `src/install.ts`, and documenting verification receipt sharing and caching.
4. Relaxing `documentationProfileSchema.checks` in `src/state.ts` to permit `[]`, and proposing a default `documentation` profile in `src/setupWorkspace.ts`.

However, detailed inspection reveals key differences, strengths, and findings across the implementations.

### Findings

#### Finding 1 (Codex): `src/setupWorkspace.ts:252`

- **File and line**: `src/setupWorkspace.ts:252` in pin `b533cb49a583b3410ad8f465973967f0cdee6fb0`
- **Rule that must hold**: Tracked documentation discovery in `proposeProjectPolicy` must only exclude protocol instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) located at the repository root. Documentation files located within `docs/` (e.g. `docs/CLAUDE.md` or `docs/AGENTS.md`) must be included in the documentation profile. Furthermore, exclusions must not invent unapproved file patterns such as `SKILL.md`.
- **Concrete failure**: Codex checks `["AGENTS.md", "CLAUDE.md", "GEMINI.md", "SKILL.md"].includes(basename(path))`. Because it matches against `basename(path)`, any valid documentation file located inside `docs/` whose basename matches one of these names is dropped from `documentation.paths`. Additionally, parsing `git ls-files --stage` matching only mode `100644` drops markdown files if tracked under other git modes.
- **Smallest illustrative test**:
```ts
it("retains documentation markdown files in docs/ even if their basename matches root instructions", () => {
  const proposal = proposeProjectPolicy(productWithDocs);
  expect(proposal.documentation?.paths).toContain("docs/CLAUDE.md");
});
```

#### Finding 2 (Codex): `src/tmux.ts:325`

- **File and line**: `src/tmux.ts:325` in pin `b533cb49a583b3410ad8f465973967f0cdee6fb0`
- **Rule that must hold**: `readClaudeEditorMode` must be exported from `src/tmux.ts` with explicit typing (`string | undefined`) so unit tests and external callers can verify and inspect Claude's local editor mode setting, mirroring `readCursorVimMode`.
- **Concrete failure**: Codex declared `const readClaudeEditorMode = (agentRoot: string): unknown => ...` without exporting it. As a result, `test/tmux.test.ts` cannot import or test the function directly, reducing diagnostic testability.
- **Correction**: Export `readClaudeEditorMode` as `(agentRoot: string): string | undefined`.

#### Finding 3 (Cursor): `src/tmux.ts:749-751`

- **File and line**: `src/tmux.ts:749-751` in pin `12a121c53b47d191741ef0b6095a55903d1a3b08`
- **Rule that must hold**: Every output line in the terminal log stream must be prefixed with its UTC timestamp, including empty lines.
- **Concrete failure**: In Cursor's perl script, lines are split using `split(/(\n)/, $buf, -1)` and emitted with `print $stamp if $bol && $part ne "\n"`. When an empty line (`\n`) arrives, `$part ne "\n"` evaluates to false, suppressing the timestamp prefix and emitting an unstamped blank line. Additionally, `$stamp` is computed once per 8KB `sysread` rather than evaluated at the start of each line.
- **Smallest illustrative test**:
```ts
it("timestamps empty lines in terminal output logs", () => {
  // Piped "\n" must produce "2026-10-14T11:00:00.000Z \n" rather than a bare "\n"
});
```

### Detailed Evaluation

1. **Codex (`b533cb49a583b3410ad8f465973967f0cdee6fb0`)**:
   - Stays within the approved file map and satisfies the issue's requirements.
   - Reuses existing test infrastructure and config helpers.
   - Suffers from the documentation basename filter bug (`src/setupWorkspace.ts:252`) and leaves `readClaudeEditorMode` unexported and untyped.

2. **Claude (`36ed2ce76ed196bdc9f81b94d560a00e08f095d7`)**:
   - Faithfully follows the approved plan without scope creep or unapproved changes.
   - Clean, concise Perl filter with `$|=1` flushing, lookbehind newline splitting, and per-line UTC timestamp generation.
   - Correctly restricts instruction file exclusions to root-level markdown files (`!path.includes("/") && !AGENT_INSTRUCTION_FILES.has(path)`).
   - Exports and directly tests `readClaudeEditorMode`. Comprehensive, focused tests across all affected modules.

3. **Cursor (`12a121c53b47d191741ef0b6095a55903d1a3b08`)**:
   - Satisfies the issue requirements within approved files.
   - Correctly filters root-only instruction files.
   - Implements a more verbose perl script that computes timestamps per chunk rather than per line start, and omits timestamps on blank lines.

4. **Antigravity (`2f91238869e37480e364406de7c370da2c2a31a2`)**:
   - Follows the approved plan accurately and cleanly.
   - Employs the robust, verified Perl one-liner for line-by-line UTC timestamping with `#` and `%` format escaping for tmux `pipe-pane`.
   - Correctly handles root-only exclusion for `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md`.
   - Exports `readClaudeEditorMode` and adds targeted unit and system tests.
   - Removed unused helper `codexVimInsert` in `src/tmux.ts` to satisfy strict linter checks and ensure clean pre-commit check passes.

### Conclusion

Claude (`36ed2ce76ed196bdc9f81b94d560a00e08f095d7`) and Antigravity (`2f91238869e37480e364406de7c370da2c2a31a2`) provide the most robust and accurate implementations, strictly adhering to the approved plan with clean, bug-free implementations of terminal logging and documentation policy proposals.

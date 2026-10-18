# Issue 238 — Implementation comparison

Bound pins compared (product trees from the coordinator worktrees):

- claude `6f585a13e6c88058c917d6c725f37e6092475c05`
- cursor `b454bb3430e636f3144d19e59b169043b8ab8fd1`
- antigravity `94b0da3d60ef3dc5e05b1019b81afb19b6396462`
- codex `0968ef2b00bd7fa79c910360dc037d2906b1a39b`

All four change the same five product paths (`src/setupWorkspace.ts`,
`src/install.ts`, `test/verify-config.test.ts`, `test/onboard.test.ts`,
`docs/setup-workspace.md`). No pin adds a product file or dependency. Each
sets the shared Flutter `analyze` argv to
`["flutter", "analyze", "--no-fatal-infos", "--no-fatal-warnings"]` and leaves
`flutter test` unchanged; `test/verify-config.test.ts` expectations match.
Differences are in `logProjectPolicy`, the onboard declared-policy coverage,
and docs prose.

## Comparison

1. **cursor `b454bb3430e636f3144d19e59b169043b8ab8fd1` /
   antigravity `94b0da3d60ef3dc5e05b1019b81afb19b6396462` —
   `src/install.ts:307–311`.** Both filter
   `effectiveCommands` to Flutter commands that include `--no-fatal-infos`, then
   use `.every(... "--no-fatal-warnings")` on that subset. The install summary
   must reflect whether warnings are fatal for the effective analyzer gates.
   With inferred precommit
   `["flutter","analyze","--no-fatal-infos","--no-fatal-warnings"]` and declared
   finalization `["flutter","analyze"]`, the plain analyze command is dropped
   from the filter, `.every` succeeds on the remaining relaxed precommit alone,
   and the summary prints that only errors are fatal while finalization still
   fails on warnings and infos. Smallest illustrative test (present on claude /
   codex, absent here): declare `checks: [{ name: "analyze", argv: ["flutter", "analyze"] }]`
   with inferred relaxed precommit and assert the summary does not contain
   `leave only analyzer errors fatal`.

2. **claude `6f585a13e6c88058c917d6c725f37e6092475c05` —
   `src/install.ts:307–312`.** After the outer `--no-fatal-infos` gate, Claude
   runs `.every(... "--no-fatal-warnings")` over every
   `flutter` / `analyze` command, so the mixed plain-finalization case above
   correctly avoids the fully-relaxed sentence (and onboard covers both
   `--no-fatal-infos`-only and plain `flutter analyze`). The explanation that
   remains when `.every` fails still says informational diagnostics do not
   block. That wording must not claim infos are non-fatal when any effective
   analyze command omits `--no-fatal-infos`. For the same mixed declaration,
   finalization still exits non-zero on infos while the summary asserts they
   do not block. Prefer Codex’s silence (or a severity-accurate sentence) for
   that mixed set; keep Claude’s all-analyzer `.every` for the warnings check.

3. **codex `0968ef2b00bd7fa79c910360dc037d2906b1a39b` —
   `src/install.ts:307–312` and `test/onboard.test.ts` (Flutter declare
   block).** Codex filters to `flutter analyze`, prints a fatality line only
   when every analyze command includes `--no-fatal-infos`, then chooses the
   relaxed vs warnings-fatal sentence by whether every command also includes
   `--no-fatal-warnings`. That avoids both false claims above for a plain
   finalization analyzer beside a relaxed precommit (no fatality line), and
   the onboard case asserts the summary contains neither
   `informational diagnostics do not block` nor
   `leave only analyzer errors fatal`. Tradeoff: a mixed policy gets no
   fatality explanation at all, which is conservative but thinner than a
   per-severity description. Within the issue’s “reflect whether warnings are
   fatal,” this is the only pin that both detects the plain-analyze mix and
   refuses to mislabel it.

4. **Scope and reuse (all pins).** Each pin reuses the shared `analyze` object
   in `proposeToolchainPolicy`, extends the existing Flutter
   `verify-config` / onboard cases, and updates the Product languages table
   plus the Flutter prose. Cursor and antigravity’s `install.ts` bodies match;
   their onboard coverage is the single infos-only declare (antigravity uses
   `else` after the python block). Claude adds the plain-analyze declare loop.
   Codex adds infos-only plus plain-analyze declares and slightly longer docs
   (reinstall / declaration precedence). None of the extra docs text expands
   the file map.

**Verdict.** Prefer codex `0968ef2b00bd7fa79c910360dc037d2906b1a39b` for the
install-summary decision and its plain-analyze regression, or claude
`6f585a13e6c88058c917d6c725f37e6092475c05` if the all-analyzer warnings
`.every` is kept but the fallback sentence is corrected so it does not claim
infos are non-fatal when a plain analyze gate is present. Cursor and
antigravity share the subset-filter bug and should not be selected without
that fix. No product suite was run for this evidence-only comparison.

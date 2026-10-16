# Issue 230 implementation comparison (claude)

## Comparison

Bound implementation pins compared (read from the coordinator's worktrees):

- claude `cc767a47d481ff24b9bee4a2109872eed4bf73de`
- cursor `af7bc76b9a43ce64873560670bafe03da9cd75e5`
- codex `bf0763a60d36f1d322d1f8bb36ee819742b7784f`

I compared each changed product file with `diff -u` between the three
worktrees.

### Behaviour: the three implementations are functionally equivalent

All three implement the selected plan identically where it matters at runtime:

- **`scripts/lib/launcher.sh`:**
  - `launcher_environment` uses an `antigravity || muse` PATH branch for
    `$HOME/.local/bin` and exports `MUSE_NO_AUTO_UPDATE=1` for Muse.
  - The `muse)` case emits exactly
    `exec muse --approval-mode never --disable-sandbox --trust-workspace`,
    with no `coord_grant`.
- **`src/cli.ts`:** the maintenance map holds `{ executable, update }`, with
  `muse → { muse, update: false }`. The updater loop prints
  "has no update command" and skips `update`, and the version loop is
  unchanged. Cursor renames the map to `agentMaintenance`; the logic is
  otherwise identical.
- **`src/setupWorkspace.ts`:** Muse UI defaults are
  `[] / ["Enter"] / "Basic"`, and `delivery` is
  `agent === "muse" ? "pull" : "both"`.
- **`src/tmux.ts`:** `vimInsertPrelude` excludes `muse`. Only comments differ.
- **Ignores:** `.muse/` is added identically in `src/productIgnore.ts`,
  `templates/product/gitignore.coordination.block` and `.gitignore`.
- **`config.example.json`:** the Muse entry is byte-identical.

Scope and reuse are the same for all three:

- Each changes the same 13 product and test paths, all inside the approved
  map.
- None creates a file. None of `src/vendors.ts`, `scripts/setup_muse.sh` or
  `start-muse.sh` is tracked.
- None changes the default roster, hooks, the shell guard or tmux readiness.
- Each reuses the existing launcher library, the maintenance loop, the
  installer fixtures (`product`, `installOnce`) and the existing CLI and tmux
  test helpers.

Each adds exactly one focused case per test file. The differences are in how
strongly those cases prove the behaviour, and in comment quality.

### Findings

**1. claude `test/install.test.ts:1256` and cursor `test/install.test.ts:1254`: the Muse launcher test inherits the owner's PATH**

- **Rule.** A generated-launcher test must isolate PATH. It must prove that
  `launcher_environment` itself puts `$HOME/.local/bin` first, and it must
  never be able to execute a real vendor CLI.
- **Concrete failure.**
  - Both tests pass `{ ...process.env, HOME: home, … }`. Cursor sets
    `PATH: process.env.PATH` explicitly.
  - On this machine the inherited PATH already contains the owner's real
    `~/.local/bin`, which holds the real Muse wrapper
    (`~/.local/bin/muse`, Muse Code 1.4.10).
  - Suppose a later edit drops `muse` from the PATH branch in
    `launcher_environment`. The fixture stub is then no longer first on PATH,
    and `start-muse.sh` would `exec` the owner's real Muse in the fixture clone
    with `--approval-mode never --disable-sandbox`.
  - The test is then not a deterministic regression signal. Its outcome depends
    on what the real CLI does without a TTY, and it may start an unattended,
    unsandboxed vendor session under the account.
  - On a machine without Muse on PATH, the same regression fails cleanly only
    by accident.
- **Smallest illustrative test.** Codex's version at
  `test/install.test.ts:1235` sets `env: { …, PATH: "/usr/bin:/bin", … }`, so
  only the prepend can find the stub. Apply the same one-line change to the
  claude and cursor tests.

**2. claude `scripts/lib/launcher.sh:48`: the rewritten header comment ran into the next sentence**

- **Rule.** The `launcher_command` header is the explanation of grant
  semantics that both generators share, so it must stay readable and wrapped
  like the rest of the file.
- **Concrete failure.** My edit replaced the first three lines of the
  paragraph but left the rest of the original line attached. Line 48 now reads
  "…runs unsandboxed; see its case. That array is computed by the generated
  launcher at exec time", one 140-column line in a file otherwise wrapped near
  80. There is no runtime effect, but the paragraph about `coord_grant`
  expansion is harder to read and looks like a merge accident. Cursor (rewrapped
  paragraph) and codex (rewrote the opening and kept the wrap) do not have this
  defect.
- **Fix sketch.** Rewrap lines 46–51 as cursor did. No test applies.

**3. claude and cursor install tests do not cover what the docs claim about the shim**

- **Rule.** Each implementation's `docs/setup-workspace.md` and launcher
  comment say Muse's only coordination guard is the coordinator Git shim on
  PATH. Tests should pin the launcher behaviour that claim depends on:
  - `.coord/bin` comes first on PATH for the launched Muse process;
  - `COORD_ISSUE` reaches that process;
  - manual mode (empty `COORD_ISSUE`) still launches.
- **Concrete failure.** The claude and cursor tests capture only argv and
  `MUSE_NO_AUTO_UPDATE`. A regression that moved the `.coord/bin` prepend
  after `$command`, or dropped `COORD_ISSUE` from Muse's environment, would
  leave both tests green. Muse would then run with no coordination guard at
  all, contradicting the docs.
- **Illustrative test.** Codex's test (`test/install.test.ts:1214–1250`)
  covers this. Its stub records
  `"$MUSE_NO_AUTO_UPDATE" "$(command -v git)" "$COORD_ISSUE"`, and it asserts
  `1\n<clone>/.coord/bin/git\n<issue>\n` for both `COORD_ISSUE=17` and the
  manual empty value. It also checks `.gitignore` and
  `git check-ignore .muse/hooks.json` in the generated clone.

**Weaker-coverage differences (no defect):**

- **CLI maintenance test.** Codex asserts the complete call order: existing
  vendors still run `update` then `--version`, and Muse appears only as
  `muse --version`, last. Claude asserts `toContain` / `not.toContain` on Muse
  alone. Cursor replaces the roster with Muse only, under `--profile solo`.
  All three fail on the baseline, but codex's version also guards the
  existing-vendor ordering in the same case.
- **tmux key test.** All three assert the same three expectations. Claude
  appended them to the Codex-vim test and cursor to the Cursor-vim test.
  Codex made a dedicated `it("keeps Muse owner reminders free of vim preludes and Escape")`,
  which reports a Muse regression by its own name.

### Docs

- **Claude:** gives Muse its own `### Muse Code` subsection.
- **Cursor:** a shorter, accurate paragraph. It omits the unverified-containment
  statement that the plan review (F8) and the ballot asked for.
- **Codex:** states the unrestricted write scope ("no filesystem isolation is
  claimed"), unverified shim coverage, the observed 1.4.10 build, and that the
  stub tests do not prove a live run. This is the most candid of the three.

All three READMEs make the same one-line roster change.

### Ranking

1. **codex `bf0763a6`.** Same behaviour, but the strongest focused tests:
   - isolated PATH;
   - shim and `COORD_ISSUE` delivery;
   - a manual-mode launch;
   - full maintenance ordering;
   - ignore checked in a real clone.

   It also has clean comments and the most candid docs. I found no defects.
2. **cursor `af7bc76b`.** Correct, with clean comments. Its install test has
   the PATH-inheritance weakness (finding 1) and the missing shim coverage
   (finding 3), and its docs omit the containment caveat.
3. **claude `cc767a47`.** Correct, but it has finding 1, finding 2 (malformed
   header comment) and finding 3.

Recommended pin: **codex `bf0763a60d36f1d322d1f8bb36ee819742b7784f`**.

Checks performed for this comparison:

- `diff -u` of every changed product and test file across the three bound
  worktrees;
- inspection of the cited lines;
- confirming that the owner's PATH contains `~/.local/bin`, which holds the
  real `muse`.

I did not re-run the peers' suites. Hook-run and coordinator-run results for
these pins are not restated or claimed here.

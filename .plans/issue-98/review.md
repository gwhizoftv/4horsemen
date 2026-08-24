# Issue 98 — plan review

Bound plans reviewed:

- cursor `4f96e513360d5ddf60d77b957336b5d61334a264` at `.plans/issue-98/plan.md`
- claude `cf42e129554604df5a61a5ca917157cc6deb9053` at `.plans/issue-98/plan.md`
- codex `208c3833c1815b78ab2496b2f4aab30de96aa416` at `.plans/issue-98/plan.md`

All three agree on the shape: move only the completion receipt to a sibling
`completes/` tree, keep `action.md` and every other runtime file coordinator-owned,
derive the root as `dirname(coordRoot)/completes` with an override, and grant each
harness only its own drop. The findings below are where a plan, followed as
written, produces a broken tree.

One fact worth recording before the findings, because two plans hedge on it and
one asserts it: **all four harness CLIs installed on this machine accept
`--add-dir`.** Verified by running `--help`:

- `claude --add-dir <directories...>` — "Additional directories to allow tool"
- `codex --add-dir <DIR>` — "Additional directories that should be writable alongside the primary workspace"
- `agy --add-dir` — "Add a directory to the workspace (repeatable)"
- `agent --add-dir <path>` — "Add an additional workspace root directory"

So codex's flag claims are correct, and cursor's and claude's "prefer a
writable-root flag when the CLI supports it" hedges can be resolved to a
commitment. No plan needs a `danger-full-access` fallback for Codex.

## Findings

### 1. cursor — the launcher signature change requires editing a file the plan's map excludes

**Claim.** cursor, *Exact File List*: "`scripts/lib/launcher.sh` — extend
`write_launcher` with a fifth argument: absolute mailbox drop dir for the current
agent/issue." The map lists `src/setupWorkspace.ts` and `src/cli.ts` as the
callers to update. `githooks/post-merge` appears nowhere in the map.

**Rule.** `scripts/lib/launcher.sh` has exactly two callers, and its own header
comment names both: `src/setupWorkspace.ts:462` and `githooks/post-merge:44`. The
hook calls `write_launcher "$launcher" "$AGENT_NAME" "$AGENT_LABEL" "$SHARED_BRANCH"`
— four arguments. `docs/repo-map.md` states that approved paths are the authority:
an implementation may change only the paths named in the selected plan's file map.

**Failure.** After the change, `$5` is unset in the hook's call. `githooks/post-merge`
sets no `set -u`, so `write_launcher` binds an empty drop directory and emits
`exec claude --permission-mode auto --add-dir ""`. The hook fires exactly when a
merge deleted the launcher, and it never overwrites an existing file
(`githooks/post-merge:34`), so the broken launcher is permanent for that clone.
The next `coord start` launches a harness with an empty or malformed grant; the
agent cannot write `complete`, and the run stalls with no diagnostic pointing at
the launcher. The implementer cannot fix it, because `githooks/post-merge` is not
an approved path.

**Smallest correction.** Add `githooks/post-merge` to the file map, and specify
that when the drop directory is unresolvable the hook prints an actionable message
and exits 0 without writing a launcher — a missing launcher is regenerated on the
next merge, a silently ungranted one never is.

### 2. codex — a grant gated on `COORD_ISSUE` is absent whenever the launcher is run directly

**Claim.** codex, *Exact File List*, `scripts/lib/launcher.sh`: "when COORD_ISSUE
is a positive integer, read the absolute coord.completesRoot clone key, derive
only the current issue/current-agent drop directory … Manual mode has no issue
environment and receives no mailbox grant."

**Rule.** `COORD_ISSUE` is set on the tmux *session*
(`src/tmux.ts:696`, `src/tmux.ts:741`), so only a harness started by
`startSession`/`ensureSession` inherits it. The generated launcher is not
tmux-only: its own banner tells the operator that running it enters automated
issue mode — "Automated issue mode: fetch your coordinator action with: `coord
next --issue <n>`" (`scripts/lib/launcher.sh`, the `cat > "$path"` heredoc).
Nothing in the launcher distinguishes the operator's intent; only the presence of
an environment variable set elsewhere does.

**Failure.** An owner who starts `./start-claude.sh` from a plain Terminal —
the documented way to enter automated issue mode without tmux — gets a harness
with no mailbox grant. The agent does its work, pushes, and is then refused when
it writes the completion SHA, which is the exact sandbox refusal this issue
exists to remove. The failure is silent at launch and only surfaces at the last
step of the action.

**Smallest correction.** Make the grant issue-independent so it does not depend on
`COORD_ISSUE`: order the mailbox segments `completes/<agent>/issue-<n>/complete`
and grant `completesRoot/<agent>`, which is stable for every issue and still
never covers a peer. (This is the ordering claude's plan argues for, for the
adjacent reason that install-time launcher generation cannot know an issue
number; the same segment order resolves both.)

### 3. all three plans — the derived default resolves to a single shared `<tmpdir>/completes` under test

**Claim.** All three plans default `completesRoot` to `dirname(coordRoot)/completes`.
Only codex mitigates the test consequence, and only in one file:
"`test/support/workspaceFixture.ts` — give every product fixture a unique mailbox
root so parallel tests never share the host's generic sibling completes directory."
cursor's map does not mention fixtures. claude's map changes `makeProduct` only.

**Rule.** A test must not read or delete state another test wrote. Every unit test
that drives completions builds its coord root with `mkdtempSync(join(tmpdir(), …))`
and cleans up by removing only that root: `test/runLoop.test.ts:40`,
`test/integration.test.ts:46` and `:410`, `test/state.test.ts:28`,
`test/agentLifecycle.test.ts:249`, `test/agentEvent.test.ts:44`,
`test/agentLanguage.test.ts:44`. None of these uses
`test/support/workspaceFixture.ts` — that fixture serves the installer tests.

**Failure.** `dirname(mkdtempSync(join(tmpdir(), "coord-loop-")))` is `<tmpdir>`, so
the derived mailbox for every one of those files is the same `<tmpdir>/completes`.
`test/runLoop.test.ts` and `test/integration.test.ts` both use issue 1 and the
agent ids `claude`/`codex`, so both resolve to the identical receipt path.
vitest runs test files in parallel workers: `test/runLoop.test.ts:1081` writes a
SHA that `test/integration.test.ts`'s poll can read, and the `clearCompletion`
assertion at `test/runLoop.test.ts:1115` deletes a receipt the other file is
waiting on. The suite passes or fails by scheduling, and nothing ever removes
`<tmpdir>/completes`, so receipts also leak between runs on a developer machine.
codex's fixture change does not reach any of these files.

**Smallest correction.** Make the mailbox root a required parameter at the
`issueRuntimePaths` boundary rather than a defaulted one, and derive the sibling
default only in the install/start resolution layer. Every test call site then
fails to compile until it passes a root inside its own temp directory, which
turns an invisible cross-test coupling into a build error.

### 4. cursor — bumping `RUNTIME_FORMAT_VERSION` destroys the analytics baseline the issue asks for

**Claim.** cursor, *Exact File List*, `src/state.ts`: "bump `RUNTIME_FORMAT_VERSION`
to **3**." *Risks*: "Runtime format bump breaks old `start.json` — acceptable per
issue scope; abandoned issues are wiped or restarted under format 3."

**Rule.** `RUNTIME_FORMAT_VERSION` (`src/state.ts:29`) is asserted as
`z.literal(...)` in three schemas, not one: `startStateSchema` (`:242`),
`cursorsStateSchema` (`:335`), and `journalEventSchema` (`:394`). `readJournal`
(`src/state.ts:551-562`) parses *every* line of `journal.jsonl` through
`journalEventSchema`, and `coord analytics` reads its input through that function
(`src/cli.ts:1106`).

**Failure.** The issue's own carry-forward paragraph names the measurement that
must still run: "the next run's `coord analytics --issue 92` against the issue-88
baseline is what tells you whether the context and wait changes actually paid."
After the bump, that command throws on the first pre-existing journal line, whose
`formatVersion` is 2. The mitigation does not apply: a completed historical issue
cannot be "wiped or restarted under format 3" — re-running it is what would have
to produce the baseline being compared against. The comparison becomes
unproducible, permanently, as a side effect of a change that adds one field to
one document.

**Smallest correction.** Do not bump the format version. Add `completesRoot` to
`startStateSchema` as a required field; a pre-change `start.json` then fails
closed with an error naming the missing field, while `cursors.json` and
`journal.jsonl` — neither of which changes shape — stay readable.

### 5. cursor — the Antigravity grant is routed through a script no `coord` command runs

**Claim.** cursor, *Exact File List*: "`scripts/setup_antigravity.sh` — when coord
install/start passes a mailbox prefix, append it to `trustedWorkspaces`
idempotently (same pattern as clone trust today)", with the same shape proposed
for `scripts/setup_codex.sh`.

**Rule.** A grant that must change per issue has to be applied by something that
runs per issue. `scripts/setup_*.sh` are operator bootstrap scripts — the header
of `scripts/setup_antigravity.sh` reads "Run from the root of your MASTER repo" —
and nothing under `src/` invokes any of them (no reference to `setup_antigravity`,
`setup_codex`, `setup_claude`, or `setup_cursor` exists outside `scripts/`,
`tags`, and test fixtures). `coord install` and `coord start` never call them.

**Failure.** Under cursor's `completes/issue-<n>/<agent>` layout the trusted path
changes every issue, but the only writer of `trustedWorkspaces` is a script the
operator must run by hand. Either the operator re-runs `./scripts/setup_antigravity.sh`
after every `coord start` — undocumented in the plan and impossible to forget
safely, since forgetting produces a silent write refusal at completion time — or
Antigravity never receives a grant at all and the issue is not fixed for that
agent.

**Smallest correction.** Put the Antigravity grant in the generated launcher,
where `coord` actually controls it: `agy --add-dir <abs>` exists (verified above),
so no `trustedWorkspaces` edit is needed for the mailbox.

### 6. codex — the `scripts/setup_antigravity.sh` entry describes behavior that file does not have

**Claim.** codex, *Exact File List*: "`scripts/setup_antigravity.sh` — stop
installing broad non-workspace access that would defeat the per-drop launcher
sandbox, retain trust only for the Antigravity clone itself."

**Rule.** A file-map entry is an authorization to change specific behavior; the
behavior it names must exist in the file.

**Failure.** `scripts/setup_antigravity.sh` installs exactly two things into
`~/.gemini/antigravity-cli/settings.json`: a command allowlist
(`scripts/setup_antigravity.sh:124-160`) and `trustedWorkspaces` entries that are
*only* the agent clones (`:171-175`). There is no broad non-workspace access to
stop installing — the file already does what the entry asks for. An implementer
holding this entry as approved scope either changes nothing (leaving an
unexplained no-op in the approved map) or reads the command allowlist as the
"broad access" and removes it. Removing it reintroduces the owner-prompt-per-tool-call
regression that `test/install.test.ts:509-516` documents in its comment: an
Antigravity that prompts on every out-of-whitelist call shows up in analytics as
agent wait, not work.

**Smallest correction.** Drop the entry, or restate it as the concrete change
intended and verify it against the file first.

### 7. codex — enabling harness sandboxes for Antigravity and Cursor is scope beyond the issue, and its test cannot detect the failure

**Claim.** codex, *Exact File List*, `scripts/lib/launcher.sh`: "Cursor enables
its sandbox plus add-dir; Antigravity enables its sandbox plus add-dir while
retaining unattended approvals inside that sandbox." *Tests*, item 5: "Codex no
longer launches danger-full-access, Cursor/Antigravity explicitly enable their
sandboxes … Stub harnesses will assert the current issue/agent drop is granted."

**Rule.** The issue asks that the completion write stop requiring a broad grant.
It does not ask that harnesses which run unsandboxed today start running
sandboxed. `agy --sandbox` is documented by its own `--help` as "Run in a sandbox
with **terminal restrictions** enabled", and the Antigravity launcher today is
`exec agy --mode accept-edits --dangerously-skip-permissions`
(`scripts/lib/launcher.sh:41`), a combination whose necessity is recorded in that
file's comment and guarded by `test/install.test.ts:517-523`.

**Failure.** An agent working an issue must run `git push` and `pnpm check:fast`
from its terminal. With terminal restrictions newly enabled, those calls are
blocked or prompt, so the agent cannot push the commit whose SHA it is then asked
to write — a strictly worse outcome than the write refusal being fixed, and the
same wait-time regression the existing test exists to prevent. A stub harness that
asserts which arguments appear in the generated launcher cannot observe it: the
string `--sandbox` is present either way.

**Smallest correction.** Change only what the completion write requires: add
`--add-dir <drop>` for all four vendors and drop Codex's `danger-full-access`.
Leave each vendor's existing sandbox and approval posture alone; if tightening
Antigravity and Cursor is worthwhile, it is a separate issue with a test that
runs the real CLI.

### 8. claude (this agent's own plan) — startup rollback is not in the file map

Recorded so the same standard applies to all three plans. claude's map covers
`src/cli.ts` for start/resume path threading and `src/wipeIssue.ts` for wipe, but
never mentions the failed-start rollback at `src/cli.ts:748`, which does
`rmSync(paths.issueRoot, …)` and would now leave the newly created
`completes/<agent>/issue-<n>` directory behind. **Rule:** a failed `coord start`
must leave no runtime state for that issue, because `startIssue` refuses to start
when state already exists (`src/cli.ts:685`). **Failure:** a start that fails
after `createIssueRuntime` leaves an orphan drop directory; if a stale receipt is
ever in it, a later re-start of the same issue number reads it as a completion.
Both cursor and codex caught this ("Roll failed `coord start` cleanup must remove
`completes/issue-N/`" / "Startup rollback must remove both newly created issue
trees"); claude's plan should adopt it.

## Conclusion

The three plans converge on the same design, and the disagreements are narrow
enough to merge rather than choose between blindly.

Adopt as the basis: **codex's plan**, which is the most complete on containment,
symlink and no-follow handling on the receipt read, doctor findings, and cleanup
scoping across wipe/uninstall — with findings 2, 6, and 7 applied. Finding 2 is
the one that changes its design rather than its wording: the `COORD_ISSUE` gate
must go, and the segment order must become `completes/<agent>/issue-<n>/complete`
so the grant is issue-independent. Findings 6 and 7 are subtractions — remove the
`scripts/setup_antigravity.sh` entry and the sandbox changes — and both shrink
the file map.

Take from **claude's plan**: the agent-first segment order and the argument for it
(install-time launcher generation cannot know an issue number), and the
`coord.completesDir` clone key threaded to both launcher callers.

Take from **cursor's plan**: the startup-rollback requirement (finding 8) and the
explicit `config.example.json` / `docs/setup-workspace.md` documentation entries.
Do not take the `RUNTIME_FORMAT_VERSION` bump (finding 4) or the
`scripts/setup_*.sh` grant route (finding 5), and if any plan keeps a fifth
positional argument on `write_launcher`, `githooks/post-merge` must be in the map
(finding 1).

Finding 3 blocks all three as written and must be resolved in whichever plan is
selected: with a defaulted sibling root, every completion-driving unit test
shares one `<tmpdir>/completes`, and the suite becomes order-dependent in exactly
the code path this issue changes.

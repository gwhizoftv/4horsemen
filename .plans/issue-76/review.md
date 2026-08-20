# Issue 76 plan review — Claude

Plans reviewed at the bound pins:

- cursor — `873c6b403f005930f76710999edfb783df228b5e` `.plans/issue-76/plan.md`
- antigravity — `857dde07fcd6a3ff8e3b79766bfe8f7edeeb071d` `.plans/issue-76/plan.md`
- codex — `7ef62d1a768369db755580e181187c2d2c8a0a10` `.plans/issue-76/plan.md`
- claude — `fd94704ec62d3a309ed07ca257e1fa743cd04d15` `.plans/issue-76/plan.md`

All four converge on the same architecture: `coord manual` as a workspace-scoped
launch/attach lifecycle over `TmuxController.ensureSession` +
`openOwnerAgentClients({ onlyMissing: true })`, no issue runtime, no run loop,
hooks untouched, version bumped to `0.0.12`. The findings below are the places
where a plan, followed as written, produces a wrong or unverifiable
implementation. Findings 2, 5 and 6 include my own plan.

## Findings

### 1. An un-grouped `coord-manual` session name collides across products — antigravity

**Plan claim.** antigravity `857dde0`, "Files to change" item 2: "For
`issue === "manual"`, format session name as `coord-manual` (un-namespaced) or
`coord-manual-${safeName(group)}` (namespaced/grouped)". Its test list repeats
this: "`sessionName("manual")` returns `coord-manual` (flat) and
`coord-manual-<group>` (namespaced)", and its detach tests target
`coord-manual[-<group>]`.

**Rule that must hold.** Issue 76 requirement 3 requires "a stable
workspace-scoped identity such as `coord-manual-<workspace-group>` so it cannot
collide with issue sessions or with another onboarded product." The workspace
group must therefore be mandatory for manual names. It is available
unconditionally: `workspaceTerminalGroup()` (`src/paths.ts:120`) hashes the
workspace root for every layout. The tmux *namespace* is not a substitute —
`src/paths.ts:139` sets `tmuxNamespace` only when
`basename(dirname(root)) === "workspaces"`, so every flat install has
`tmuxNamespace === null`.

**Concrete failure.** Products A and B are both onboarded flat (the default
`selectWorkspaceLocation` outcome for the first product under a coord root, and
the common single-product case). `coord manual` in A creates session
`coord-manual` with windows `claude`, `codex`, `cursor`, `antigravity` rooted in
A's clones. The owner then runs `coord manual` in B. `ensureSession` finds
`coord-manual` already present and finds windows with those exact agent names
already present and alive, so it creates nothing and respawns nothing: B's
command reports success while every window the owner is handed is running A's
harnesses in A's clones. The owner types B's task into an agent whose cwd is A's
clone. Teardown is the same bug mirrored: `coord detach manual` from B closes
`coord-manual/<agent>` titles and kills session `coord-manual`, destroying A's
live manual session — the exact cross-product kill that the comments on
`ownerTerminalTitlesToClose` (`src/tmux.ts:255-258`) and `detachAllOwnerUiSync`
(`src/detachIssue.ts:171-173`) were written to prevent.

**Smallest correction.** Delete the un-namespaced form. Derive the manual name
from `terminalTitleGroup()` only, and throw when it is null or empty so a manual
session can never be created unscoped. Replace the two "(flat)" test
expectations with an assertion that the un-grouped construction throws.

### 2. A manual session inherits `COORD_ISSUE` from the invoking shell — claude, cursor, antigravity

**Plan claim.** claude `fd94704`, binding decision 5 and the `src/tmux.ts`
bullet: "`ensureSession` sets `COORD_ISSUE` for numeric keys only; the manual
session gets `COORD_MANUAL=1` instead." antigravity `857dde0` item 2 is weaker
still: "creates the session without setting `COORD_ISSUE` **or** sets it only
when an issue number is present." cursor `873c6b4` does not mention the variable
at all. Only codex `7ef62d1` states the requirement correctly: "explicitly
remove a stale `COORD_ISSUE` tmux environment value rather than exposing a fake
issue."

**Rule that must hold.** Issue 76 requirement 4 makes owner chat the only task
source in manual mode, and requirement 6 says automated evidence formats apply
only when an issue action exists. An agent in a manual window must therefore not
be able to resolve a coordinator action. `coord next` resolves its issue from
`--issue` **or `COORD_ISSUE`** (`src/cli.ts:151-153`, `src/cli.ts:428-430`), and
the CLI help advertises that substitution ("COORD_ISSUE and COORD_AGENT may
replace their corresponding owner-control options"). So "not setting" the
variable is not the same as "the variable is absent": a tmux server started by
this invocation inherits the invoking shell's environment, and panes created by
`new-window` inherit the server/session environment.

**Concrete failure.** The owner has been driving issue 76 and their shell still
exports `COORD_ISSUE=76` (or they used `COORD_ISSUE=76 coord run` in that shell
and kept it). No tmux server is running. They run `coord manual`. `new-session`
starts a server that inherits `COORD_ISSUE=76`; `ensureSession` skips its
`set-environment` call because the key is `"manual"`, so nothing overwrites it;
every agent window inherits `COORD_ISSUE=76`. An agent in a manual window, told
by its (newly manual-aware) launcher banner that it may run `coord next`, gets
issue 76's live `action.md` and starts publishing coordinator artifacts to
`issue-76/<agent>` from a session that has no coordinator behind it. Manual mode
has silently re-entered automated mode — the failure requirement 4 exists to
prevent.

**Smallest correction.** For the manual key, actively unset rather than skip:
`tmux set-environment -u COORD_ISSUE -t <session>` before creating any agent
window, and assert in `test/tmux.test.ts` that the recorded argv contains that
`-u COORD_ISSUE` call — not merely that it lacks a `set-environment COORD_ISSUE
<n>` call. antigravity must additionally drop the "or sets it only when an issue
number is present" alternative, which permits the broken branch.

### 3. Mode exclusion has no stated mechanism, and the obvious one is forbidden — cursor

**Plan claim.** cursor `873c6b4`, binding decision 4: "Startup of either mode
fails clearly until the other mode is detached for that workspace," with a
matching test-table row and risk bullet. The plan never says what evidence the
check reads.

**Rule that must hold.** cursor's own decision 3 forbids this path from creating
runtime state, and issue 76 requirement 4 forbids writing `issue-*` runtime
directories or any coordinator file. An exclusion detector must therefore derive
liveness from state that is *already* self-healing — live tmux session names —
because any marker the command writes is both a requirement-4 violation and a
new failure mode.

**Concrete failure.** Decision 3's prohibition is an enumerated list
(`github-issue.json`, `start.json`, `cursors.json`, `journal.jsonl`,
`action.md`, `complete`); a `manual.lock` is not on it. An implementer follows
the plan and writes `<workspaceRoot>/manual.lock` on `coord manual`, removing it
in `coord detach manual`. The owner's laptop sleeps and the tmux server dies, or
they close the Terminal windows by hand instead of running `coord detach manual`
— both ordinary. The lock survives. `coord 76` now fails with "manual mode is
active" forever, and the documented remedy does not work: `coord detach manual`
finds no session, and cursor's own detach description covers only "Terminal
titles, then tmux sessions", so it never removes the lock. The owner is locked
out of automated mode with no documented recovery, and the only fix is deleting
a file the plan never told them about.

**Smallest correction.** State the mechanism in the plan: probe
`tmux has-session` for `coord-manual-<group>` on the automated paths, and for
each `sessionName(n)` over `listIssueNumbersInWorkspace(workspaceRoot)` on the
manual path. Add "writes no lock, marker, or state file" to decision 3 so the
prohibition is a rule rather than a list.

### 4. `coord run` is left outside the exclusion guard — cursor, antigravity

**Plan claim.** cursor `873c6b4` test table: "starting `coord N` while manual UI
is up fails clearly". antigravity `857dde0` item 1: "reject `coord start` /
`coord <issue>` if a manual session is active." Neither names `coord run`.
(codex `7ef62d1` covers it — "before any new or resumed automated issue
startup/attach" — and is not implicated here.)

**Rule that must hold.** The exclusion exists because, in issue 76's words, both
modes "would operate on the same agent clones and could race on the working
trees." The guard must therefore sit on every entry point that drives those
clones, not only on the two that create an issue. `coord run`
(`src/cli.ts:921-929`) is a separate dispatch branch that resolves existing
runtime via `existingContext` and calls `makeRunLoop(paths).run()` directly — it
never passes through the numeric `coord <issue>` branch or the `start` branch.

**Concrete failure.** The owner started issue 76 yesterday and detached; the
runtime under `issue-76/` is intact. Today they run `coord manual` and begin
typing tasks into the agent windows. In a second shell they resume the
coordinator the documented way — `coord run --issue 76 --product .` (the form
the post-install "Next steps" block prints as
`COORD_ISSUE=<issue> coord run --coord-root …`, `src/install.ts:460`). No guard
fires. The run loop nudges each agent, writes `action.md`, and expects
`complete` from harnesses the owner is concurrently driving by hand on scratch
branches. The agents receive interleaved coordinator actions and owner chat, and
the coordinator's file-map and pin checks then run against working trees the
owner has been editing. This is precisely the race the requirement forbids, and
it is reachable without ever typing `coord 76` or `coord start`.

**Smallest correction.** Name a single helper (e.g.
`assertNoManualSession(...)`) and require it on the numeric handler, `start`,
and `run` alike; add the `coord run` case to the mode-conflict test row.

### 5. The uninstall manual-teardown test cannot observe what it claims to test — claude, cursor, antigravity

**Plan claim.** claude `fd94704`, test 30: "`uninstall` with a workspace that has
no `issue-*` directories and an injected session list containing
`coord-manual-<group>` records a 'detach owner UI' change and kills that
session." cursor `873c6b4` test table: "With no `issue-*` dirs, uninstall still
tears down workspace-scoped manual UI." antigravity `857dde0` detach tests:
"`detachAllOwnerUiSync` discovers and tears down `coord-manual[-<group>]`
sessions even when `issues` list is empty."

**Rule that must hold.** A test that passes identically with and without the
code under test is not coverage. For this assertion to have teeth, the test must
be able to make `detachAllOwnerUiSync` see a live manual session.

**Concrete failure.** `detachAllOwnerUiSync` defaults its session list to
`() => []` and its killer to a no-op whenever `process.env.VITEST` is set
(`src/detachIssue.ts:181-183`) — a deliberate guard so fixtures cannot destroy
the operator's real sessions. Overriding it requires passing `listSessions` /
`killSession`, and `uninstall()` constructs its options literal without either
field (`src/install.ts:651-658`), while `UninstallOptions` exposes no hook for
them. So a test driven through `uninstall()` always sees an empty session list:
`killedSessions` is `[]` and `closedTerminalTitles` is `[]` regardless of
whether the manual branch was implemented, mis-scoped, or omitted entirely. The
implementer writes the test, it goes green on the first run, and requirement 5 —
the one case the issue calls out explicitly, "even when there are no `issue-*`
runtime directories" — ships unverified.

**Smallest correction.** Either add the injection to the plan's file map (thread
optional `listSessions` / `killSession` from `UninstallOptions` into the
`detachAllOwnerUiSync` call), or move the behavioural assertion into
`test/detachIssue.test.ts` where `detachAllOwnerUiSync` is called directly with
an injected list, and reduce the install-level test to asserting the exact
options `uninstall` passes down. My own plan's test 30 must be rewritten one of
these two ways.

### 6. The four vendor setup scripts are assigned to install tests that can never execute them — codex, antigravity, cursor; uncovered in claude

**Plan claim.** codex `7ef62d1`, `test/install.test.ts` bullet: "assert generated
install output, launcher text, product protocol, and **all vendor identity
artifacts** describe manual mode and scratch branches." antigravity `857dde0`,
install/onboard tests: "Verify generated template and launcher files contain
manual mode and scratch branch instructions." cursor `873c6b4` test table,
Instructions row: "Generated AGENTS/**setup**/launcher text distinguish
automated vs manual." claude `fd94704` changes all four scripts and lists no
test touching them at all.

**Rule that must hold.** A test file can only assert on artifacts the code under
test actually produces. `scripts/lib/launcher.sh` qualifies — `install()` sources
it to validate launch commands (`src/install.ts:192-199`) and `hookSync.ts:165`
copies it into each clone, so install tests can and should assert its banner.
`scripts/setup_claude.sh`, `setup_codex.sh`, `setup_cursor.sh`, and
`setup_antigravity.sh` do not: no file under `src/` references them, and no test
executes them. They are standalone operator scripts, appearing in the suite only
as fixture path strings (`test/evidence.test.ts:91-94`,
`test/runLoop.test.ts:186`).

**Concrete failure.** The implementer writes the promised install-test assertion
— read the generated Codex identity block from the product fixture and expect
manual-mode wording. No such artifact exists in the fixture, because `install()`
never runs `setup_codex.sh`. The implementer then takes one of two bad exits:
delete the assertion, leaving four changed files with zero automated coverage
while the plan's Tests section claims otherwise; or make the assertion true by
invoking the setup scripts from `install()`, which changes install's behaviour
(writing `~/.codex/AGENTS.md`, `.cursor/rules/`, `AGENT_IDENTITY.md`) well
outside the approved file map and outside anything issue 76 asked for.

**Smallest correction.** Assert on the script *sources*: read
`scripts/setup_*.sh` from `repoRoot()` (the helper `test/onboard.test.ts` and
`test/vendor.test.ts` already import) and check the two-mode wording as a text
fixture, separately from install's generated output. Keep the launcher-banner
assertion where it is — that one is genuinely install-generated. My own plan must
add this text assertion rather than leaving the four scripts uncovered.

## Conclusion

Request changes on all four plans; none is blocked on architecture.

The shared design — a `SessionKey`-parameterised owner-UI lifecycle,
`ensureSession` for idempotency, `coord-manual-<group>` for isolation, hooks and
the state machine untouched, `0.0.12` — is correct and should be kept.

Blocking before implementation:

- **antigravity** must fix finding 1. An un-grouped `coord-manual` session is a
  cross-product data-loss bug in the default flat layout, and its test list
  currently pins the broken behaviour as expected.
- **claude, cursor, antigravity** must fix finding 2. Skipping the
  `set-environment` call is not the same as unsetting the variable, and the gap
  lets a manual session pull a live `action.md`. codex has this right; adopt its
  wording.
- **claude, cursor, antigravity** must fix finding 5, or requirement 5 ships
  behind a permanently green test.
- **codex, antigravity, cursor** must fix finding 6, and **claude** must close
  the same gap from the other side by adding coverage it never proposed.

Non-blocking but should be written into the plan before it is approved:
finding 3 (cursor must name the detection mechanism and forbid marker files
outright) and finding 4 (cursor and antigravity must extend the guard to
`coord run`).

On relative strength: codex `7ef62d1` is the most nearly correct — it is the
only plan that makes the workspace group mandatory, actively clears
`COORD_ISSUE`, and guards resumed automated startup — and it is a sound base to
merge the others' findings into. antigravity `857dde0` carries the one
correctness bug that would cause real damage if shipped as written.

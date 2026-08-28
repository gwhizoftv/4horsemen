# Issue 124 implementation comparison — Claude

Bound implementation pins, all four compared at the exact SHAs below:

- antigravity `ec03d8e6a235294a16ef26cea55ee940d1ee1b73`
- cursor `d89f2d6d61c268714e5a1065098dd235d284cc3e`
- claude `c2784bf31651db084f00eefeb103a4daa373d602`
- codex `fb608c5a8022b2ed7b78def20ad468fc37dd31b1`

All four converged on the same shape: one new source file
(`src/materializedInputs.ts`) and no new test file; `write_git_wrapper` added to
the existing `scripts/lib/launcher.sh` rather than a second template; the two
per-issue roots created in `createIssueRuntime` and granted by the launcher; a
`## Bound input files` section in `src/action.ts`; the startup `git status -sb`
removed. Every one passes its own `pnpm check:fast` — antigravity 523 tests,
cursor 517, claude 527, codex 519, all exit 0.

The findings below are what separates them. Each was produced by running the
bound pin, not by reading it; the commands are given so they can be re-run.

## Comparison

### 1. The block is bypassed by an ordinary global option (antigravity, cursor)

**Where.** antigravity `ec03d8e6a235294a16ef26cea55ee940d1ee1b73`,
`scripts/lib/launcher.sh:103`; cursor `d89f2d6d61c268714e5a1065098dd235d284cc3e`,
`scripts/lib/launcher.sh:37`. Both read:

```bash
-C|--git-dir|--git-dir=*|--work-tree|--work-tree=*|--namespace|--namespace=*)
  exec env COORD_GIT_DELEGATE=1 "$REAL_GIT" "$@" ;;
```

**Rule that must hold.** Part A exists to stop `git status` and `git diff`
against the agent's own clone during an automated issue. A repository selector
that names *this clone* has not changed which repository is being read, so it
cannot be grounds for delegating.

**Concrete failure.** The selector is treated as an automatic bypass, so the
block is one flag wide. I generated all four wrappers against one fixture clone
and ran the same matrix through each (`COORD_ISSUE=42`, cwd inside the clone):

| invocation | want | antigravity | cursor | codex | claude |
| --- | --- | --- | --- | --- | --- |
| `git status` | 2 | 2 | 2 | 2 | 2 |
| `git --no-pager diff` | 2 | 2 | 2 | 2 | 2 |
| `git -C . status` | 2 | **0** | **0** | 2 | 2 |
| `git --git-dir .git diff` | 2 | **0** | **0** | 2 | 2 |
| `git show HEAD` | 2 | 2 | 2 | 2 | 2 |
| `git rev-parse HEAD` | 0 | 0 | 0 | 0 | 0 |
| `git status` in another repo | 0 | 0 | 0 | 0 | 0 |
| `git -C <other> status` | 0 | 0 | 0 | 0 | 0 |

An agent that reaches for `git status`, is refused, and adds `-C .` gets the
full output. The measured token waste the issue is built around returns intact,
while the protocol text tells the agent the read is blocked.

This is my own plan's defect, inherited: the sketch in
`.plans/issue-124/plan.md` at `3ac5aad5d214caea6298696a855d71a1b03d05bb` had
exactly this line, codex's plan review called it out, and antigravity and cursor
implemented the plan as written. Codex and claude resolve the selector to a path
and compare it against the clone instead, which is why they hold at 2 while
still delegating for another repository.

**Smallest correction.** Resolve rather than delegate — keep the option scan,
but treat `-C`, `--git-dir`, `--work-tree`, `GIT_DIR` and `GIT_WORK_TREE` as
*inputs to the target path*, then block only when the target is `COORD_CLONE`.
The last two rows above show that this does not cost the passthrough these two
implementations were protecting: all four still delegate for another repository.

### 2. An unreadable bound blob stops the whole issue (cursor, codex)

**Where.** cursor `d89f2d6d61c268714e5a1065098dd235d284cc3e`,
`src/materializedInputs.ts:118`; codex `fb608c5a8022b2ed7b78def20ad468fc37dd31b1`,
`src/materializedInputs.ts:149`. Both throw when `mirror.readBlob` returns null.

**Rule that must hold.** `run()` has no `try`/`catch` around the tick —
`src/runLoop.ts:2380` in cursor's tree and `:2371` in codex's, unchanged from
the baseline. So anything thrown out of `prepareAction` leaves the process. A
failure whose blast radius is one bound input must not be raised where its blast
radius is every agent on the issue.

**Concrete failure.** I drove a real tick in each tree: an issue at `R3.review`
with two accepted plans and a mirror whose `show` returns exit 1.

```
antigravity  runTick -> COMPLETED (issue continues)
cursor       runTick -> THREW OUT OF THE TICK: Missing mirror blob for plan claude at 1111…
codex        runTick -> THREW OUT OF THE TICK: Bound input 1111…:.plans/issue-1/plan.md is m…
claude       runTick -> COMPLETED (issue continues)
```

For cursor and codex the coordinator terminates. Nobody gets an action, no
journal entry explains it, and the operator sees the run stop. The input that
failed was a convenience copy of a blob whose pin the action still cites and
which the wrapper still permits `git show <sha>:<path>` to reach — so the issue
died over a read no agent actually needed.

The issue text does ask for a loud failure ("Missing mirror blob fails action
prep loudly (same as today)"), and both implementations can fairly point at it.
But "same as today" is the operative half: today a blob that cannot be read
during verification becomes a rejection carrying `outstanding` items, which the
run loop turns into a corrected re-issue. Neither implementation reproduces
that; both convert it into process death.

**Smallest correction.** Either catch at the call site and carry the failure as
an `outstanding` item, or omit the entry and log it. `resolveChangeScope`
(`src/runLoop.ts:615-620`, untouched in all four trees) already documents this
exact rule for the same class of data: "A pin whose diff cannot be read is
omitted rather than fatal: the scope is advisory and must never block action
preparation."

### 3. The same failure on the worktree path (antigravity)

**Where.** antigravity `ec03d8e6a235294a16ef26cea55ee940d1ee1b73`,
`src/materializedInputs.ts:110`, called unguarded from `src/runLoop.ts:881`.

**Rule that must hold.** As in finding 2 — `run()` at `src/runLoop.ts:2371`
does not catch.

**Concrete failure.** antigravity tolerates an unreadable blob
(`src/materializedInputs.ts:70`, `if (content === null) continue;`) but not a
worktree that cannot be created. Probing the module directly with a mirror whose
`materializeWorktree` rejects:

```
antigravity  unreadable blob -> RETURNED entries=0   worktree failure -> THREW: no such commit
cursor       unreadable blob -> THREW                worktree failure -> THREW: no such commit
codex        unreadable blob -> THREW                worktree failure -> THREW: no such commit
claude       unreadable blob -> RETURNED entries=0   worktree failure -> RETURNED worktrees=0
```

So antigravity is safe at `R3.review`, where only documents are bound, and
carries finding 2's failure mode from `R5.compare` onward, where pins are. That
is the worse half of the issue to lose: the comparison and revision steps are
the ones the worktrees exist for.

**Smallest correction.** Treat the two paths alike — whichever rule
antigravity chose for blobs at line 70 should apply at line 110.

### 4. A worktree is reused on an 8-character label without checking what is in it (claude, codex, antigravity)

**Where.** claude `c2784bf31651db084f00eefeb103a4daa373d602`,
`src/materializedInputs.ts:182`; codex `fb608c5a8022b2ed7b78def20ad468fc37dd31b1`,
`src/materializedInputs.ts:181`; antigravity
`ec03d8e6a235294a16ef26cea55ee940d1ee1b73`, `src/materializedInputs.ts:109`. All
three are `if (!existsSync(<path>))` followed by an unconditional reuse of
whatever is already there.

**Rule that must hold.** The directory is named `<agent>-<sha8>`, so the path is
not a unique function of the pin. A cached tree may only be reused once it is
known to hold the commit the action is about to cite.

**Concrete failure.** Two distinct pins for one agent whose SHAs share their
first eight hex characters resolve to one directory. The second action reuses
the first pin's checkout while citing the second pin's SHA, and every agent
comparing or revising reads code that is not the code under review — silently,
because the pin in the action is correct and only the bytes on disk are wrong.
The probability is small; the failure is invisible when it happens, which is
what makes it worth the two lines.

cursor `d89f2d6d61c268714e5a1065098dd235d284cc3e` is the only implementation
that closes this, at `src/materializedInputs.ts:163-176`: it calls
`verifyWorktreeHead` both on reuse and immediately after creation. Codex's own
plan promised exactly this — "a short-SHA collision or mismatched directory
fails loudly rather than being reused" — and the implementation at
`fb608c5a8022b2ed7b78def20ad468fc37dd31b1` does not do it.

**Smallest correction.** Cursor's guard, reused verbatim: resolve `HEAD` in the
existing directory and compare it to the full 40-character pin before reusing.

### 5. Scope, reuse, and coverage

Measured against baseline `5bfc025122672b78a4990a97e7992e8fc53e1871`:

| pin | src | tests | new files |
| --- | --- | --- | --- |
| antigravity `ec03d8e6…` | 315+/13- | 263+/2- | `src/materializedInputs.ts` |
| cursor `d89f2d6d…` | 463+/16- | 131+/3- | `src/materializedInputs.ts` |
| claude `c2784bf3…` | 529+/18- | 473+/1- | `src/materializedInputs.ts` |
| codex `fb608c5a…` | 390+/20- | 199+/8- | `src/materializedInputs.ts` |

- **Every implementation stays inside the issue.** No version bump, no
  unrelated refactor, no dependency, no product `githooks/` policy change, and
  the same 19 paths touched in each. All four correctly reused
  `BareMirror.readBlob` / `materializeWorktree` / `removeWorktree`,
  `deriveBoundInputs`, `containedPath` / `assertNoSymlink`, the existing
  `coord_grant` array, and the existing `encodePath` rendering.
- **Nobody re-reads the mirror on a repeat preparation.** All four short-circuit
  on an existing manifest (antigravity `:51`, cursor `:98`, codex `:132`, claude
  `:139`), which is what keeps the per-read cost the issue is about from being
  moved onto the coordinator once per action.
- **Read-only teardown is handled everywhere.** Cursor locks directories `0o555`
  and unlocks through `removeIssueMaterialization` before wipe
  (`src/wipeIssue.ts:437`); codex keeps directories `0o700` and marks only files
  read-only, with the reasoning in a comment at `src/materializedInputs.ts:69`;
  antigravity and claude never lock directories. I expected this to separate
  them and it does not.
- **Coverage.** cursor adds the fewest test lines (131) for the largest source
  change (463) and is the only implementation whose new guard — the
  `verifyWorktreeHead` in finding 4 — has no test asserting it. claude adds the
  most (473) against the largest source change; a reviewer could fairly call
  that over-weight, though it is the only tree with an end-to-end assertion that
  every path an action lists exists on disk before the action is published.
- **Wipe ordering.** antigravity (`src/wipeIssue.ts:434-435`) and codex
  (`:436-439`) delete the runtime and then run `git worktree prune`, which is
  correct and is two lines. claude unregisters each worktree through the mirror
  first and then prunes (`src/wipeIssue.ts:438-443`) — same outcome, more code
  for it. Cursor routes teardown through `removeIssueMaterialization`, which
  also unlocks. All four end with no dangling registration.

## Verdict

Ranked on what the bound pins actually do:

**codex `fb608c5a8022b2ed7b78def20ad468fc37dd31b1`** and **claude
`c2784bf31651db084f00eefeb103a4daa373d602`** are the only two whose wrapper
cannot be stepped around, which is the half of this issue that either works or
does not (finding 1). Between them, codex carries finding 2 — an unreadable blob
takes the coordinator down — and claude does not; claude carries a larger diff
and more test weight than the work needs. Both carry finding 4.

**antigravity `ec03d8e6a235294a16ef26cea55ee940d1ee1b73`** is the leanest and is
tolerant on the document path, but its wrapper is bypassable (finding 1) and it
still dies on a worktree failure from the comparison step onward (finding 3).

**cursor `d89f2d6d61c268714e5a1065098dd235d284cc3e`** contributes the one guard
nobody else has (finding 4) and the most careful teardown, but it is bypassable
(finding 1) and dies on an unreadable blob (finding 2), and its new guard is
untested.

No pin is complete as it stands. The union is small and specific: take codex or
claude's target-resolving wrapper for finding 1, claude's or antigravity's
tolerant handling — extended to both the blob and the worktree path — for
findings 2 and 3, and cursor's `verifyWorktreeHead` for finding 4.

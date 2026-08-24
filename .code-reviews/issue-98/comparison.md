# Issue 98 — implementation comparison

Bound implementation pins:

- cursor `6b2ede95cd915d1e3f7a4a4ca0b8d078df234c5c`
- claude `9794eafd52a3e5a9f768c4bfe7aed0d46d1e84fc`
- codex `5055366c3484916b92b4a688d6707bc282c56c96`

All three move the completion receipt out of the coord root and into a sibling
mailbox, persist `completesRoot` in `start.json`, and extend `wipeIssue` to drop
the issue's mailbox. They differ on the thing the issue is actually about:
whether a harness ends up able to write its receipt, and whether the grant it
receives is narrow.

Each finding below was checked by building the pin and running it, not by
reading alone. Method: `git worktree` at each pin, `pnpm install --offline`,
`pnpm build`, then (a) `pnpm vitest run` for the suite, (b) rendering
`start-<agent>.sh` through each pin's own `write_launcher` and executing it
against a stub `claude` that prints its argv, under `/bin/bash` (macOS 3.2) with
and without `COORD_ISSUE`, and (c) a script calling each pin's built
`issueRuntimePaths`/`agentRuntimePaths`.

Suite results at the pins: cursor 448 passed, codex 450 passed, claude 456
passed. All three suites are green, which is why the findings below matter — the
most serious one is invisible to its own suite.

## Comparison

### Grant delivered to a harness, measured

Rendering each pin's launcher and executing it with `COORD_ISSUE=17`, a mailbox
at `<mb>`, and a stub harness that records its argv:

| pin | automated argv | manual mode (`/bin/bash` 3.2) |
| --- | --- | --- |
| cursor `6b2ede95` | `--permission-mode auto` — **no grant** | starts |
| claude `9794eaf` | `--permission-mode auto --add-dir <mb>/issue-17/claude` | starts |
| codex `5055366c` | `--permission-mode auto --add-dir <mb>/issue-17/claude` | **aborts, harness never starts** |

### 1. cursor — no launcher ever receives a mailbox directory, so no harness is granted one

`src/install.ts:361` (the `writeAgentLauncher({...})` call) and
`src/setupWorkspace.ts:463` (`const completesDir = input.completesDir ?? ""`).

**Rule.** The deliverable of issue 98 is that a sandboxed harness can write its
completion SHA. Moving the file is only half of that; the harness must be
granted the new location, or the write is refused exactly as before.

**Failure.** `writeAgentLauncher` accepts an optional `completesDir` and passes
it to `write_launcher` as `$6`, but no caller supplies it —
`grep -n completesDir` over `src/install.ts` and `src/cli.ts` at this pin returns
nothing. It therefore defaults to `""`, `grant_block` in
`scripts/lib/launcher.sh:24-36` stays empty, and every generated launcher is
byte-identical to the pre-change one. Executed with `COORD_ISSUE=17` and a real
mailbox present, the stub harness recorded `--permission-mode auto` and nothing
else. Codex still launches `--sandbox danger-full-access` (finding 3), so on this
build Codex is the only agent that can write a receipt, and only because it has
blanket filesystem access. Claude, Cursor and Antigravity are refused — the
issue's symptom, unchanged, with the receipt now in a second place nobody is
allowed to write.

**Test.** `test/install.test.ts` is not in this pin's changed paths, and nothing
in the suite executes a generated launcher, which is why 448 tests pass over a
feature that does not work. The smallest test that would have caught it:

```ts
const launcher = readFileSync(join(clone, "start-claude.sh"), "utf8");
expect(launcher).toContain("--add-dir");
```

Codex's `test/install.test.ts:596` is the stronger form of this and is the right
model: it runs each real launcher against a stub binary and asserts exact argv.

### 2. cursor — the grant it would deliver is the whole issue directory, including peers' receipts

`scripts/lib/launcher.sh:29-36`:
`COORD_COMPLETES_DROP="${completes_dir}/issue-${COORD_ISSUE}"`.

**Rule.** From the issue: "A single `completes/complete` or
`completes/cursor-complete` lets peers overwrite each other." A grant must reach
one agent's drop and no other's.

**Failure.** The layout this pin creates is `completesRoot/issue-N/<agent>`
(`src/paths.ts` `agentRuntimePaths`, via `issueCompletesDir`), so appending only
`issue-N` to any mailbox root yields the directory holding *every* agent's drop.
Rendering this pin's launcher with the mailbox root supplied — the only value
that makes the derived path exist — and executing it produced
`--add-dir <mb>/issue-17`. Every agent could then replace any peer's `complete`,
and the coordinator would accept a forged SHA as that peer's intent. The
function comment says the argument is `completesRoot/<agent>`, but with that
value the derived path is `completesRoot/<agent>/issue-N`, which this pin never
creates — so the two readings fail in opposite directions and neither works.

**Test.** Assert the negative, not just the positive:

```ts
expect(argv).not.toContain(join(completesRoot, `issue-${issue}`));
expect(argv).toContain(join(completesRoot, `issue-${issue}`, agent));
```

### 3. cursor — Codex keeps blanket filesystem access, on a factually wrong premise

`scripts/lib/launcher.sh:47-49`: "danger-full-access remains because
workspace-write does not support additional writable roots in current CLI;
remove when codex gains that flag."

**Rule.** The stated integrity goal is that agents lose reach into
`coord-runtime`. Leaving one agent with full filesystem access leaves
`cursors.json`, `journal.jsonl`, and every peer's `action.md` writable by it.

**Failure.** The premise is false in this environment. `codex --help` documents
`--add-dir <DIR>` — "Additional directories that should be writable alongside the
primary workspace" — and both other pins use it with `--sandbox workspace-write`.
So the one harness with the broadest access keeps it for a reason that does not
hold, and the removal condition written into the comment has already been met.

**Test.** `expect(launcher).not.toContain("danger-full-access")`.

### 4. cursor — Antigravity and Cursor exec without the grant they just computed

`scripts/lib/launcher.sh:60-72`: both branches `printf '%s' "$grant_block"` and
then `exec agy ...` / `exec agent` with no `--add-dir`.

**Rule.** Emitted setup that no later line consumes is not a grant.

**Failure.** Even if finding 1 were fixed, these two harnesses would compute
`COORD_COMPLETES_DROP` and discard it, so they would still be refused at
completion time. `agy --add-dir` and `agent --add-dir` both exist
(verified via `--help`), so nothing prevents wiring them.

### 5. codex — the generated launcher aborts under macOS `/bin/bash`, and its own test cannot see it

`scripts/lib/launcher.sh:24` (and 29):
`exec claude --permission-mode auto "${completion_args[@]}"`.

**Rule.** The generated launcher runs `#!/usr/bin/env bash` with
`set -euo pipefail`. On macOS the default `bash` is 3.2, where expanding an
empty array as `"${arr[@]}"` under `set -u` is an unbound-variable error.

**Failure.** Verified directly. With `COORD_ISSUE` unset — owner-driven manual
mode, which this pin deliberately grants nothing — the rendered launcher exits 1
with `start-claude.sh: line 68: completion_args[@]: unbound variable` and the
harness never starts. Manual mode is a documented mode of the same file
("Owner-driven manual mode: wait for the owner's chat task"), so on a stock macOS
without a newer bash on `PATH` this build cannot start an agent at all outside an
automated issue. The same expansion is on the automated path; it is safe there
only because the array is non-empty.

`test/install.test.ts:596` executes the launchers via
`execFileSync("bash", [...])`, which resolves `bash` from `PATH` — Homebrew's 5.x
in a developer environment — so the test asserts the manual path yields
`["--ask-for-approval","never","--sandbox","workspace-write"]` and passes while
the same script fails under `/bin/bash`.

**Fix.** Use the guarded expansion everywhere the array may be empty:

```sh
exec claude --permission-mode auto ${completion_args[@]+"${completion_args[@]}"}
```

A test cannot express this portably unless it pins the interpreter, so the fix
sketch stands in for one; if a test is wanted, invoke `/bin/bash` explicitly
rather than `bash`.

### 6. codex and cursor — two workspaces under one parent resolve to the same receipt file

cursor `src/paths.ts:138` and `src/install.ts:262`; codex `src/paths.ts:138-139`
and `src/install.ts:291-294`. Both derive `dirname(coordRoot)/completes`.

**Rule.** A receipt path must identify one workspace, one issue, and one agent.
`dirname(coordRoot)` is shared by every runtime under a common parent — which is
the normal layout for two products, and exactly what
`test/onboard.test.ts` sets up ("two products sharing an outer runtime").

**Failure.** Calling each pin's built `issueRuntimePaths` for two coord roots
under one parent, same issue, same agent:

```
cursor  A: /tmp/shared/completes/issue-42/claude/complete
        B: /tmp/shared/completes/issue-42/claude/complete   -> identical
codex   A: /tmp/shared/completes/issue-42/claude/complete
        B: /tmp/shared/completes/issue-42/claude/complete   -> identical
claude  A: /tmp/shared/completes/coord-runtime-alpha/issue-42/claude/complete
        B: /tmp/shared/completes/coord-runtime-beta/issue-42/claude/complete
```

Product A's `claude` and product B's `claude` write one file. Whichever runs
second overwrites the first, and each coordinator reads the other's SHA as its
own agent's intent — then rejects it as a commit that is not on the expected
branch, with no diagnostic naming the real cause. Codex narrows this by
appending the project for *nested* workspaces only (`src/install.ts:293`), which
still collides for two flat workspaces under one parent, and for the same project
name under two different outer roots. This is the failure that fired during
implementation of the third pin as a live cross-test collision, so it is not
theoretical.

**Test.**

```ts
expect(defaultCompletesRoot("/p/rt-a")).not.toBe(defaultCompletesRoot("/p/rt-b"));
```

### 7. codex — the harness resolves the mailbox from config while the coordinator resolves it from start.json

`scripts/lib/launcher.sh:108-121` reads `coord.workspaceConfig` and parses
`completesRoot` out of it at launch; `src/cli.ts:172` rebuilds the coordinator's
paths from `start.completesRoot`.

**Rule.** For the duration of an issue, the directory the harness writes and the
directory the coordinator polls must be the same one. `start.json` is immutable
for the issue session; the workspace config is not — `coord install` rewrites it.

**Failure.** An owner who reinstalls mid-issue with a different `completesRoot`
(or edits the config) leaves the coordinator polling the old mailbox from
`start.json` while any harness relaunched afterwards — `ensureSession` respawns a
dead pane — is granted and writes the new one. The agent reports done, the file
exists, and the action never completes. Reading the same field from
`start.json` in the launcher, or refusing to start when the two disagree, closes
it.

### 8. claude — gaps in this agent's own implementation

Recorded so the same standard applies to all three pins.

- `src/action.ts` was not in this pin's approved paths, so `readCompletion` and
  `clearCompletion` remain plain `existsSync` + `readFileSync`/`unlinkSync` with
  no containment or no-follow open. The receipt now sits in a directory the agent
  is granted, so an agent that replaces `complete` with a symlink between poll
  ticks has the coordinator read foreign content as its SHA. Codex hardened this
  (`resolveSafeCompletesRoot` plus a symlink check on the drop at
  `scripts/lib/launcher.sh:123`), and cursor did not either. Codex's handling is
  the one to carry forward.
- No `--completes-root` CLI option: `InstallOptions.completesRoot` exists but
  nothing parses a flag, so an owner whose layout needs an explicit root must
  hand-edit the generated config. Codex wired the flag through onboard and
  install (`src/cli.ts:861`, `:899`) and is better here.
- No `coord doctor` check for a missing or drifted mailbox; the launcher only
  warns on stdout.

### 9. What each pin does best

- **codex `5055366c`** — the only pin with an end-to-end launcher test that runs
  the real generated scripts against stub binaries and asserts exact argv, both
  positively and negatively (`test/install.test.ts:596-660`); the only one that
  validates `COORD_ISSUE`, rejects a symlinked drop, and fails closed with a
  named error; the only one with an owner-facing `--completes-root`. Its two
  defects (findings 5 and 6) are small, local edits.
- **claude `9794eaf`** — the only pin whose mailbox root cannot collide across
  workspaces (finding 6) and the only one whose launcher works in both modes on
  `/bin/bash` 3.2; weakest on receipt-read hardening and owner input (finding 8).
- **cursor `6b2ede95`** — matches the issue's sketched directory layout most
  literally and has the cleanest `wipeIssue` scoping, but findings 1-4 mean the
  feature is not delivered: no harness is granted anything, and Codex keeps the
  blanket access the issue exists to remove.

### Recommendation

Take **codex `5055366c3484916b92b4a688d6707bc282c56c96`** as the implementation.
Two changes before it ships, both mechanical:

1. Guard every array expansion as `${completion_args[@]+"${completion_args[@]}"}`
   (finding 5), and pin `/bin/bash` in the launcher test so the guard is covered.
2. Namespace the derived mailbox by the coord root's own directory name for flat
   workspaces as well as nested ones (finding 6).

Finding 7 should be fixed in the same pass if the launcher is being touched
anyway. Do not carry cursor `6b2ede95` forward as the base: findings 1 and 2 are
not adjustments to a working mechanism, they are the mechanism.

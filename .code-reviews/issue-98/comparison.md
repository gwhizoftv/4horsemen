# Issue 98 — implementation comparison

Bound implementation pins:

- cursor `6b2ede95cd915d1e3f7a4a4ca0b8d078df234c5c`
- claude `9794eafd52a3e5a9f768c4bfe7aed0d46d1e84fc`
- codex `5055366c3484916b92b4a688d6707bc282c56c96`

All three relocate `complete` to `completesRoot/issue-N/<agent>/complete`, persist
`completesRoot` into workspace config and `start.json`, and wipe the issue's
mailbox with the runtime. They diverge on whether a harness is actually granted
that drop, whether the grant is narrow, and whether two workspaces under one
parent share one receipt file.

## Comparison

### 1. cursor `6b2ede95` — install never supplies the mailbox to the launcher, so no harness is granted one

`src/install.ts:361` (`writeAgentLauncher({...})` with no `completesDir`) and
`src/setupWorkspace.ts:463` (`const completesDir = input.completesDir ?? ""`).

**Rule.** Moving the receipt is not enough: the sandboxed harness must be granted
the new drop, or completion writes fail exactly as before under coord-runtime.

**Failure.** `writeAgentLauncher` accepts optional `completesDir` and forwards it
as `write_launcher`'s fifth argument, but `coord install` never passes it. The
argument defaults to `""`, `scripts/lib/launcher.sh` leaves `grant_block` empty,
and generated launchers stay byte-identical to the pre-change ones for Claude
(no `--add-dir`), Cursor (`exec agent`), and Antigravity (no mailbox flag).
Codex still runs `--sandbox danger-full-access`, so only Codex can write a
receipt — and only by retaining blanket filesystem access. The issue's symptom
is unchanged for the other three harnesses.

**Test.**

```ts
expect(readFileSync(join(clone, "start-claude.sh"), "utf8")).toContain("--add-dir");
```

### 2. cursor `6b2ede95` — even the unused grant path is the whole issue tree, not one agent drop

`scripts/lib/launcher.sh:33`:
`COORD_COMPLETES_DROP="${completes_dir}/issue-${COORD_ISSUE}"`.

**Rule.** A grant must reach exactly one agent's drop
(`completesRoot/issue-N/<agent>`). Granting the issue directory lets peers
overwrite each other.

**Failure.** `agentRuntimePaths` at this pin builds
`completesRoot/issue-N/<agent>/complete`. Appending only `issue-N` to a mailbox
root yields the directory that holds every agent's drop. If a caller ever passed
`completesRoot`, every harness would get `--add-dir …/issue-N` and could forge a
peer's SHA. The function comment claims the argument is `completesRoot/<agent>`,
but then the derived path is `…/<agent>/issue-N`, which this pin never creates —
so both readings fail.

**Test.**

```ts
expect(argv).toContain(join(completesRoot, `issue-${issue}`, agent));
expect(argv).not.toContain(join(completesRoot, `issue-${issue}`)); // as sole grant
```

### 3. cursor `6b2ede95` — Cursor and Antigravity compute a drop variable and never pass it

`scripts/lib/launcher.sh:64` and `:71`: `printf '%s' "$grant_block"` then
`exec agy …` / `exec agent` with no `--add-dir`.

**Rule.** A computed path that is never passed to the vendor CLI is not a grant.

**Failure.** Even if findings 1–2 were fixed, Cursor and Antigravity would still
discard `COORD_COMPLETES_DROP` and be refused when writing `complete`.

**Test.** `expect(launcher).toMatch(/exec agent .*--add-dir/)` (and the same for
`agy`).

### 4. cursor `6b2ede95` — resume ignores `start.completesRoot`

`src/cli.ts:167-173` (`context` returns `issueRuntimePaths(coordRoot, issue)`
with no third argument) versus `initializeOperationalState` which does persist
`completesRoot` into `start.json`.

**Rule.** For the life of an issue, the coordinator must poll the mailbox frozen
in `start.json`, not re-derive the default from the current config.

**Failure.** After `coord install` rewrites `completesRoot` (or an operator moves
the mailbox), resume/`coord run` rebuilds paths with `defaultCompletesRoot` while
agents that were started against the original tree keep writing there. The
coordinator never sees the SHA; the action hangs as incomplete.

**Test.** Seed `start.json` with a non-default `completesRoot`, call `context`,
assert `paths.completesRoot` equals the stored value.

### 5. cursor `6b2ede95` and codex `5055366c` — flat workspaces under one parent share one receipt file

cursor `src/paths.ts:129` (`dirname(coordRoot)/completes`); codex
`src/paths.ts:138-139` and `src/install.ts:291-294` (same default; nested only
appends `project`).

**Rule.** A receipt path must identify one workspace, one issue, and one agent.
`dirname(coordRoot)` is shared by every flat runtime under a common parent — the
layout `test/onboard.test.ts` already exercises for two products.

**Failure.** Two flat coord roots `/p/rt-a` and `/p/rt-b` both resolve to
`/p/completes/issue-42/claude/complete`. Whichever agent writes last wins; each
coordinator treats the peer product's SHA as its own agent's intent. Codex's
nested `join(defaultMailbox, project)` does not cover two flat workspaces.
Claude's `defaultCompletesRoot` namespaces by the coord root's basename (and
project when nested), so the same call yields distinct trees.

**Test.**

```ts
expect(defaultCompletesRoot("/p/rt-a")).not.toBe(defaultCompletesRoot("/p/rt-b"));
```

### 6. codex `5055366c` — empty `completion_args[@]` under macOS `/bin/bash` 3.2 aborts manual mode

`scripts/lib/launcher.sh:24` (also `:29`):
`exec claude … "${completion_args[@]}"` after `completion_args=()`.

**Rule.** Generated launchers run `#!/usr/bin/env bash` with `set -u`. On macOS
stock bash 3.2, expanding an empty `"${arr[@]}"` is an unbound-variable error.

**Failure.** With `COORD_ISSUE` unset (owner-driven manual mode, which this pin
intentionally grants nothing), the launcher exits before `exec` and the harness
never starts. Claude's pin uses the guarded form
`${coord_grant[@]+"${coord_grant[@]}"}` and starts in both modes.

**Fix.** `${completion_args[@]+"${completion_args[@]}"}` on every expansion; pin
`/bin/bash` in the launcher test so PATH's bash 5.x cannot hide the bug.

### 7. codex `5055366c` — launcher reads `completesRoot` from mutable config; coordinator reads `start.json`

`scripts/lib/launcher.sh:108-124` parses `config.completesRoot` from
`coord.workspaceConfig`; `src/cli.ts:169-172` rebuilds coordinator paths from
`start.completesRoot`.

**Rule.** The directory the harness writes and the directory the coordinator
polls must stay the same for the issue session. `start.json` is immutable for
that session; workspace config is rewritten by `coord install`.

**Failure.** A mid-issue reinstall (or config edit) that changes `completesRoot`
leaves the coordinator polling the old tree while a respawned pane is granted
the new one. The agent writes `complete`, the coordinator never observes it.

**Fix.** Resolve the drop from `start.json` (or refuse to launch when config and
start disagree).

### 8. codex `5055366c` — unverified Cursor/Antigravity sandbox flags on the automated path

`scripts/lib/launcher.sh:41` (`agy … --sandbox "${completion_args[@]}"`) and
`:47` (`agent --sandbox enabled "${completion_args[@]}"`).

**Rule.** Vendor flags that are not accepted by the installed CLI must not be on
the automated `exec` line; a rejected flag aborts the harness before any work.

**Failure.** If the installed `agent`/`agy` rejects `--sandbox` /
`--sandbox enabled`, every automated pane fails at launch. Claude's pin passes
only `--add-dir` (plus existing unattended flags) and avoids inventing sandbox
switches.

**Test.** Run the generated launcher against stub binaries that reject unknown
flags; assert exit 0 and argv contain `--add-dir` only as the extra root.

### 9. claude `9794eaf` — gaps relative to the stronger peers

- No owner `--completes-root` flag (Codex wires it through install/onboard).
  `InstallOptions.completesRoot` exists but nothing parses a CLI flag.
- `src/action.ts` is unchanged in all three pins (not on the approved map for
  this action's product commits): `readCompletion`/`clearCompletion` still
  follow a symlinked `complete`. Codex at least refuses a symlinked drop at
  launcher time (`scripts/lib/launcher.sh:125-128`); carry that forward and
  harden coordinator I/O in a follow-up that can touch `src/action.ts`.
- Codex still launches with `--dangerously-skip-permissions` for Antigravity on
  this pin as well; the `--add-dir` is additive, not a replacement for that
  broad grant.

### What each pin does best

| Concern | Best pin |
| --- | --- |
| End-to-end launcher argv test | codex `5055366c` |
| bash 3.2–safe empty grant + path-independent launch | claude `9794eaf` |
| Workspace-unique default mailbox | claude `9794eaf` |
| Owner `--completes-root` + absolute schema | codex `5055366c` |
| Layout sketch fidelity (`completes/issue-N/<agent>`) | all three (same order) |
| Actual grant delivered | claude / codex (cursor delivers none) |

### Recommendation

Prefer **claude `9794eafd52a3e5a9f768c4bfe7aed0d46d1e84fc`** as the merge base: it
is the only pin whose default mailbox cannot collide across flat workspaces
(finding 5), whose launcher starts under macOS `/bin/bash` 3.2 in both modes
(finding 6), and that actually grants `--add-dir …/issue-N/<agent>` without
leaving install-time wiring unfinished (findings 1–3).

Before shipping, fold in from codex `5055366c`:

1. The end-to-end launcher argv test (`test/install.test.ts` launcher suite).
2. Owner `--completes-root` and absolute `completesRoot` validation.
3. Symlink rejection on the drop directory at launch.

Do not take cursor `6b2ede95` as the base: findings 1–4 mean the mailbox move is
not wired through to harnesses or resume.

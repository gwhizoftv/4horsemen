# coord — owner operations

The coordinator gives each agent one concrete action, accepts an exact pushed
commit SHA as that agent's completion intent, verifies the required artifact in
that commit, and advances only after the corresponding mechanical predicate
passes.

**The coordinator can never merge.** It has no merge command and no merge code
path. When owner policy allows it, the most it can do is open an *unmerged*
pull request.

## Directory topology

Runtime state lives in an owner-controlled tree **outside every agent clone**.
`--coord-root` is required on `coord start` and is proven to be outside each
configured clone — in both directions — before anything is written.

```
<coord-root>/                     e.g. /Volumes/4TB-SOURCE/REPOS/coord/coord-runtime
  mirror.git/                     bare mirror; the only place origin bytes enter
  issue-<n>/
    start.json                    written once; never mutated
    cursors.json                  everything that changes during a run
    journal.jsonl                 append-only event log
    worktrees/                    throwaway verification worktrees (R7)
    agents/<agent>/
      action.md                   the order for this agent
      complete                    the agent writes one commit SHA here
```

`start` refuses a control root that is inside a configured clone (it would dirty
an agent worktree) and one that contains a configured clone (coordinator writes
could reach it). Symbolic links *below* the root are refused; the root itself is
resolved through `realpath` first, which is what defeats a root aliased into a
clone.

## Commands

```sh
coord start <issue> --profile <solo|reviewed|consensus> --config <path> --coord-root <external-path>
coord run            --coord-root <path> --issue <n>
coord next           --coord-root <path> --issue <n> --agent <agent>
coord answer         --coord-root <path> --issue <n> --message <text>
coord drop <agent>   --coord-root <path> --issue <n>
coord pause          --coord-root <path> --issue <n>
coord resume         --coord-root <path> --issue <n>
coord restart-action --coord-root <path> --issue <n> --agent <agent>
coord abandon        --coord-root <path> --issue <n>
```

Exit codes: `0` success, `1` failure, `2` usage, `3` state missing or invalid,
`4` refused by policy (for example, a control root inside a clone, or dropping
the last active agent).

`start` records the baseline, the original roster, the branch template, the
automation digest, the PR policy, and the revision limit, creates the mirror,
and launches an attachable tmux session with one window per agent. `run` is the
long-lived owner control-plane process.

## Profiles

| Profile | Implementers | Gates |
| --- | --- | --- |
| `solo` | the single agent | join, plans, implementation, finalized |
| `reviewed` | one designated agent | all seven |
| `consensus` | every active agent | all seven |

`maxRevisionRounds` is **3**. After three unsuccessful revision rounds the
driver requires owner action; it never enters round 4.

## The completion protocol

An action names exactly one required path and the absolute path of the
completion file. The agent publishes its artifact, pushes, and writes the commit
SHA that contains it as the sole contents of `complete`:

```sh
echo <40-hex-sha> > /path/from/action.md/complete
```

A `commit <sha>` prefix is accepted. Anything else — an empty file, prose, JSON,
an abbreviated or uppercase SHA, more than one line — is not intent and never
advances work. Branch-tip movement is liveness information only; **pushing alone
does not complete an action**.

Verification refreshes origin refs, proves the SHA is reachable from that
agent's own issue branch, and reads blobs at that exact commit. A later commit
that deletes the artifact does not invalidate an already-submitted commit, and a
real commit on a peer's branch is not a valid submission.

`action.md` deliberately carries no `stepId`, `gateId`, phase, evidence-predicate
id, denominator, or peer status. `coord next` prints only the calling agent's
action, or `none yet`.

## Waiting is indefinite

Attempt counts are diagnostic. No number of failed submissions ever drops an
agent, advances a gate, or terminates the run. Failing evidence clears the
completion file and reissues the same action with concrete `outstanding[]`
detail; the driver keeps waiting until valid evidence arrives or the owner
intervenes.

A mirror fetch failure is classified as transient. It preserves the submitted
`complete` file, emits no missing-artifact verdict, and retries. An origin
outage can never be mistaken for absent work.

A provider 529 inside an agent harness is not mechanically visible to the
coordinator. The action stays outstanding; attach to the pane, `pause`, or
`drop`.

## Dropping an agent

```sh
coord drop antigravity --coord-root /…/coord-runtime --issue 1
```

This is the owner's complete authorization to continue without that agent. It is
one local atomic change: journal the command, add the agent to the persisted
dropped set, ignore and clear any pending completion from it, and rederive the
unresolved and future actions from the remaining agents. There is no proposal,
approval, signature, roster epoch, or branch artifact.

Peers receive **no drop announcement**. An affected action is simply reissued
with inputs that omit the dropped agent — "read plans from commits B, C, and D".
The dropped agent's published work becomes ineligible as an input to every
unresolved and future gate, even if it published usable work first. Gates it
already completed and immutable pins are not recomputed. A later stale
`complete` from it is ignored.

When one active agent remains, subsequent work uses the solo checks. The CLI
refuses to drop the last active agent, because a zero-agent workflow cannot
continue. Starting with one agent, and continuing with one after drops, are both
supported.

## Pause, resume, restart, abandon

`coord pause` journals a durable pause and lets the coordinator process exit
without deleting actions, cursors, mirror state, or tmux sessions. `coord resume`
followed by `coord run` reconstructs state and continues.

`coord restart-action --agent X` clears only X's current action state so the next
tick mints it again. `coord abandon` marks the run; runtime state and tmux
sessions are left in place.

## Recovery

Restart reconstructs from `start.json`, `cursors.json`, the journal, and origin.
An action is treated as outstanding only when the bytes on disk still match the
order re-derived from current state, which makes delivery idempotent: restarting
mid-flight does not double-deliver. A pending submission is re-verified before
anything advances.

A runtime format version in `start.json` makes an incompatible future change fail
closed rather than guess how to resume.

## tmux

Agents run in an attachable session named `consensus-<issue>`, one window per
agent, launched through each clone's own `start-<agent>.sh`. A missing or
non-executable launcher is a named startup failure — never a fallback to a bare
shell, because a pane without its harness looks alive while doing nothing.

Completion is detected by polling files at a bounded interval. `tmux wait-for`
is never used: its `-S` toggles when no waiter is present, which can wedge the
next wait forever.

Automatic nudging is enabled for Claude Code only, and only when the owner also
enables it in configuration. Codex, Cursor, and Antigravity are pull-only until a
harness-specific idle fixture proves mid-turn insertion safe; the owner can
always type a nudge by hand. Text is delivered with `load-buffer` /
`paste-buffer`, never `send-keys`.

```sh
tmux attach -t consensus-1
```

## Finalization (R7)

1. Cleanup-only verification: the transition from the consensus-approved commit
   to the final commit may contain **deletions of this issue's coordination
   files and nothing else**. Additions, modifications, renames, copies,
   cross-issue cleanup, and any product change fail.
2. A throwaway worktree is materialized at the exact final commit under the
   control root.
3. The configured checks run there as explicit argument vectors. Placeholder
   expansion rewrites one argv element and never invokes a shell.
4. Results are journaled.

A failed verifier or a failed check **blocks PR creation**. With
`"prPolicy": "coord-open-unmerged"` the coordinator may then open an unmerged
PR. Merging remains the owner's, through the normal review process.

## Configuration

See `config.example.json`. There is deliberately no `defaultCoordRoot`:
`--coord-root` must be named explicitly every time.

```jsonc
{
  "project": "coordination",
  "agents": [
    { "id": "claude", "root": "../coordination-claude", "harness": "claude", "nudge": true },
    { "id": "codex",  "root": "../coordination-codex",  "harness": "codex",  "nudge": false }
  ],
  "branch": "issue-{issue}/{agent}",
  "baseBranch": "main",
  "maxRevisionRounds": 3,
  "prPolicy": "owner-only",
  "finalChecks": [
    { "argv": ["pnpm", "install", "--frozen-lockfile"] },
    { "argv": ["pnpm", "check"] }
  ]
}
```

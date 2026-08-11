# coord — Owner-Side Workflow Driver

The `coord` executable is the owner's control plane for multi-agent coordination.
It orders agent work, accepts submission commit SHAs as completion intent, verifies
required artifacts at those exact commits, and advances workflow gates.

## Directory topology

```
coord/                        # External runtime root (--coord-root)
  mirror.git/                 # Bare mirror of origin
  issue-<n>/
    start.json                # Immutable session configuration
    cursors.json              # Current workflow state
    journal.jsonl             # Append-only event log
    agents/<agent>/
      action.md              # Current action for the agent
      complete               # Agent writes submission SHA here
```

The runtime root must be OUTSIDE all configured agent clones. The coordinator
refuses to start if `--coord-root` resolves inside any agent root.

## Commands

| Command | Who | Purpose |
| --- | --- | --- |
| `coord start <issue> --profile <p> --config <path> --coord-root <path>` | Owner | Initialize session |
| `coord run --coord-root <path> --issue <n>` | Owner | Start polling loop |
| `coord next --coord-root <path> --issue <n> --agent <name>` | Agent | Read current action |
| `coord drop <agent> --coord-root <path> --issue <n>` | Owner | Remove agent from roster |
| `coord pause --coord-root <path> --issue <n>` | Owner | Durable pause |
| `coord resume --coord-root <path> --issue <n>` | Owner | Resume after pause |
| `coord restart-action --coord-root <path> --issue <n> --agent <name>` | Owner | Reissue action |
| `coord abandon --coord-root <path> --issue <n>` | Owner | Abandon issue |

## Profiles

- **solo**: Single agent, solo checks only.
- **reviewed**: One designated implementer, simplified review.
- **consensus**: All active agents, full ballot/review/revision cycle.

## Agent interaction

Agents are pull-only by default. They read their action via `coord next` or by
reading the `action.md` file directly. To signal completion, they write their
submission commit SHA to the `complete` file (path given in `action.md`).

The coordinator never writes to agent clones.

## Drop semantics

`coord drop <agent>` is the owner's complete authorization to continue without
that agent. It removes them from the active roster immediately. Future actions
will not cite dropped agents as inputs. Stale completions from dropped agents
are ignored.

The coordinator refuses to drop the final active agent.

## Recovery

The coordinator can be stopped and restarted. `coord run` reconstructs state
from `start.json`, `cursors.json`, the journal, and existing `action.md` /
`complete` files. Pending submission SHAs are re-verified on restart.

## Revision limit

`maxRevisionRounds` (default 3) caps revision cycles. After 3 failed rounds,
the driver notifies the owner and waits for intervention — it never enters
round 4 automatically.

## Finalization

When consensus is reached, the coordinator verifies the final commit contains
only cleanup deletions of coordination files. It may open an unmerged PR when
`prPolicy` is `coord-open-unmerged`. The coordinator never merges.

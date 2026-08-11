# Coord driver operator guide

## Authority and safety model

`coord` is an owner-local control-plane process. Owner commands take effect
directly and are journaled; there are no signed drop/override artifacts. The
driver may open a draft, unmerged PR only when configured with
`coord-open-unmerged`. It has no merge command or merge effect.

The coordinator never writes agent clones. Agents publish work to their own
`issue-<n>/<agent>` origin branches. The coordinator fetches those branches
into an owner-side bare mirror and evaluates blobs at the exact submission SHA.

## Runtime topology

`--coord-root` must resolve outside every configured clone. Existing symlinks
within derived runtime paths are rejected.

```text
<coord-root>/
  mirror.git/
  issue-<n>/
    start.json       immutable session/config baseline
    cursors.json     current internal cursor and dropped roster
    journal.jsonl    append-only owner/effect audit
    agents/<agent>/
      action.md      restricted public order
      complete       exact pushed SHA supplied by the agent
      render.log     optional human log
```

`action.md` exposes only an opaque action UUID, the caller identity, required
path, concrete task, exact bound input commits, and absolute completion path.
Internal step/gate/evidence identifiers remain in `cursors.json`.

## Configuration

Start from `config.example.json`:

- `origin`: canonical Git origin used by the bare mirror
- `agents[]`: stable id, clone root, executable launcher, delivery policy, and
  optional foreground harness process
- `branch`: must contain `{issue}` and `{agent}`
- `maxRevisionRounds`: fixed at 3 or less; no round 4 is possible
- `prPolicy`: `owner-only` or `coord-open-unmerged`
- `checks[]`: explicit argv arrays executed in a clean worktree at the final
  pin; no shell is invoked
- `pollIntervalMs`: bounded completion-file polling interval

Any `{worktree}` token in one check argument is replaced with the verification
worktree path. Expansion never creates shell text.

## Starting and running

```bash
nvm use 26
pnpm install --frozen-lockfile
pnpm check
pnpm build

./coord start 42 \
  --profile consensus \
  --config ./config.json \
  --coord-root /absolute/owner/runtime

COORD_ROOT=/absolute/owner/runtime COORD_ISSUE=42 ./coord run
```

`start` resolves the exact origin baseline, writes versioned runtime state,
initializes the bare mirror, creates an attachable `coord-<issue>` tmux
session, and invokes each configured `start-<agent>.sh`. A missing or
non-executable launcher is a startup error, never a fallback shell.

The coordinator can itself run in a tmux control window so closing the owner
terminal does not stop it. Attach with:

```bash
tmux attach -t coord-42
```

Claude nudges use `load-buffer`/`paste-buffer` only when the pane is alive, not
in pane mode, and running the expected harness. Codex, Cursor, and Antigravity
remain pull-only unless a future idle fixture proves insertion safe.

## Agent completion contract

An agent may push any number of intermediate commits. Only `complete` expresses
intent:

```text
0123456789abcdef0123456789abcdef01234567
```

The driver refreshes only the expected origin branch, proves the SHA is
reachable there, and checks the required path/schema/pins against that exact
commit. A failed mechanical check clears `complete` and reissues the same
action with concrete outstanding items. Attempts are diagnostic only and never
drop an agent or advance a gate.

A transient mirror fetch error preserves `complete`, emits no missing-artifact
verdict, and retries with the normal polling cadence. An absent agent is waited
for indefinitely unless the owner explicitly drops it.

## Profiles

- `solo`: one configured agent; plan, implementation, and finalization use solo
  checks.
- `reviewed`: all configured reviewers participate in plan selection, one
  designated implementer continues with solo final checks.
- `consensus`: every active agent joins, plans, reviews, implements, compares,
  and ballots; one reviser prepares up to three rounds.

When drops leave one active agent, future unresolved work degrades to the solo
sequence. Completed historical gates and immutable product pins are retained.

## Owner controls

Every command after `start` accepts `--coord-root` and `--issue`; `COORD_ROOT`
and `COORD_ISSUE` are equivalent.

```bash
./coord drop cursor --coord-root /absolute/owner/runtime --issue 42
./coord pause --coord-root /absolute/owner/runtime --issue 42
./coord resume --coord-root /absolute/owner/runtime --issue 42
./coord restart-action --agent codex --coord-root /absolute/owner/runtime --issue 42
./coord answer "continue after owner inspection" --coord-root /absolute/owner/runtime --issue 42
./coord abandon --coord-root /absolute/owner/runtime --issue 42
```

`drop` refuses the final agent, clears the dropped agent's pending local
completion, and rederives unresolved actions so their input sets omit that
agent. Later stale completions from the dropped agent are ignored.

`pause` retains actions, mirror data, journal, and tmux sessions. `resume` plus
`run` continues from strict versioned state. `restart-action` reissues pending
work without changing a gate. `abandon` stops the workflow while retaining its
audit state.

## Recovery and finalization

On restart, pending completion SHAs are reverified, current actions are reused,
and satisfied origin evidence prevents duplicate advancement. Runtime format
mismatches fail closed.

Finalization binds the accepted consensus/product pin to a separate cleanup
pin. From consensus to cleanup, only deletion of the current issue's
`.plans/**`, `.signals/**`, and `.code-reviews/**` files is allowed. The driver
then materializes a clean detached worktree at the cleanup pin and runs every
configured argv check. Any verifier or check failure blocks PR creation. A
successful `coord-open-unmerged` run may create a draft PR; only the owner can
merge it.

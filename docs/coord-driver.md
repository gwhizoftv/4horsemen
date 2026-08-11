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
- `digestPaths`: config-relative, confined source templates such as
  `.plans/issue-{issue}/plan.md`; their identities and hashes are persisted
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

COORD_ISSUE=42 ./coord run --coord-root /absolute/owner/runtime
```

`start` preflights the exact origin baseline, the running coordinator checkout's
real `HEAD` as its trusted source commit, digest inputs, GitHub/PR-policy
compatibility, confined non-symlink executable launchers, mirror, and tmux. It
creates an attachable `coord-<issue>` session and invokes each configured
`start-<agent>.sh` before committing active issue state. A failed partial tmux
launch is cleaned up, and no apparently active issue runtime is left behind.
Once state is committed, a failure in the initial tick is reported without
deleting the resumable runtime or terminating the successfully launched panes.

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

The exact alternative form `commit 0123456789abcdef0123456789abcdef01234567`
is also valid. Uppercase, padding, BOMs, abbreviated SHAs, JSON, prose, and
multiple lines are rejected.

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

Plan and implementation choices are tallied from the exact accepted active
ballot set. The highest vote count wins; ties use persisted active-roster
order. Selected plans, the implementation owner/pin, and the authorized
reviser are stored separately. Round 1 binds only the selected implementation,
and later rounds bind only the preceding accepted revision.

When drops leave one active agent, future unresolved work degrades to the solo
sequence. Completed historical gates and immutable product pins are retained.

## Owner controls

Every command after `start` requires an explicit `--coord-root` so the
safety-critical external state location remains visible at the call site.
`COORD_ISSUE` may replace `--issue`.

```bash
./coord drop cursor --coord-root /absolute/owner/runtime --issue 42
./coord pause --coord-root /absolute/owner/runtime --issue 42
./coord resume --coord-root /absolute/owner/runtime --issue 42
./coord restart-action --agent codex --coord-root /absolute/owner/runtime --issue 42
./coord answer <question-id> <retry|revise|abandon> --coord-root /absolute/owner/runtime --issue 42
./coord abandon --coord-root /absolute/owner/runtime --issue 42
```

`drop` refuses the final agent, clears only the dropped agent's local action and
completion, retains other agents' valid accepted evidence and pending intent,
and rederives only unresolved affected actions so their input sets omit that
agent. Later stale completions from the dropped agent are ignored.
An already-authorized reviser cannot be dropped because revision and
finalization may not be silently rebound without a new authorization.

`pause` retains actions, mirror data, journal, and tmux sessions. `resume` plus
`run` continues from strict versioned state. State changes use a short
exclusive lock plus a monotonic revision, so an in-flight fetch or check cannot
overwrite a concurrent pause, drop, or abandon. `restart-action` reissues
pending work without changing a gate. `answer` consumes one typed pending
question, is idempotent for the same answer, and cannot create round 4.
`abandon` stops the workflow while retaining its audit state.

## Recovery and finalization

On restart, pending completion SHAs are reverified, current actions are reused,
and satisfied origin evidence prevents duplicate advancement. Runtime format
mismatches fail closed.

Finalization binds the accepted consensus/product pin to a separate cleanup
pin. From consensus to cleanup, only deletion of the current issue's
`.plans/**`, `.signals/**`, and `.code-reviews/**` files is allowed. The driver
then materializes a clean detached worktree at the cleanup pin and runs every
configured argv check. Any verifier or check failure blocks PR creation. A
successful `coord-open-unmerged` run records accepted R7 and its check results
first, then uses a durable retryable publication outbox. That policy may push
an owner-visible `issue-<n>/<agent>-final` head to origin and create or reconcile
one draft PR. Publication failures never discard accepted finalization.
`owner-only` performs no origin write, and only the owner can merge any PR.

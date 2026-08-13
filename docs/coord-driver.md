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
<workspace-root>/
  mirror.git/
  issue-<n>/
    github-issue.json immutable start-time GitHub title/body snapshot
    start.json       immutable session/config baseline
    cursors.json     current internal cursor and dropped roster
    journal.jsonl    append-only owner/effect audit
    agents/<agent>/
      action.md      restricted public order
      complete       exact pushed SHA supplied by the agent
      render.log     optional human log
```

For a fresh single-product onboard, `<workspace-root>` is the outer coord root
and `config.json` is flat beside these paths. Additional products sharing that
outer root use `workspaces/<project>/` as their workspace root. They therefore
receive distinct mirrors, issue-number namespaces, and tmux session names.
Existing nested installs and their compatible legacy outer runtime state remain
resolvable; ambiguous duplicate state fails closed.

`action.md` exposes only an opaque action UUID, the caller identity, required
path, concrete task, exact bound input commits, and absolute completion path.
Internal step/gate/evidence identifiers remain in `cursors.json`.

## Configuration

Start from `config.example.json`:

- `origin`: canonical Git origin used by the bare mirror
- `agents[]`: stable id, clone root, executable launcher, delivery policy, and
  optional foreground harness process
- `branch`: must contain `{issue}` and `{agent}`
- `profile`: persisted default (`solo`, `reviewed`, or `consensus`) used by
  product-resolved start and `coord N`
- `maxRevisionRounds`: fixed at 3 or less; no round 4 is possible
- `prPolicy`: `owner-only` or `coord-open-unmerged`
- `digestPaths`: optional additional config-relative, confined source
  templates; the list may be empty
- `checks[]`: explicit argv arrays executed in a clean worktree at the final
  pin; no shell is invoked
- `pollIntervalMs`: bounded completion-file polling interval

Any `{worktree}` token in one check argument is replaced with the verification
worktree path. Expansion never creates shell text.

Every new run always hashes the exact config bytes and a canonical snapshot of
GitHub issue N from `config.origin`; optional `digestPaths` are added after
those mandatory sources. Agent-authored plans are later protocol evidence, not
owner-provided start input.

## Starting and running

Confirm the installed driver with `coord --version` (or `-V`). Pre-1.0 releases
use `0.0.N` and bump the patch on every shipped change so a merge is visible
after reinstall/refresh.

After `coord onboard`, the daily command is:

```sh
cd /path/to/onboarded/product
coord 42
```

The positive-number command resolves only the current registered worktree (or
an explicit `--product`), starts issue 42 if no compatible runtime exists, and
then enters the normal run loop. Repeating it resumes durable state without
refetching or rebinding an edited issue. From an unrelated worktree, pass
`--product /path/to/onboarded/product`; coordination never guesses from a
machine-global registry.

The explicit forms remain available:

```bash
nvm use 26
pnpm install --frozen-lockfile
pnpm check
pnpm build

coord start 42 --product /path/to/onboarded/product

coord start 42 \
  --config /absolute/owner/runtime/config.json \
  --coord-root /absolute/owner/runtime

COORD_ISSUE=42 coord run --coord-root /absolute/owner/runtime
```

`start` derives the repository from `config.origin`, runs an argv-safe `gh issue
view N --repo owner/repo`, validates the response, and canonicalizes the title
and body. Missing or unreadable issues fail before runtime, mirror, or tmux
effects with create/auth remediation. It then preflights the exact origin
baseline, the running coordinator checkout's real `HEAD` as its trusted source
commit, digest inputs, confined non-symlink executable launchers, mirror, and tmux. It
creates an attachable `coord-<issue>` session and invokes each configured
`start-<agent>.sh` before committing active issue state. A failed partial tmux
launch or later startup write is cleaned up, including the issue snapshot, and
no apparently active issue runtime is left behind.
Once state is committed, a failure in the initial tick is reported without
deleting the resumable runtime or terminating the successfully launched panes.

The coordinator can itself run in a tmux control window so closing the owner
terminal does not stop it. Flat workspaces retain the legacy name; nested
workspaces append the workspace hash printed by tmux/start diagnostics:

```bash
tmux attach -t coord-42
```

On macOS, `coord start` / a fresh `coord N` also opens one Terminal.app window per
agent, each attached to that agent's tmux window (separate clients — no Ctrl-b n).
Windows are titled on the **tab** as `coord-N-<group>/<agent>`, where `<group>`
is a stable 10-hex fingerprint of the workspace root. Attach uses `do script`
and sets that tab's custom title only. Detach/wipe close **only tabs whose
title exactly matches those ids** — never bare agent names and never
ungrouped `coord-N/<agent>`. Re-open those views
later with `coord attach N`. `coord detach N` kills the issue tmux sessions and
closes matching scoped titles without wiping runtime, clones, or branches.
`coord uninstall` tears down owner tmux/Terminal only for discovered issues; with
no sessions it is a no-op (it never closes bare agent-named tabs).

`coord wipe-issue N` is the owner reset for reusing a GitHub issue number: it
checks out each agent clone on the base branch, deletes local and origin
`issue-N/<agent>` branches, removes `coord-runtime/issue-N`, and runs the same
UI teardown as `detach`. It does **not** close the GitHub issue or uninstall the
product. Dirty clones refuse unless `--force`.

Nudge delivery uses literal `send-keys -l` (not paste-buffer — some TUIs such
as Antigravity ignore paste). Every onboarded agent defaults to `delivery: both`.
Per-agent config controls owner UI:

- `nudgePrelude` — tmux keys before the text (Codex default: `i` for vim insert)
- `nudgeSubmit` — tmux keys after the text (Claude/Cursor default: `Escape` then
  `Enter` to dismiss autocomplete; Antigravity default: `Enter` only — Escape
  cancels there; Codex default: `C-j` then `C-m`. Stale single `Enter`/`C-m` on
  Claude/Cursor, and mistaken Escape+Enter on Antigravity, are upgraded)
- `terminalProfile` — macOS Terminal.app settings-set name so each agent window
  can use a different look (defaults: Pro/Grass/Ocean/Red Sands)

Nudge waits until the pane shows an idle prompt (not Claude's trust dialog,
Antigravity splash, account-verification overlay, or an in-flight Antigravity
turn with `esc to cancel`).
If the first delivery is skipped (trust UI, wrong foreground name, splash),
the run loop retries until one successful delivery per action. Cursor panes
that report as `node` are treated as ready when `harnessProcess` is `agent`.
Use `coord N -v` for tick-level progress logs.

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

Every issue command accepts either an explicit workspace `--coord-root` or an
onboarded `--product`. Product resolution uses the same flat/nested and legacy
runtime lookup as `coord N`, so owner controls cannot accidentally target the
outer root of a nested product. `COORD_ISSUE` may replace `--issue`.

```bash
coord drop cursor --product /path/to/app --issue 42
coord pause --product /path/to/app --issue 42
coord resume --product /path/to/app --issue 42
coord restart-action --agent codex --product /path/to/app --issue 42
coord answer <question-id> <retry|revise|abandon> --product /path/to/app --issue 42
coord abandon --product /path/to/app --issue 42
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

# Coord driver operator guide

## Authority and safety model

`coord` is an owner-local control-plane process. Owner commands take effect
directly and are journaled; there are no signed drop/override artifacts. After
finalization the driver opens a pull request. Default `prPolicy` is
`coord-open-unmerged` (draft PR; owner merges). `coord-merged` opens a ready PR
and merges it. Legacy `owner-only` is the same as `coord-open-unmerged`.

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
    cursors.json     workflow pointers (not the Cursor agent): step, roster, pins
    agent-lifecycle.json  coordinator-owned CLI delivery/activity observations
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
- `prPolicy`: `coord-open-unmerged` (default; draft PR, owner merges),
  `coord-merged` (coord merges), or legacy `owner-only` (same as open-unmerged)
- `digestPaths`: optional additional config-relative, confined source
  templates; the list may be empty
- `contextPaths`: optional confined product-relative files an agent should read
  first to orient — a repo map, an architecture note. Coordination names them
  in a `## Repo context` section of every `action.md`; it never inlines their
  contents, because the measured cost is what enters an agent's context, and
  naming a short list is what replaces a repository-wide search rather than
  adding to it. They are advisory documentation and are deliberately **not**
  digest material: an owner must be able to correct a stale context note
  mid-run without invalidating every published artifact.
- `checks[]`: explicit argv arrays executed in a clean worktree at the final
  pin; no shell is invoked
- `pollIntervalMs`: bounded completion-file polling interval

Any `{worktree}` token in one check argument is replaced with the verification
worktree path. Expansion never creates shell text.

## Advisory sections in `action.md`

Two body sections are rendered only when they have content, so a step with
neither is byte-identical to what it produced before they existed.

- `## Repo context` lists the configured `contextPaths`.
- `## Changed paths for the bound pins` lists, for each bound input that pins a
  product commit, the paths that commit changed against the issue baseline.
  Coordination resolves each pin once per tick, so N agents comparing the same
  pins cost N diffs rather than N×N. The list is capped per pin and marked when
  truncated.

Both are informational. `approvedPaths` remains the only authority over what an
implementation may change, and neither section is read back by any verifier.

Paths in both sections are JSON-encoded strings, one per line. Git permits
backticks and newlines in pathnames, and an advisory hint must never be able to
abort action preparation or forge a heading — so the encoding is total over
valid pathnames rather than rejecting the awkward ones.

Every new run always hashes the exact config bytes and a canonical snapshot of
GitHub issue N from `config.origin`; optional `digestPaths` are added after
those mandatory sources. Agent-authored plans are later protocol evidence, not
owner-provided start input.

## Owner-driven manual lifecycle

`coord manual` is a launch/attach lifecycle, not a workflow profile. From an
onboarded product it resolves the registered config; explicit callers may use
`--product` or `--config <path> --coord-root <path>`. It validates all
configured launchers, creates or repairs the workspace's
`coord-manual-<group>` tmux session, reuses live agent panes, respawns dead
panes, creates missing agent windows, opens only missing macOS Terminal clients
titled `coord-manual-<group>/<agent>`, prints the outcome, and returns. On other
platforms it prints tmux attach commands.

There is no coordinator process after launch. Manual mode does not fetch or
snapshot a GitHub issue, initialize the mirror, create `issue-*` runtime state,
write `start.json`, cursors, journals, lifecycle state, `action.md`, or
`complete`, nudge agents, run checks/consensus/finalization, publish a branch,
or open a PR. Owner chat is the task authority and agents work on their own
`<agent>/<name>` scratch branches without fabricating protocol evidence. Git
hooks and all identity, verification, no-main, no-peer, commit-prefix, and
no-force rules remain enabled.

Manual startup refuses while this workspace has a live numeric issue session;
numeric start/resume/run/attach refuses while the exact manual session is live.
This prevents both modes from racing on the same clones. `coord detach manual`
closes exact grouped Terminal titles before killing the exact primary and
linked manual tmux sessions, without touching configuration, clones, runtime,
branches, or another product. Re-run `coord manual` to recover missing/dead UI.
Uninstall performs the same workspace-scoped cleanup even when there are no
`issue-*` directories.

## Starting and running

Confirm the installed driver with `coord --version` (or `-V`). Pre-1.0 releases
use `0.0.N` and bump the patch on every shipped change so a merge is visible
after reinstall/refresh. That bump is required on the PR into `main`: the
`version-bump` GitHub Action runs `pnpm check:version-bump` and fails merges
whose `package.json` is not strictly greater than the PR base. Mid-protocol
`pnpm check:fast` (precommit) does not enforce the advance. Concurrent PRs must
claim distinct next versions (e.g. `0.0.3` then `0.0.4`).

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

On macOS, `coord start` / `coord N` also opens one Terminal.app window per
agent, each attached to that agent's tmux window (separate clients — no Ctrl-b n).
A resume of `coord N` recreates missing tmux sessions and dead agent panes, and
opens Terminal windows that are not already open. Windows are titled on the **tab**
as `coord-N-<group>/<agent>`, where `<group>`
is a stable 10-hex fingerprint of the workspace root. Attach uses `do script`
and sets that tab's custom title only. Detach/wipe close **only tabs whose
title exactly matches those ids** — never bare agent names and never
ungrouped `coord-N/<agent>`. Re-open those views
later with `coord attach N` while the coordinator is already running. `coord detach N` closes matching Terminal windows
(by unique title / window name) then kills the issue tmux sessions, without
wiping runtime, clones, or branches. When `coord N` / `coord run` finishes with
a completed workflow, it runs the same teardown automatically.
`coord uninstall` tears down owner tmux/Terminal for discovered issues and the
exact workspace-grouped manual identity. It never closes bare agent-named tabs
or another product's sessions.

`coord wipe-issue N` is the owner reset for reusing a GitHub issue number: it
checks out each agent clone on the base branch, deletes origin `issue-N/<agent>`
and `*-final` branches, and drops leftover `refs/remotes/origin/issue-N/*`
tracking refs in clones, the product worktree, and `coord-runtime/mirror.git`.
A local `issue-N/*` branch in the product is kept when it has uncommitted work
or commits that are not just a checkout of the clone. Removes
`coord-runtime/issue-N`, and runs the same UI teardown as `detach`. It does
**not** close the GitHub issue or uninstall the product. Dirty clones refuse
unless `--force`. Clone-local skip-worktree on `AGENTS.md` is lifted so checkout
onto the base branch can proceed.

On `coord N` start (and resume), coordination lifts that skip-worktree bit,
checks each agent clone out on `issue-N/<agent>` at the issue baseline (or the
existing issue branch, without resetting it), then restores the protocol overlay.
Agents do not switch branches under skip-worktree `AGENTS.md`. Dirty clones refuse.

Nudge delivery uses literal `send-keys -l` (not paste-buffer — some TUIs such
as Antigravity ignore paste). Every onboarded agent defaults to `delivery: both`.
Per-agent config controls owner UI:

- `nudgePrelude` — tmux keys before the text (Codex default: `i` for vim insert)
- `nudgeSubmit` — tmux keys after the text (Claude default: `Escape` then
  `Enter` to dismiss autocomplete; Cursor without vim and Antigravity default:
  `Enter` only — Escape dismisses a non-vim Cursor composer and cancels
  Antigravity; Cursor with `editor.vimMode` uses `Escape` then `Enter` so
  INSERT does not treat Enter as a newline; Codex default: `C-j` then `C-m`.
  Stale single `Enter`/`C-m` on Claude, mistaken Escape+Enter on non-vim
  Cursor/Antigravity, and stale `C-m` on Antigravity, are upgraded)
- `terminalProfile` — macOS Terminal.app settings-set name so each agent window
  can use a different look (defaults: Pro/Grass/Ocean/Red Sands)

Nudge waits until the pane shows an idle prompt (not Claude's trust dialog,
Antigravity splash, account-verification overlay, or an in-flight Antigravity
turn with `esc to cancel`). Before the prelude, the action text, and every
submit key, the driver re-reads `pane_dead`, `pane_current_command`,
`pane_in_mode`, and `pane_input_off`. If the pane is dead, in copy/mode, has
input off, or the foreground command is no longer the harness, it skips that
injection (`busy` / `gone`) instead of typing into a pane that changed after
the original readiness check. Antigravity then waits 2.5s and recaptures: tmux
sessions often paint the verify overlay after `>` looks idle, which discards
a typed nudge.
If the first delivery is skipped, the action remains ordered. It is eligible
again only after a positive lifecycle observation says the CLI became idle or
the CLI session was replaced. After a successful send, the coordinator records
only `injected`. Native CLI hooks separately establish `accepted`, `queued`,
`working`, `idle`, or `failed`. The 45-second interval is now a hook-health
watchdog: missing observations change health to `degraded`, print an operator
remedy on normal output, and suppress duplicates instead of authorizing another
send. One nudge is allowed per new eligible idle transition.

There is one narrowly scoped recovery for a successful tmux write whose
keystrokes never reached the CLI: no hook may have correlated a turn, pending
input and background work must be absent, and a fresh pane capture must show a
vendor-ready prompt that does not contain the exact action UUID. Only that
positive proof returns the action to `ordered`; elapsed time or a missing
`complete` file alone never authorizes a duplicate.

Cursor panes that report as `node` are treated as ready when
`harnessProcess` is `agent`. Cursor's composer placeholder text is not a
stable idle hint. Cursor submit is Enter when vim is off (Escape dismisses
that composer) and Escape then Enter when `editor.vimMode` is on or
`nudgePrelude` is a non-empty override. Prelude `a` is sent only in that
vim case, and only if the pane is not already INSERT (home
`~/.cursor/cli-config.json`, then clone `.cursor/cli.json`). Typed nudge text
includes both the opaque `actionId` and the SHA-256 digest of the exact
`action.md`. A delayed hook for an older rewrite therefore cannot accept the
current action accidentally.
Phase changes (R1.join → R2.plan, and later RN steps) always print.
Use `coord N -v` for tick-level nudge and roster logs.

### Agent-facing language boundary

Internal step ids (`R1.join`), gate ids (`gate-1-join`), evidence ids
(`join-published`), and delivery vocabulary stay in cursors state, the journal,
analytics, CLI output, and this document. They are the operator's and the
owner's view of the workflow, and nothing here needs sanitizing.

Three surfaces do reach an agent and must stay free of that vocabulary: the
rendered `action.md` body, the typed injection text, and the protocol overlay
installed into a clone. `src/agentLanguage.ts` holds the single banned-term list
plus `agentFacingSubject`, which names the artifact behind an evidence id so a
pin-lineage rejection can be reported without the id itself — those diagnostics
are re-rendered to the agent under `Correct these outstanding items:`.
`test/agentLanguage.test.ts` scans every entry in `STEP_DEFINITIONS`, with and
without bound inputs and with a non-empty correction block, so a new step cannot
be added without being covered.

The checker is a test-time invariant, not a runtime guard: `outstanding` strings
carry git output and branch names from outside the process, so a false positive
must fail a test rather than abort a run loop. Do not "fix" the operator
documentation or analytics tables to satisfy it; they are deliberately out of
scope.

### CLI lifecycle state

The model never writes `waiting.json`, `working.json`, or equivalent state.
The vendor CLI produces deterministic hook/status payloads, `coord agent-event`
validates them, and the coordinator persists only normalized fields. Delivery
(`ordered`, `injected`, `accepted`), execution (`unknown`, `queued`, `working`,
`idle`, `failed`), and observability health (`unknown`, `healthy`, `degraded`)
are separate axes. They are stored outside `cursors.json` so a hook arriving
during Git/tmux work cannot invalidate the workflow authority revision.

Correlation uses the configured clone identity, issue, action UUID and digest,
plus the vendor session/conversation and turn/generation identifiers. A new
session invalidates observations from the replaced process. Antigravity queue
depth, pending tool confirmations and `fullyIdle: false`, and Claude background
tasks/session crons, keep an agent non-idle even after a stop callback. `coord
status` prints all three axes and any pending/background indicators.

While an implementation or revision action remains in flight, each poll
re-resolves the approved file map from the pinned plan evidence and rewrites
`action.md` with the same action UUID. If an extractor upgrade changes those
paths, the changed action digest invalidates stale hook correlation and the
coordinator still applies the lifecycle idle gate before injecting it.

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
configured argv check. Any verifier or check failure blocks PR creation. After
accepted R7 the driver pushes `issue-<n>/<chosen-agent>-final` at the cleanup
pin and opens a PR. `coord-open-unmerged` (and legacy `owner-only`) leaves that
PR as a draft for the owner to merge. `coord-merged` marks it ready and merges
it. Publication failures never discard accepted finalization. `coord status`
and a completed `coord N` print the chosen agent, final pin, published branch,
and PR URL.

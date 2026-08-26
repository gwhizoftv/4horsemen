## Comparison

I compared the exact bound trees for Claude
`d198c34682ddaafd3967d8c2ea94f9761ece9fae`, Cursor
`64a9e958421d067fcf5e23d399fd9471a18abe20`, and Codex
`4b17f983a143f21f57bb1cace7d61e9d58cc1a1e`. All three put the
discard-only operation beside `prepareAgentIssueBranches`, invoke it only after
completed-session UI teardown, preserve the issue branch ref and published
commits, skip missing/non-worktree roots, restore the `AGENTS.md` protocol, and
teach non-force wipe to accept WIP on the exact issue/agent branch. None adds a
commit, stash, or push path.

**Claude.** This tree has the most detailed per-helper tests and the best
immediate audit log: it records discarded paths before attempting the base
checkout. It also deliberately preserves a local base commit that is not in
origin. Its main weakness is that it couples all participants even for normal
completion and can report a preserved or stale base as successfully synced.

- `src/prepareAgentBranch.ts:464`: normal completion must refuse an unsafe clone
  independently while still making other eligible clones ready. If one clone
  has dirty work on `main`, the batch branch maps every otherwise eligible clone
  to `refused`, so their authorized issue-branch WIP remains and the next issue
  still encounters clones that were never returned to base. A two-clone
  completion test should expect one refusal and one successful cleanup; reserve
  all-or-nothing preflight for non-force wipe.
- `src/prepareAgentBranch.ts:289`: a result that claims the base is synchronized
  must be bound to a successful fetch, or explicitly identify a stale fallback.
  If `git fetch` fails while an old `origin/main` tracking ref exists, the ignored
  fetch result is followed by a successful `rev-parse`; the clone is checked out
  at that stale commit and returned with `baseSynced: true`.
- `src/prepareAgentBranch.ts:314`: a successful base-ready result must either
  land at the resolved `origin/<base>` tip or refuse when moving the local base
  would discard unauthorized history. With an ahead/diverged local `main`, this
  branch checks out the local tip but still returns `checked-out` (and can report
  `baseSynced: true`), so the completion summary says ready even though `HEAD`
  does not equal the fetched remote base. Preserve the commit, but return an
  actionable refusal instead of success.

**Cursor.** This is the smallest implementation and its per-clone refusal
matches completion's independence requirement. The bound tree also includes
the later `docs/repo-map.md` correction, so the comparison is against the exact
requested pin rather than only its earlier implementation commit. Its success
paths, however, do not consistently prove that the worktree is clean or that
the base was refreshed.

- `src/prepareAgentBranch.ts:316`: every non-skipped success must refresh and
  reconcile the configured base before reporting the clone ready. A clean clone
  already on `main` returns `already-base` without fetching; if origin advanced
  since the prior issue, the stale local `main` is reported ready unchanged.
- `src/prepareAgentBranch.ts:340`: destructive cleanup must check that every
  cleanup command succeeded before reporting the captured paths discarded and
  the clone ready. If `git clean -fd` cannot remove an untracked path, its
  non-zero result is ignored; checkout can still succeed when that path does not
  conflict, producing `checked-out` while `git status` remains dirty. A test
  using an unremovable or nested-repository path should assert refusal rather
  than success.
- `src/prepareAgentBranch.ts:346`: a refreshed `origin/<base>` may be used only
  after checking the fetch result. With an unavailable remote and a stale
  `origin/main`, the code ignores the failed fetch, selects the stale tracking
  ref, and reports a successful origin-based checkout.

**Codex.** This tree has the strongest lifecycle integration: the helper has
separate `finished-issue-only` and `force-wipe` discard policies, completion can
continue per clone while non-force wipe selects an all-clone preflight, wipe's
old duplicate reset/checkout block is removed, fetch failure is explicit, and
postconditions verify the branch, SHA, and protocol state. Its tests also cover
the shared wipe preflight and a real completed CLI cleanup. Two safety/audit
gaps remain.

- `src/prepareAgentBranch.ts:417`: every destructive reset/clean must be logged
  even when a later operation fails. If reset and clean succeed but the
  `checkout -B` at line 421 fails, the catch returns a `refused` result and only
  logs the checkout failure; the success-only log at line 450 never runs, so the
  owner is not told that the listed WIP was already deleted. Log the discard
  immediately after `clean`, and add a test that forces checkout failure after a
  successful cleanup.
- `src/prepareAgentBranch.ts:421`: finished-issue authorization permits
  discarding WIP from the exact issue branch, not orphaning commits reachable
  only from a local base ref. If local `main` is ahead of or diverged from
  `origin/main`, `checkout -B main origin/main` repoints it and leaves the
  local-only commits reachable only through reflog. Preflight local-base
  ancestry and return a refusal before reset/clean; `force-wipe` may retain an
  explicit override if that destructive behavior is intended.

The Codex pin is the strongest basis for finalization because it uniquely
combines strict fetch handling, explicit completion-versus-wipe policies,
postcondition checks, and removal of wipe's duplicate mutation path. It should
not be accepted unchanged: the local-base ancestry guard must happen before any
discard, and discard audit output must survive a later checkout failure. Claude
is the safer fallback for local base history but needs its global completion
refusal and false synchronization success fixed. Cursor needs the broader
readiness fixes above before it can provide the same guarantees.

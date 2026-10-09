# Issue 172 plan review

Bound inputs reviewed, read from the exported Bound input files:

- cursor `cde4a70b515558e80d32c422a85fd9e50529f1c4`
- codex `be4b37b973bb3420d44cbe41f7238d9c1c167a05`
- claude `3e67191cefbc89b732f7cf8c412b3b30e214bc5e`
- antigravity `d298175f625de94aeedd41a1d86c1f95d5cea268`

All four plans are at `.plans/issue-172/plan.md`. Baseline is `80a3e71`.

Facts checked against the baseline:

- `CoordinatorRunLoop.ownerReminders` is a private in-memory `Map` that only the
  foreground runner's `runTick` drains (`src/runLoop.ts:908-929`, `:2958-2975`).
- `guardShellRequest` decides by spawning the clone's shim with
  `COORD_GIT_POLICY_CHECK=1` (`src/shellGuard.ts:279-310`). The shim is
  therefore the single policy.
- `makeAgentClonesBaseReady` has no "unpublished work" check. When origin is
  reachable it runs `checkout -B <base> origin/<base>`, which resets a diverged
  local base (`src/prepareAgentBranch.ts`, `resolveCloneBaseTarget` and the
  "resetting diverged local" path).
- `resolveStart` without flags already resolves from an owner checkout via
  `resolveWorkspaceFromProduct(io.cwd)` (`src/cli.ts`, `resolveStart`), but
  rejects a registered agent clone.
- Issue 172 was created 2026-10-06. The `----` report frame and the interactive
  `n` reminder were added later, in `46586e2` (2026-10-08).
- tmux 3.7b on this host supports `#{pane_start_path}`.

I ran no product tests. This is a plan review, and every finding is
established from source.

## Findings

### Cursor (`cde4a70b`)

**C1 — `src/cli.ts` (5): "add `coord nudge [--agent <id>|--all]` that reuses
`CoordinatorRunLoop.reminders()` / nudge delivery".**

- *Rule:* an owner reminder must be queued in the one foreground runner that
  owns `ownerReminders` and the send-safety reservations. Readiness, spacing,
  the four-send limit and holds are enforced only there.
- *Failure:* `coord nudge --all` runs in a second process and builds its own
  `CoordinatorRunLoop`. `request()` stores the reminder in that instance's
  private Map, prints "Reminder requested…", and the process exits, so nothing
  is ever sent. If the verb instead calls delivery directly, two processes write
  `actionSafety` sends and reservations for the same action. That reopens the
  duplicate-nudge and budget races the run loop serializes.
- *Correction:* drop the CLI verb and add only the "all agents" row to the
  existing interactive `n` menu.

**C2 — `src/cli.ts` (1): "after `detach manual` … call
`makeAgentClonesBaseReady` with the same refuse-unpushed-work policy used by
`detachCompletedIssue`".**

- *Rule:* manual cleanup must refuse, never drop, unpublished owner work, as the
  issue's own proposal requires. No such policy exists to reuse:
  `makeAgentClonesBaseReady` only refuses dirty trees off the issue branch. It
  also needs an `issue`/`branchTemplate` that manual mode does not have.
- *Failure 1:* an owner commits on local `main` in a manual session without
  pushing, then runs `coord detach manual`. The clean clone is moved with
  `checkout -B main origin/main`, and the commit leaves `main`, recoverable only
  from the reflog.
- *Failure 2:* a clean `<agent>/<name>` branch with unpushed commits is switched
  away with no refusal.
- *Correction:* add a non-discarding manual readiness path. It should refuse
  dirt, refuse a HEAD not contained in its upstream or `origin/<base>`, and
  refuse a local base ahead of origin.

**C3 — `src/cli.ts` (2): "if a leftover manual tmux session exists, detach it
and base-ready the clones before continuing".**

- *Rule:* the issue's last item asks coord to "ask the owner if they should be
  cleaned up first". A live manual harness may still be doing owner work.
- *Failure:* an owner leaves Codex running a long manual edit and runs
  `coord 173`. The manual pane is killed mid-turn with no prompt. Logging the
  cleanup afterwards does not restore the interrupted work.
- *Correction:* require confirmation on a TTY, and refuse with the current
  message otherwise.

**C4 — `src/cli.ts` (3) with `src/codexQuota.ts` "or" an optional
`src/codexAppServer.ts`: stop or restart a leftover Codex app-server on
`coord manual`.**

- *Rule:* the file map must be exact, and new files and effects must be
  justified. Issue 186 already launches Codex with `--no-daemon`
  (`scripts/lib/launcher.sh`, `launcher_command codex`), so a leftover daemon is
  no longer consulted by coord-launched panes.
- *Failure 1:* the implementation's file scope is undecidable. It may create
  `src/codexAppServer.ts` or edit a quota module for process lifecycle, and a
  reviewer cannot check either against the approved map.
- *Failure 2:* stopping "the app-server for the agent home" targets the
  user-level Codex daemon. That interrupts the owner's unrelated Codex sessions,
  which still use it.
- *Correction:* drop the helper and cite issue 186.

**C5 — Tests (7): "from an onboarded product cwd, issue/status/manual commands
succeed without an explicit `--coord-runtime`".**

- *Rule:* each new test must fail before the change.
- *Failure:* this already passes at baseline. `resolveStart` falls back to
  `resolveWorkspaceFromProduct(io.cwd)`, and `existingContext` to
  `resolveWorkspaceFromWorktree`. The real remaining gaps go untested:
  - `coord <issue>`, `reset-clones`, `detach` and `wipe-issue` run from a
    registered agent clone fail with "is not onboarded in this worktree";
  - `--config` given without `--coord-runtime` is rejected.
- *Correction:* test from an agent-clone cwd and test `--config` alone.

**C6 — `scripts/lib/launcher.sh`: "mirror the shell-guard binding rule"
(issue branch + `start.json` roster/root/`issueSessionId`).**

- *Rule:* the shim is bash with no JSON parser, and it has no `issueSessionId`
  input.
- *Failure:* the plan leaves unspecified how bash verifies `start.agents[].root`.
  A grep over `start.json` mis-matches JSON-escaped paths. Calling Node from the
  shim adds a failure point to every git call (see X1).
- *Correction:* use durable predicates that bash can test exactly: an explicit
  `COORD_MANUAL`, an absent issue directory, or a top-level completed/abandoned
  flag.

### Codex (`be4b37b9`)

**X1 — §1: "Expose this resolver through a small internal CLI context-query mode
for the generated shim … Missing or unreadable evidence returns an explicit
unverified diagnostic and does not manufacture … an automated denial".**

- *Rule:* in a live automated issue, the shim's refusal of `git status`/`diff`
  must not depend on an extra fallible process. Today it refuses on
  `COORD_ISSUE` plus the clone target alone, so it fails closed.
- *Failure:* every agent git call that targets the clone (`add`, `commit`,
  `push`, `status`) now starts the coord CLI. The coord wrapper rebuilds `dist`
  when stale (`test/wrapper.test.ts`, "resolves a PATH symlink to the install
  root before pnpm build"). Codex runs with `--sandbox workspace-write` and
  cannot write the install root, so the query fails. By the plan's own rule the
  shim then denies nothing, and status/diff reconnaissance silently resumes
  during a live issue. It also adds a Node start-up to each commit/push.
- *Correction:* keep the decision in bash on durable local evidence, and fail
  closed when evidence is unresolvable.

**X2 — §3 manual readiness: "Accept only the configured base branch or that
clone's own `<agent>/<name>` branch; refuse … unrelated issue branches".**

- *Rule:* the AGENTS.md manual-mode protocol allows owner work on an issue branch
  "when the owner explicitly supplies an issue branch". Readiness must turn on
  whether work is published, not on the branch name.
- *Failure:* the owner directs Codex to finish a fix on `issue-170/codex` and
  pushes it. `coord detach manual` and the next `coord 173` reconciliation both
  refuse that clone forever. That is the same dead end the issue reports.
- *Correction:* accept any branch whose HEAD is contained in its verified
  upstream or base.

**X3 — §3 reconciliation: auto-clean "only sessions whose configured panes are
… positively idle with an empty composer and no active tool/background
descendant", with any uncertainty treated as refusal and no owner prompt.**

- *Rule:* the fix must remove the need for a separate detach (item 4), and the
  issue says to "ask the owner".
- *Failure:* the normal leftover state is a live CLI at its prompt. Proving an
  "empty composer" depends on screen-scraping, and descendant checks need new
  `ps` ancestry code. Any uncertainty refuses, so the common case still prints
  "run `coord detach manual`" and the reported friction remains.
- *Correction:* ask the owner on a TTY, and keep the safety checks for the
  clones, not for the panes.

**X4 — Scope: `src/agentEvent.ts` routing changes, `src/workspace.ts` discovery
of non-Git workspace directories, `uninstall` defaulting, process-ancestry
inspection, and `templates/product/gitignore.coordination.block`.**

- *Rule:* make the smallest change that fully solves the issue. Destructive
  commands keep explicit paths.
- *Failure 1:* including `uninstall` in implicit runtime selection means that
  `coord uninstall --wipe-runtime --delete-clones` run inside a registered clone
  deletes that workspace without the owner naming it.
- *Failure 2:* the `agentEvent.ts` adoption and session-matching changes touch
  hook-receipt establishment for every issue, which the issue does not ask for.
  They widen regression risk and the test surface across seven-plus files.
- *Correction:* limit implicit selection to non-destructive commands, and drop the
  `agentEvent.ts` changes.

**Not a finding:** treating status framing as already satisfied is defensible.
The `----` frame was added after the issue was filed.

### Antigravity (`d298175f`)

**A1 — Conclusion: "This plan addresses all items from Issue 172".**

- *Rule:* the plan must cover every issue item or justify each omission.
- *Failure:* it does not address:
  - status start/stop separation;
  - defaulting `--coord-runtime` in an onboarded workspace;
  - nudging all agents;
  - verifying each agent's terminal/tmux placement;
  - the Codex app-server item (not even cited as handled by issue 186).

  After implementation, the owner still has to pass `--config`/`--coord-runtime`
  from an agent clone, and still cannot nudge everyone.
- *Correction:* add or explicitly justify each item.

**A2 — File list: `.gitignore` only for `.pnpm-store/`.**

- *Rule:* the issue says the store "could also happen during a normal issue
  run". Product clones get ignores from `DEFAULT_CLONE_IGNORES`, not from this
  repository's `.gitignore`.
- *Failure:* Codex in any onboarded product clone creates `.pnpm-store/`, and
  the next `coord <issue>` still refuses with "uncommitted changes".
- *Correction:* also add it to `DEFAULT_CLONE_IGNORES` in
  `src/productIgnore.ts`, and assert it in `test/install.test.ts`.

**A3 — `src/shellGuard.ts` allows on completed/abandoned issues and on session
mismatch, while `scripts/lib/launcher.sh` relaxes only on `COORD_MANUAL=1` or
an absent runtime directory.**

- *Rule:* the native guard and the shim must apply one policy. The guard already
  asks the shim, and the shim performs the real refusal.
- *Failure:* consider a manual session with an inherited `COORD_ISSUE=170` for a
  completed issue whose runtime is retained (the default after completion). The
  native hook allows `git status`, but `.coord/bin/git` still exits 2 with
  "blocked in this clone during automated issue 170". Manual work stays blocked.
- *Correction:* put every staleness predicate in the shim and leave the TS guard
  delegating to it.

**A4 — `src/shellGuard.ts`: allow "when `request.sessionId` … differs from
`entry.sessionId`".**

- *Rule:* containment may relax only on evidence that is not routinely stale
  during a live issue.
- *Failure:* the lifecycle `sessionId` changes only when a SessionStart hook is
  recorded. If hooks are untrusted or not firing (the exact case
  `reportStartup` warns about), or the CLI restarts before the hook lands, every
  live-issue `git status`/`diff` is allowed.
- *Correction:* drop session mismatch as an allow signal.

**A5 — `src/cli.ts`: "update `assertNoManualSession` to detect and safely clean
up leftover manual UI when safe", without defining "safe" or asking the owner.**

- *Rule:* destructive cleanup needs stated criteria and owner consent.
- *Failure:* the implementer must choose criteria the plan never reviewed. The
  likely choice of "clean clones" kills a live manual harness that is mid-turn
  but has not written to disk yet.
- *Correction:* confirm on a TTY, and refuse otherwise.

**A6 — Tests (4): asserts `guardShellRequest` returns `{ decision: "allow" }`.**

- *Rule:* allow is vendor-shaped, as `shellGuardResponse` shows: `{}` for
  claude/codex and `{ permission: "allow" }` for cursor.
- *Failure:* the stated assertion fails for three of the four vendors even when
  the behavior is correct.
- *Correction:* compare to `shellGuardResponse(vendor)`.

### Claude (`3e67191c`, self-review)

**M1 — `src/tmux.ts` `agentPlacementDiagnostics`: compares `#{pane_start_path}`
with the agent root.**

- *Rule:* an advisory check must not warn on an unknown value.
- *Failure:* a tmux version without `pane_start_path` expands the format to an
  empty string, and every agent is reported as "started in the wrong folder".
  tmux 3.7b supports the format.
- *Correction:* treat an empty start path as unknown, and warn only on a
  non-empty mismatch.

**M2 — `src/issueReport.ts` banner change.**

- *Rule:* avoid churn on a request the baseline already meets.
- *Failure:* none is functional. The `----` frame postdates the issue filing, so
  the relabeling is optional polish. It is kept small (one function and one
  assertion), and it is acceptable either way.

## Conclusion

Comparison by issue coverage and risk:

- **Claude** covers every issue item, or cites baseline code that already resolves
  it. It keeps the guard fail-closed with one bash policy, asks the owner before
  any teardown, and refuses rather than discards on manual cleanup. It needs only
  the two minor corrections M1 and M2, and creates no files.
- **Codex** is the most careful about ownership and evidence. Its shim design
  (X1) re-opens the guard whenever the coord CLI fails. It strands published
  manual work on issue branches (X2), leaves the common leftover case unsolved
  (X3), and widens scope into `agentEvent.ts` and destructive defaults (X4).
- **Cursor** has a `coord nudge` verb that cannot deliver (C1), a manual detach
  that can drop a local base (C2), and unconfirmed teardown (C3). It also
  includes an undecided extra file and a daemon kill (C4), and a runtime test that
  already passes at baseline (C5).
- **Antigravity** omits five issue items (A1) and product-clone ignores (A2).
  Its guard and shim disagree (A3), and it adds a containment bypass via
  session mismatch (A4).

Recommendation: select the Claude plan with correction M1 applied during
implementation. Codex's evidence-preserving ideas worth carrying over are
already in it: recheck before mutating, never reset or clean manual work, and
use `set-environment -r` in both modes. Cursor's and Antigravity's plans should
not be selected as written.

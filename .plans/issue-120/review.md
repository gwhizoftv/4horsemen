# Issue 120 plan review

Bound plans reviewed:

- Cursor: `d049e7b79662a59e717ff97c7fbc8d0274f3bc22`
- Claude: `6cf79d06be8623a8b264dd4345572e341a990bf0`
- Codex: `bd3231172e002b5e74823fbfc68fe17ea090fc60`

## Findings

1. **Claude — per-clone refusal permits a destructive partial batch.** The
   `makeAgentClonesBaseReady` sequence says a dirty wrong-branch clone returns
   `action: "refused"`, and the risks section says each clone is handled
   independently so one refusal does not skip the others. The issue's safety
   rule requires ambiguous dirt to refuse with the same “Nothing has been
   changed” posture as the existing global dirty gate; therefore every usable
   clone's branch and status must be checked before the first destructive Git
   command. With two clones, the proposed loop can reset/clean clone A on its
   matching issue branch and only then discover that clone B is dirty on
   `issue-(N-1)/b`; the batch reports a refusal after clone A's unpublished WIP
   has already been irreversibly discarded. Add an all-clone read-only
   branch/status preflight and abort the whole readiness pass before any lift,
   reset, clean, or checkout when one clone has ambiguous dirt.

2. **Claude — local-base fallback does not satisfy base readiness.** Step 4 of
   the helper makes `git fetch` best-effort and falls back from
   `origin/<base>` to a local `<base>` ref. The required postcondition is that a
   completed clone is on the configured base branch *at* `origin/<base>`; a
   missing or unreadable origin base must refuse rather than substitute a
   different commit. If origin has advanced while the clone's local `main` is
   stale, an offline fetch makes the helper report success on the stale commit,
   so the clone is not start-ready and the next issue must move it again (or can
   fail on the protocol overlay during that move). Require origin fetch/ref
   resolution, verify `HEAD == origin/<base>` after checkout, and report a
   failed readiness outcome when that invariant cannot be established.

3. **Cursor and Codex — cleanup is allowed to run while agent panes are still
   alive.** Cursor's `src/cli.ts` map leaves the call “before or immediately
   after UI detach,” while Codex explicitly places cleanup before automatic
   detach. Destructive readiness must run only once the terminal session is
   quiescent; durable workflow completion closes action authority, but it does
   not itself kill a CLI or a child process that can still write the worktree.
   If the implementation chooses the permitted pre-detach ordering, an agent
   can create or rewrite a file after the helper's sole status/reset/clean pass
   and before tmux is killed, leaving a dirty clone even though the command
   reports completion and causing the next `coord M` to refuse. Run
   `detachIssue` first, then perform base-readiness cleanup in the same
   completed-session path; log cleanup refusal separately from the already
   completed workflow rather than racing a live pane.

4. **Cursor — the test map never exercises the completion call site.** The
   plan changes `src/cli.ts` but lists no `test/cli.test.ts` change and confines
   focused coverage to the helper and wipe integration. The acceptance rule is
   specifically about the state after completed `coord N` / `coord run`, so at
   least one test must traverse the shared completed-session teardown with a
   real Git clone. An implementation could define a correct helper but omit the
   call, pass the wrong issue/branch template, or clean only the wipe path; every
   test in the Cursor plan would pass while a normal completed run still only
   detaches UI and leaves WIP behind. Extend the CLI completion test with a
   temporary origin/clone and assert the dirty matching issue branch becomes
   clean and base-ready without a new commit.

5. **Cursor and Claude — blindly resetting the local base ref can discard work
   on a different branch.** Both plans end with `checkout -B <base>
   origin/<base>` but do not inspect an existing local base ref first. The
   non-goal forbids silently discarding work on another branch; that includes
   committed, unpushed work which produces a clean status but is reachable only
   from the local base branch. If the agent is currently on the authorized
   `issue-N/agent` branch while local `main` contains an unpushed commit,
   `checkout -B main origin/main` moves `main` backward and orphans that other
   branch's commit even though only issue-N work was authorized for discard.
   Before any reset/clean, fetch the remote base and require the local base ref
   to be absent, equal to, or an ancestor of `origin/<base>`; otherwise refuse
   without worktree mutation unless the owner explicitly selected the existing
   forced-wipe behavior.

## Conclusion

The three plans converge on the correct small architecture: one shared helper
in `prepareAgentBranch.ts`, the completed CLI teardown and wipe as callers, and
the existing protocol lift/restore machinery. They are not interchangeable as
written. Claude's per-clone continuation and local-base fallback violate the
batch safety and origin-base postconditions; Cursor omits completion-path
coverage and leaves destructive ordering unresolved; Cursor and Claude also
need a local-base history guard. Codex provides the most complete batch,
origin, test, and base-ref safeguards, but its ordering must be revised so UI is
detached before reset/clean. Implement only after incorporating these findings.

# Issue 172 plan review — Cursor

Reviewed bound plans:

- cursor `cde4a70b515558e80d32c422a85fd9e50529f1c4`
- codex `be4b37b973bb3420d44cbe41f7238d9c1c167a05`
- claude `3e67191cefbc89b732f7cf8c412b3b30e214bc5e`
- antigravity `d298175f625de94aeedd41a1d86c1f95d5cea268`

## Findings

1. **Antigravity — Exact File List / `.pnpm-store/` (and Conclusion “all items”)**  
   **Claim:** Adding `.pnpm-store/` only to the repository `.gitignore` (file list omits `src/productIgnore.ts`) addresses Codex workspace-store dirt; Conclusion says the plan addresses all issue items.  
   **Rule:** Clone dirt that blocks `prepareAgentIssueBranches` is evaluated inside each agent clone; ordinary installs put coordination ignores in the clone’s managed exclude via `DEFAULT_CLONE_IGNORES` (`src/productIgnore.ts` → setup/install), not only the coordination product’s root `.gitignore`. A plan that claims to fix issue-172 clone refusals must change that per-clone ignore source (and list every path it will change).  
   **Failure if followed:** After merge, agent clones still see an untracked `.pnpm-store/` as blocking dirt; `coord N` after a sandboxed Codex run keeps refusing with the same uncommitted-changes error the issue reports. Status banners, onboarded `--coord-runtime` inference, all-agents nudge, and tmux/pane placement checks are also absent from the file map while the Conclusion asserts full coverage, so those issue bullets stay unfixed.  
   **Correction:** Add `.pnpm-store/` to `DEFAULT_CLONE_IGNORES` (and keep root `.gitignore` if desired); extend the file map and tests for status, runtime inference, nudge-all, and placement diagnostics, or drop the “all items” claim.

2. **Cursor — Exact File List / `src/cli.ts` auto-cleanup of leftover manual sessions**  
   **Claim:** When starting `coord N`, if a leftover manual tmux session exists, detach it and base-ready clones “instead of forcing a separate `coord detach manual`,” with no owner confirmation step.  
   **Rule:** The issue’s terminal/leftover bullet asks coord to detect leftovers and **ask the owner** whether to clean up first; destroying a live manual UI without confirmation is unsafe when harnesses may still be doing owner work.  
   **Failure if followed:** An owner who still has agents open under `coord manual` and starts `coord N` loses those panes (and may hit base-ready side effects) with no chance to refuse; the implementation “solves” detach friction by violating the ask-before-cleanup requirement.  
   **Correction:** Gate teardown on an explicit owner confirmation (Claude) or on inspected idle/dead panes only (Codex); keep today’s hard refuse when evidence is uncertain or stdin is non-TTY.

3. **Cursor — Exact File List / `coord nudge` CLI**  
   **Claim:** Add `coord nudge [--agent|--all]` that reuses `CoordinatorRunLoop.reminders()` / nudge delivery.  
   **Rule:** Reminder delivery is owned by the foreground run loop’s readiness, send budget, and hold gates; a separate CLI process cannot call `reminders()` on a live loop without a new cross-process channel, which the plan does not specify and which exceeds “thin wrapper” reuse.  
   **Failure if followed:** Either the command no-ops / errors whenever the coordinator is not in-process (does not meet “nudge again”), or implementation invents a second delivery path that bypasses or races the existing budget/hold logic—the failure mode Claude’s Alternatives Rejected already names.  
   **Correction:** Limit the nudge work to the interactive `n` “All agents” row on the existing reminder closures (Claude/Codex); drop the standalone CLI verb unless a scope amendment defines durable IPC into the running loop.

4. **Codex — Reuse and Scope / status separation**  
   **Claim:** Baseline `----` framing in `renderIssueReport` already satisfies the status start/stop request; keep it and do not change formatting.  
   **Rule:** Issue text asks for clear separation so owners know where the status report starts and stops; the issue was filed against the current product, which already emits `----`, so treating the baseline as complete does not meet the written requirement.  
   **Failure if followed:** Status output stays the same thin delimiter owners already find ambiguous amid interactive prompt and log noise; item 1 remains unresolved after an otherwise large manual-lifecycle change.  
   **Correction:** Adopt labeled begin/end banners (Claude/Cursor) while keeping a single renderer and updating `test/issueReport.test.ts`.

5. **Claude — Exact File List / shim-only stale binding (no branch match)**  
   **Claim:** Stale automation is recognized when `COORD_MANUAL=1`, or when the issue runtime directory is missing, or when top-level `cursors.json` is `completed`/`abandoned`; `guardShellRequest` needs no TypeScript change because it already asks the shim.  
   **Rule:** Inherited `COORD_ISSUE` must not be sufficient evidence of an automated session; owner-directed work on a non-issue branch (or with a mismatched session) must not be classified as automated while a live incomplete issue directory still exists—the failure mode the issue defers from #162. Positive binding should require evidence comparable to `hookVerificationRecorder` (issue branch + roster/root), not only “issue dir still open.”  
   **Failure if followed:** An owner (or agent) on `<agent>/<scratch>` or another non-`issue-N/<agent>` HEAD with a leftover `COORD_ISSUE=N` while issue N is still incomplete keeps hitting automated git denials; the guard still treats the inherited number plus a living runtime as enough.  
   **Correction:** Keep `COORD_MANUAL` and completed/abandoned short-circuits, and also require a matching prepared issue branch (and/or validated vendor session) before applying restrictions—as Codex/Cursor describe—whether that logic lives in the shim, shared resolver, or both.

## Conclusion

Antigravity is not implementable as a complete answer to issue 172: it misses the per-clone `.pnpm-store/` ignore source and several issue bullets its Conclusion claims to cover. Cursor’s map is broad and reusable but unsafe on silent manual auto-detach and over-claims a `coord nudge` CLI that cannot reuse the in-process reminder path without new IPC. Codex is the strongest lifecycle and safety design (non-discarding manual readiness, inspect-before-reconcile, shared binding resolver) but incorrectly closes the status-framing item as already done. Claude is the most concrete small-diff map and correctly gates cleanup on confirmation and avoids a second nudge channel, but its staleness predicate is too weak while a live issue directory remains. Prefer a synthesis: Claude’s confirmation + manual base-ready extraction + labeled status frame + `.pnpm-store/` ignores; Codex’s branch/session-positive binding and inspect-before-kill rules; Cursor/Claude runtime inference from onboarded worktrees; interactive all-agents `n` only—not Cursor’s silent auto-detach or standalone nudge CLI, and not Antigravity’s truncated file map.

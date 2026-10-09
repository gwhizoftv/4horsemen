# Issue 172 implementation comparison — Cursor

Bound implementation pins compared:

- cursor `abb2cf2b4afdcf38c67bec77a556385c282410e3`
- claude `38d0460c436ade9a8fb7bdba6070ae923e2d1d80`
- codex `e62ba296c26b0602dbefb300604e83a057e200d6`
- antigravity `7427ebfca2a4969916aabf54d698146a49d4b2c9`

All four stay inside the approved product map (plus coordination artifacts). Codex `--no-daemon` is unchanged baseline everywhere. No product suite was re-run for this evidence-only comparison; findings below are from reading the bound worktrees.

## Comparison

### Summary by pin

| Pin | Status frame | Shim stale / nested | Detach order | Placement empty path | Interactive All + tests |
| --- | --- | --- | --- | --- | --- |
| claude `38d0460c` | labeled `====` | dual-root (workspace + outer); top-level completed/abandoned | dry-run readiness then kill | empty = unknown OK | yes + tests |
| cursor `abb2cf2b` | labeled `====` | workspace-only root | dry-run readiness then kill | empty = unknown OK | yes + tests |
| codex `e62ba296` | labeled `====` | nested-safe stale keep-refuse | inspect then kill via callback | empty → WARN | yes + tests |
| antigravity `7427ebfc` | labeled in source | nested returns outer only; loose grep | **kill then readiness** | OK path | source yes; **tests stale / omitted** |

**Prefer claude `38d0460c436ade9a8fb7bdba6070ae923e2d1d80`:** closest end-to-end match to the selected plan (confirm, preflight-before-teardown, dual-root stale check, empty `pane_start_path` handling, full issueReport/interactive test updates). Codex is the strongest nested-containment alternative if Claude’s bound-files `tail -n 1` outer preference needs a later fix. Cursor is close but can miss a live issue that exists only under a legacy outer nested root. Antigravity should not be selected.

### Findings

1. **antigravity `7427ebfc` — `src/cli.ts:724` / `:748`**  
   `detachManual` calls `detachIssue` and only then `makeManualClonesBaseReady`.  
   **Rule:** unpublished or dirty manual work must be refused without destroying the live manual UI.  
   **Failure:** an owner with dirty or unpushed clones loses tmux/Terminal panes, then receives a readiness refusal and cannot continue the session they still needed.  
   **Test:** dirty clone + `coord detach manual` → exit 1 and the manual session still present (or dry-run shows no kill when readiness would refuse).

2. **antigravity `7427ebfc` — `scripts/lib/launcher.sh:199–208` / `:211`**  
   Nested `coord_runtime_root` returns only the outer coord root; stale match uses a loose `"(completed|abandoned)".*:.*true` grep.  
   **Rule:** current nested issue state lives at the workspace root beside `config.json`; staleness must use top-level completed/abandoned and must not treat a live nested issue as absent.  
   **Failure:** live `workspaces/<project>/issue-N` with incomplete cursors → outer path missing → shim delegates and automated `git status`/`diff` run mid-issue; or a nested JSON true falsely marks the issue stale.  
   **Test:** nested fixture with issue only under the workspace directory must deny `git status` while `completed: false`.

3. **antigravity `7427ebfc` — `test/issueReport.test.ts:212–214` (and omitted interactive test updates)**  
   Assertions still expect bare `----` while `src/issueReport.ts` emits `==== coord status… ====`; the pin’s changed-path list omits `test/issueReport.test.ts` and `test/interactive.test.ts`.  
   **Rule:** tests that assert framing/reminders must match the shipped strings, and required regressions must be in the commit.  
   **Failure:** `pnpm test:fast` fails on issueReport framing, and “All agents” has no failing-before/pass-after coverage on this pin.

4. **cursor `abb2cf2b` — `scripts/lib/launcher.sh:202–217`**  
   `coord_runtime_root` returns only `dirname(coord.workspaceConfig)` (workspace root).  
   **Rule:** nested/legacy layouts may keep a live `issue-N` under the outer coord root; absence at the workspace path alone is not proof of staleness.  
   **Failure:** outer-only live incomplete issue → shim treats the binding as missing and delegates, disarming containment.  
   **Test:** nested config + only `coordRoot/issue-N` with `completed: false` must still deny `git status`.

5. **codex `e62ba296` — `src/tmux.ts:859`**  
   `!startPath` is folded into the same WARN as a dead/missing pane.  
   **Rule:** an empty `#{pane_start_path}` means the format is unavailable (older tmux), not a placement mismatch.  
   **Failure:** healthy panes on tmux without the format always get “placement unavailable” noise.  
   **Test:** fake display `0\t` → expect non-WARN / unknown handling, not WARN.

6. **claude `38d0460c` — `scripts/lib/launcher.sh:244` (non-blocking relative to peers)**  
   Bound-input `coord_action_lists_files` takes `coord_runtime_roots | tail -n 1` (outer when nested).  
   **Rule:** actions for product-resolved nested starts live under the workspace root.  
   **Failure:** pinned `git show` may fail-open (allow) when Bound input files exist only under the workspace issue tree — weaker than ideal, but does not disarm status/diff the way antigravity/cursor nested gaps can. Prefer Claude overall; optionally adopt Codex’s nested split for bound-files later.

### Scope and reuse

- **claude / cursor / codex:** reuse `detachIssue`, readiness helpers, interactive reminder closures, and existing test files; no new production modules.  
- **antigravity:** adds a rejected `coord manual --done` alias surface and still fails the kill-before-readiness and nested-shim contracts.  
- Focused coverage is strongest on claude/cursor/codex; antigravity’s missing interactive/issueReport test updates leave regressions uncaught.

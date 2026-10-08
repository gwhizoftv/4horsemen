# Issue 181: Idle agents still block the next nudge

## Goal

When an agent has finished a turn (COORD-IDLE visible and/or a valid `ready`
file) but lifecycle hooks still say `working` / `unknown`, the coordinator must
deliver the next never-sent action without the owner typing `continue`. Scrape
vetoes for live turns, non-empty drafts, dialogs, and process mismatch stay in
force.

## Exact File List to be changed or deleted

- `src/tmux.ts` — treat Codex post-turn timing chrome (`Worked for …`) as
  allowlisted between the idle sentinel and the composer; treat a wrapped dim
  placeholder as an empty composer (not `codex-composer-not-ready`); for
  Antigravity (and Claude, if the same last-line rule is shared), count
  COORD-IDLE as idle proof when it sits above the idle vendor prompt chrome
  rather than only when it is the absolute last non-blank line; keep turn-chrome,
  verify-overlay, trust-dialog, and non-empty draft vetoes
- `src/runLoop.ts` — before the first send, treat lifecycle `unknown` like
  stale `working`: do not lifecycle-defer a never-sent ordered action when file
  or terminal idle proof can still be attempted in `deliver()` (same
  `neverSentWorking` gate, extended; keep post-injection duplicate protection)
- `docs/readiness-policy.md` — document allowlisted Codex post-turn chrome,
  wrapped empty-composer rules, Antigravity/Claude sentinel-above-prompt, and
  never-sent `unknown` parity with stale `working`
- `test/tmux.test.ts` — fixtures and assertions for the scrape/sentinel/composer
  cases above
- `test/runLoop.test.ts` — never-sent `unknown` reaches deliver with ready-file
  or idle-sentinel proof; Antigravity stale-working + COORD-IDLE above `>` sends

## Exact file list to be created

- `.plans/issue-181/plan.md` — this plan

## Reuse and Scope

Reuse existing helpers and call sites; do not add new modules or dependencies.

- `COORD_IDLE_SENTINEL`, `codexTail` / `codexSentinelAtTail` / `codexComposerEmpty`,
  `harnessPromptReadiness`, `IdleOverride`, and `TmuxController.nudge` in
  `src/tmux.ts`
- `readyForNextAction`, `deliver`, `maybeLifecycleNudge`, and the existing
  `neverSentWorking` / `fileReady` branch in `src/runLoop.ts`
- Ready-file helpers (`readReady` / `clearReady`) and lifecycle observers already
  covered by `test/runLoop.test.ts` and `test/agentLifecycle.test.ts`
- Extend `codexPane` / readiness cases in `test/tmux.test.ts` and the stale-working
  override cases in `test/runLoop.test.ts` rather than new test files

Out of scope: installing or fabricating Codex Stop hooks; changing nudge key
sequences; relaxing scrape vetoes for live `Working (… esc to interrupt)` /
`esc to cancel`; post-injection resend without lost-delivery proof; interactive
CLI copy from issue 161.

## Tests

Focused cases that fail on current main and pass after the change (join existing
files; hook still owns `pnpm check:fast` on product commits):

1. `test/tmux.test.ts` — Codex pane with `• COORD-IDLE` then `Worked for 6m 15s • 4:10 AM`
   then empty dim composer + known footer → `idle-sentinel` ready; same pane with
   an undimmed draft still refuses
2. `test/tmux.test.ts` — wrapped dim Codex placeholder across two composer lines
   still counts as empty for ready-file sends; undimmed wrap still refuses
3. `test/tmux.test.ts` — Antigravity pane ending in `COORD-IDLE` / `>` /
   shortcuts (not COORD-IDLE alone) yields `idle-sentinel` when no turn chrome
4. `test/runLoop.test.ts` — never-sent action with lifecycle `unknown` + valid
   ready file delivers (`readiness: "ready-file"`); without proof still waits
5. `test/runLoop.test.ts` — Antigravity lifecycle `working`, no ready file, pane
   shows COORD-IDLE above `>` → first send via `idle-sentinel` override; second
   tick does not duplicate

While developing, run the focused suites above. Do not claim coordinator-owned
pin checks.

## Alternatives Rejected

- Owner `continue` / manual paste as the fix — the issue is automatic delivery
  after agents are already idle
- Treat any visible COORD-IDLE as authorization without composer/prompt structure —
  would type into drafts, dialogs, or in-flight turns; scrape remains a veto
- Fabricate Codex Stop / SessionStart when hooks are missing — lies about
  observability; ready-file + scrape proof is the supported path
- Disable Antigravity PreInvocation/PostInvocation entirely — loses real mid-turn
  signal; fix the sentinel/ready delivery path instead
- Broad footer regex guessing for every new Codex status token — prefer explicit
  allowlists for known post-turn chrome and empty wrapped placeholders

## Risks and Mitigations

- Allowlisting `Worked for …` could hide a real transcript line — anchor it like
  other chrome (line shape / position relative to sentinel and `›`), and keep
  undimmed composer drafts as a hard veto
- Treating wrapped dim text as empty could miss an undimmed draft on wrap two —
  require every composer line to be dim-empty; any undimmed visible character fails
  closed
- Sentinel-above-prompt for Antigravity must not beat `esc to cancel` / verify
  overlay — those checks stay first in `harnessPromptReadiness`
- Extending never-sent override to `unknown` must not reopen post-injection
  duplicates — keep `injectedAt === null` / `delivery === "ordered"` and existing
  per-key lifecycle revalidation

## Conclusion

Issue 181 is scrape/lifecycle idle proof failing after a finished turn: Codex
post-turn and wrapped-placeholder parsing reports `codex-composer-not-ready`,
Antigravity’s last-line sentinel cannot see COORD-IDLE above its prompt while
hooks still say `working`, and never-sent `unknown` is deferred before deliver
can use file/terminal proof. Fix those three proof paths in `tmux.ts` /
`runLoop.ts`, document them, and cover them with focused tests so the next action
sends without owner intervention while live-turn vetoes remain.

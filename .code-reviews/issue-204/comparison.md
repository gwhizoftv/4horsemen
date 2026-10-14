## Comparison

Protocol version: 1. Review for action `2053bab4-bf9b-4d3b-8756-12af2b819134`, using the coordinator's exported worktrees and frozen issue 204 requirements.

| Agent | Bound product pin | Assessment |
| --- | --- | --- |
| Claude | `f5b1085136ab54505b4c63a4aca8a7a96f4bee67` | Revise: accepted-action reminders and an older-tmux test regression. |
| Codex | `ce71b24b540206d01c0c035d692bab85c846057d` | Preferred; no blocking finding identified in this comparison. |
| Cursor | `b32cccf1d91eedf8f48cb834586070f06b25fe21` | Revise: linked-session scope and accepted-action reminders. |

### Findings

1. **Cursor — `src/tmux.ts:1114` [P2].** Scrolling repair must target the exact coord-owned linked session and leave unrelated sessions unchanged. `has-session -t client` accepts tmux's unique-prefix match; `applySessionScroll(client)` then uses that same non-exact target. When `coord-1-claude` is absent but `coord-1-claude-personal` exists, resuming issue 1 changes the personal session's mouse and history options. The installed tmux manual explicitly documents this prefix lookup and the `=` exact-match form. A focused injected-runner test representing those sessions reproduced the extra settings command in Cursor; Claude's exact-name list filter and Codex's `=client` existence check passed the same case. Extend the existing repair test with a missing exact client and a uniquely prefixed personal session, asserting no settings are applied to that client target.

2. **Claude — `src/runLoop.ts:1992`; Cursor — `src/runLoop.ts:1973` and `src/runLoop.ts:2103` [P2].** The selected plan requires a current action's scrollback delivery-wait notice to be suppressed after that action is acknowledged; both candidates' status renderers already suppress a matching accepted action. The logging paths do not enforce that lifecycle condition. Starting with a copy-mode refusal, acknowledging the action through `prompt-submitted`, and subsequently observing Stop while the pane remains scrolled causes both implementations to recreate the notice immediately and repeat it three minutes later. Lifecycle delivery remains `accepted`, no keys are sent, and status suppresses the notice, so the console and status disagree about whether this is a current delivery wait. I reproduced three notices in each candidate versus the single initial notice in Codex. The smallest regression extends `safetyFixture`: set `ui.busy = true`; tick; advance 1 ms, call `working()`, tick; advance 1 ms, call `stop()`, tick; advance 180,000 ms, tick. Assert one scrollback notice and no current wait for that accepted action. Preserve the existing nudge/readiness gates while applying the lifecycle condition to notice creation and repetition.

3. **Claude — `test/tmux.test.ts:1353` [P2].** The declared older-tmux fallback must remain usable with mandatory verification, including when tmux is installed but does not support `pane-scrollbars`. This real-server test unconditionally expects the option to return `on`, and line 1355 also requires its global value to be `off`; its only skip condition checks whether tmux is installed. On a version without that optional option, `show-options` cannot return those values, so `pnpm run check:fast` fails even though the product's quiet setter correctly tolerates the missing capability. Make the scrollbar assertions conditional on actual option support, retaining the mandatory mouse/history and unrelated-session assertions. This finding is from inspection; I did not run an older tmux binary.

### Scope, reuse, and coverage

All three pins restrict product changes to the same ten approved paths. Each reuses the existing session creation/repair, linked-client attachment, shared launcher template, action-safety schema, delivery refusal journal, shared report, and existing test files. None introduces a product file, dependency, custom wheel binding, or global option mutation. They preserve copy-mode input refusal and set history before creating new agent windows. All keep the optional scrollbar setter quiet without suppressing required history/mouse failures.

Claude has compact option builders and repairs existing linked clients through an exact-name list. Its formatter is duplicated between the refusal wording and report. Cursor adds separate due/eligibility/repetition/announcement methods and exports option helpers/constants that have no consumers outside `src/tmux.ts`; this is more structure than the issue needs. Codex shares its message and current-wait predicate between the loop and report, checks linked-client identity exactly, and covers completion, action replacement, accepted work, failed observations, and unchanged cursor bytes before the reminder deadline.

There is a scope difference to record: Codex enables window scrollbars only for Claude/Cursor, and linked-client mouse support for Claude/Cursor/Codex; Claude and Cursor apply both options to every agent. Codex is narrower than the selected plan's all-agent scrollbar sentence, but matches the frozen issue's named-agent requirements and avoids changing other harnesses' client behavior. I consider that acceptable issue scope rather than a blocking defect. All three launch Codex with `--no-alt-screen` while retaining its existing grants and flags.

### Verification evidence

I read `coord-runtime/issue-204/journal.jsonl` and checked each bound commit's tree identity against the successful precommit measurement. These are recorded advisory hook observations, not coordinator-owned candidate/final suite results, and I did not rerun those suites for this review.

| Agent | Product tree matched to successful `pnpm run check:fast` | Successful `pnpm run test:e2e` |
| --- | --- | --- |
| Claude | `80c3a68299ed525206ab815390ba04b850ddf98d`, journal sequence 307 | Sequence 311, outgoing range ending at signal commit `80eb75a42662d0eb83bfd5dd9db2d14c17e0a779` |
| Codex | `61892e72f35a411ccb470bc753ec9d853264966d`, sequence 397 | Sequence 406, outgoing range ending at signal commit `b53d09f28a23f2b2a4e85fe8b24aad54bf93bbac` |
| Cursor | `78771cde064315fe5632a30239cea096ee7e2d93`, sequence 526 | Sequence 531, outgoing range ending at signal commit `6d7c1f5747c17037c7b31e1c9416c9db0c4ae4a4` |

Codex's earlier failed precommit measurement at sequence 345 belongs to a different tree; the bound tree has the later successful measurement above. No coordinator final-check result is claimed.

For the two investigated behavior findings I ran a temporary Vitest harness importing each exact bound worktree, reusing the existing `fixture`/`safetyFixture` setup. The accepted-action case failed for Claude and Cursor and passed for Codex. The linked-session target case failed for Cursor and passed for Claude and Codex. The latter used an injected runner with tmux's documented prefix resolution, not a live personal session. Only those focused cases were executed during this review; no pinned source or test file was edited.

### Recommendation

Select Codex `ce71b24b540206d01c0c035d692bab85c846057d`. It satisfies the issue with the strongest current-wait lifecycle handling and passes both additional regression scenarios. Claude is the next-best basis after correcting its two findings. Cursor additionally needs exact linked-session targeting before its repair path respects the issue's session boundary.

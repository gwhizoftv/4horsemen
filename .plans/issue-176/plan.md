# Codex implementation plan — issue 176, including issue 174

The requested outcome is that a completed Codex action does not leave the next action permanently blocked by an old working observation, and that a new coordinator launch does not inherit an unrelated shared app-server's issue environment. Include the missing-nudge, bounded-reread, and CLI/server mismatch reports from [issue 174](https://github.com/gwhizoftv/coordination/issues/174) as requested by the owner, alongside [issue 176](https://github.com/gwhizoftv/coordination/issues/176).

## Exact File List to be changed or deleted

Change only these existing product, test, and documentation files; delete none:

| File | Change |
| --- | --- |
| `scripts/lib/launcher.sh` | Launch Codex without the shared daemon, preserving existing sandbox and per-issue grants. |
| `src/agentLifecycle.ts` | Retain a small, default-null record of a correlated accepted completion across the next action order; invalidate it on subsequent activity/session changes. |
| `src/runLoop.ts` | Permit only a never-sent next Codex action to pass an otherwise stale working veto under the completion and fresh-prompt conditions below; report refusals through existing diagnostics. |
| `src/tmux.ts` | Add explicit Codex busy/dialog/unknown-prompt vetoes and a strict positive idle-prompt check; apply it again at send boundaries. |
| `src/issueReport.ts` | Explain completion/lifecycle disagreement and the supported hook-trust and launcher recovery steps without asserting that silence proves a failed hook. |
| `src/action.ts` | Render the same bounded post-completion reread instructions for Git and response actions. |
| `templates/product/AGENTS.protocol.md` | Match the rendered instructions and preserve the final idle sentinel. |
| `docs/coord-driver.md` | Document isolated Codex launch, existing-session migration, hook review, and version compatibility checks. |
| `docs/readiness-policy.md` | Specify the narrow first-delivery exception, its evidence and vetoes, and the unchanged duplicate/hold rules. |
| `test/install.test.ts` | Extend the existing generated-launcher execution test for the Codex argument, environment, grants, and unsupported-CLI failure. |
| `test/agentLifecycle.test.ts` | Cover completion record creation, preservation, invalidation, and old-state defaults. |
| `test/runLoop.test.ts` | Reproduce accepted completion with no Stop, safe next delivery, and the negative/race cases below. |
| `test/tmux.test.ts` | Cover Codex idle, active-turn, hook-review, server-mismatch, capture-failure, and mid-send UI cases. |
| `test/issueReport.test.ts` | Verify evidence-based recovery text and absence of false health/acceptance claims. |
| `test/action.test.ts` | Check bounded reread wording in both submission modes and the shipped protocol. |

## Exact file list to be created

No new product files, dependencies, fixture files, or services. Extend existing tests with small inline terminal captures. The plan itself is the required coordination artifact, not a new product module.

## Reuse and Scope

### Evidence and limits

The inspected baseline is 6fba7643f3cd7b8dd758c13f3ae2371c0936d75e. `CoordinatorRunLoop.deliver` returns immediately on lifecycle `working`; `maybeLifecycleNudge` also consults `decideLifecycleNudge` before terminal readiness can matter. `orderAgentAction` replaces action identity but preserves execution, and `markActionWorkflowComplete` marks workflow completion without declaring the turn idle. This correctly separates completion from activity, but there is no narrowly scoped path past a prior completed turn's missing Stop.

`harnessPromptReadiness` currently returns ready for every Codex capture after the common trust check. Therefore merely moving the working check behind the existing scraper would be unsafe. `agent-event` already emits valid empty JSON for Codex Stop and normalizes session/turn identity. Installing its definition does not prove that the runtime loaded or executed it.

Local `codex --version` returned codex-cli 0.160.1. Its actual `codex --help` describes `--no-daemon` as running without the shared background server even when one is running. The generated launcher presently omits it. This is a concrete way to avoid daemon reuse; the cause of the originally missing Stop has not been proven. Do not describe daemon reuse, trust, or handler failure as an established historical root cause.

The [official Hooks guide](https://learn.chatgpt.com/docs/hooks) says project configuration and individual non-managed hook definitions require trust, with `/hooks` as the review interface. Hook trust is tied to the definition hash. It also documents Stop continuation and says background hooks do not start a new turn. We will preserve the existing observational Stop response and normal hook trust instead of adding a second continuation mechanism. The documentation fetched for developer commands did not establish `--no-daemon`; that flag is supported here by the installed CLI's help, so retain the local compatibility check in validation.

The live issue-176 run exhibited a separate delivery-uncertain hold. At inspection the tmux session had Claude and Cursor windows but no Codex window. This is not proof of the original stale-working cause. Missing panes and uncertain sends must retain their existing holds.

### Implementation sequence

1. **Isolate the coordinator's Codex launch.** Extend `launcher_command` in the existing shared shell template to pass `--no-daemon` to Codex. Keep workspace-write, the existing approval policy, current directory, PATH shim, current issue environment, and narrow mailbox/response/input grants. Before launching, check the resolved CLI's help for that capability; if the CLI cannot advertise it or help fails, exit with an actionable version/upgrade message. Do not silently fall back to a shared daemon. Do not kill, restart, or reconfigure a shared server, change CODEX_HOME, change hook trust, or modify other agents' launch commands. Reuse `write_launcher` and its existing installer/post-merge consumers; generated launchers remain untracked.

2. **Remember accepted completion without fabricating idle.** Extend `agentLifecycleEntrySchema` with an optional/default-null completed-turn record containing the completed action ID/digest, acceptance time, and its observed session/turn IDs. In `markActionWorkflowComplete`, populate it only when the completed action was accepted by a correlated prompt hook and its non-null session/turn still match the lifecycle entry. Preserve `execution`, `idleEpoch`, and actual hook event fields. Preserve the record when ordering a different action. Clear its eligibility on a subsequent valid prompt/working observation, session replacement/end, or positive queue/background activity, including an event with the same timestamp. Stale rejected callbacks must not revive it. Older lifecycle files parse with null and cannot gain recovery authority from an absent field.

3. **Use the record for a first send only.** Add a small shared predicate in the lifecycle module, reused by both `deliver` and `maybeLifecycleNudge`, for a new Codex action that is still ordered, has no injected/accepted identity, has zero reserved or completed send attempts, and differs from the completed action. Require the completed-turn session/turn still to match the stale working entry, no subsequent activity, a genuinely accepted previous workflow completion, and no pending/background work. The ordered action must postdate that completion. Never use this exception for an already injected/accepted action, same-action reissue, missing completion, failed checks, manual pause, active hold, or another vendor. Response actions use the existing accepted-response completion path; normal workflow ordering still requires the appropriate published ballot batch before issuing a successor.

   The predicate only allows proceeding to terminal validation; it never authorizes keystrokes alone and never rewrites lifecycle as idle/healthy. Reuse existing action safety, four-send budget, authority checks, reservations, and journal deferral machinery. An initial stale-working refusal should be journaled just as an idle retry refusal is, so the owner can see the blocker. Journal an actual recovery send with previous completed action and current action identity; do not journal a fabricated Stop. On restart, the durable send count/reservation prevents repeating the first-send exception.

4. **Require positive, current Codex prompt evidence.** Extend the existing `PromptBlockedReason` union and Codex branch of `harnessPromptReadiness`. An empty/unavailable capture, splash, permission/trust/hook-review prompt, app-server version-mismatch/continue-without-server dialog, or active-turn chrome must refuse delivery, even if an idle sentinel appears in scrollback. Require a recognizable empty Codex input prompt in the active tail, with the corresponding idle chrome, rather than arbitrary prose or a bare process name. Match actual supported CLI renderings; quoted documentation and old scrollback must not count as live chrome. Use existing ANSI stripping and anchored status helpers. A bare sentinel cannot establish this strict Codex readiness or cure a missing prompt. Unsupported UI remains unknown and blocks.

   Recheck pane/input/foreground and Codex readiness before the first keystroke and subsequent sends, and recheck the lifecycle/completed-turn eligibility snapshot after awaits. If a new prompt or working callback arrives before reservation, stop without charging a send. If authority or UI becomes uncertain after any key, retain the existing reserved-send uncertainty behavior; do not reset a budget or retry automatically. Treat a nonzero capture result as unavailable, not an empty successful capture. Keep other vendors' existing behaviors intact.

5. **Close the short publication race and give specific diagnostics.** Both action renderers and the shipped protocol should say: reread immediately after writing completion; if unchanged, wait one second and reread, then wait one more second and reread once more; execute a changed action immediately; otherwise finish with the exact existing idle sentinel. A briefly missing action during coordinator replacement gets the same bounded retry, not an error or endless loop. This applies to Git and response mode and does not authorize a Git commit for a response ballot. The rereads happen before the final reply; agents cannot watch files after their turn has ended.

   In the issue report, show relevant last-event/session/turn facts and a conditional explanation when a successor is waiting on a completed turn's working observation. Recommend checking `/hooks` for enabled/trusted definitions and the current clone, then relaunching through the updated isolated launcher when the CLI is idle. Describe recorded handler errors separately from lack of recorded events. Plain inactivity does not create a failure diagnosis. For old shared sessions or mismatched versions, require owner migration to the new launcher after preserving work; a supported fresh launch avoids disrupting unrelated server users. Existing delivery holds require their existing scoped owner recovery.

### Existing code and fixtures to reuse

Reuse `markActionWorkflowComplete`, `orderAgentAction`, `applyLifecycleObservation`, `decideLifecycleNudge`, `agentLifecycleEntrySchema`, `CoordinatorRunLoop.deliver`, `maybeLifecycleNudge`, `journalDeferral`, and the existing completion/response acceptance call sites. Reuse `harnessPromptReadiness`, `inFlightStatusLine`, `stripAnsi`, `TmuxController.nudge`, `injectionGate`, and `capturePane`. Extend `renderIssueReport`, `renderGitAction`, and `renderResponseAction` without adding a new scheduler or transport.

Tests should reuse `safetyFixture`, the fake clock and scripted `TmuxController` runner, the lifecycle fixtures, and the real generated-launcher/stub-harness test in `test/install.test.ts`. Reuse the existing action and report fixtures. No new abstraction, package, runtime command, transcript parser, daemon controller, or schema version migration is needed. This action publishes only the plan; implementation requires the later coordinator action.

## Tests

The following are proposed implementation checks, not tests already run for this plan.

1. Extend `test/install.test.ts` so the executable generated launcher passes the supported no-daemon flag plus unchanged grants and issue environment to the stub. Include absent flag/help failure and manual mode. It must not issue daemon-stop/kill commands or widen permissions.
2. Extend `test/agentLifecycle.test.ts` with one table-driven lifecycle sequence: accepted prompt, validated completion, new order, retained completed-turn record, and disqualifying new activity/session/queue cases. Include legacy JSON with no new field and completion without a correlated session/turn.
3. Extend `test/runLoop.test.ts` with the regression: accepted prior action completes, no Stop arrives, the next never-sent action is ordered, and a strictly idle Codex pane permits exactly one delivery while the hook-derived execution stays working until a real event changes it. Repeat with a new run-loop instance and ensure no duplicate. Cover both Git completion and an accepted response whose successor is issued through normal batch publication. Add table cases for busy or unrecognized pane, unaccepted completion, already-sent/current action, active hold/manual pause, newer activity, and positive pending/background state. Add a scripted callback between capture and reservation to prove the race closes without sending. Retain existing quiet-work/no-timeout-retry tests.
4. Extend `test/tmux.test.ts` with sanitized supported idle and working captures, server mismatch and hook-review dialogs, stale/quoted sentinel, nonzero/throwing capture, and a busy transition after a prelude. Assert no unsafe submit and the expected reason/stage; update only existing Codex fixtures that had modeled readiness as arbitrary or empty text.
5. Extend `test/issueReport.test.ts` and `test/action.test.ts` for the specific recovery explanation, no invented health evidence, and the exact finite reread contract shared by both modes and the protocol.

Run the focused existing tiers during implementation:

- `pnpm exec vitest run --config vitest.config.ts test/agentLifecycle.test.ts test/runLoop.test.ts test/tmux.test.ts test/issueReport.test.ts test/action.test.ts`
- `pnpm exec vitest run --config vitest.system.config.ts test/install.test.ts`

The product commit hook owns `pnpm check:fast`; do not immediately duplicate it manually before committing. The frozen issue configuration declares final `pnpm run check`, which includes build, fast/system tests, and e2e and belongs to the coordinator at the approved product pin. No version bump is planned.

Before declaring real-harness support verified, run an owner-supervised canary with the supported CLI: record its version/help; launch from the correct clone with current issue grants using the new launcher; inspect `/hooks` and verify a genuine SessionStart, prompt-submit, and Stop reaches the current issue. Validate two consecutive coordinator actions. Exercise a missing-Stop fixture separately for recovery, and inspect both idle and active real pane captures before accepting the scraper. Verify the new launch does not attach to or terminate an unrelated shared daemon. This canary has not been performed here; the current tmux run has no Codex pane.

For this plan submission, validate required nonempty sections, exact extracted file map, existing paths, and the current action identity. Product suites are unnecessary for evidence-only publication.

## Alternatives Rejected

- Clearing working on completion would confuse a valid artifact with an ended turn and could inject while the agent is still checking the next action.
- Treating an idle sentinel or elapsed time alone as idle would accept stale text or quiet ongoing work. The proposed exception requires correlated accepted completion, a never-sent successor, and fresh strict prompt evidence.
- Broad duplicate retries would discard the existing acceptance, queue, reservation, and hold protections. The exception is first delivery only.
- A Stop hook that repeatedly blocks stopping would add a competing delivery path and would not repair a hook that never runs. Two finite rereads plus normal coordinator delivery address the publication window.
- Killing a shared app-server or silently bypassing hook trust would affect unrelated sessions or change security policy. Use the CLI's supported isolated launch instead.
- A new app-server client, persistent polling service, or transcript parser is unnecessary for this issue and increases version coupling.

## Risks and Mitigations

The original missing-Stop cause remains uncertain. Keep findings and hypotheses separate, and require the real-harness canary before claiming runtime hook coverage. The launch change prevents a known class of shared-process reuse but does not manufacture trust or callbacks.

Terminal UI varies by Codex version. Use positive supported captures, explicit busy/dialog vetoes, unavailable-capture refusal, and rechecks at send boundaries. Unknown renderings should yield an actionable refusal rather than speculative input. Never use this exception to interrupt current activity.

Completion and lifecycle events can race. Preserve the correlated completion record separately from hook state, invalidate it on subsequent real activity regardless of timestamp equality, and revalidate after awaits. Retain reservations and holds for uncertain partial sends. Old files default to no recovery permission.

The no-daemon flag is verified in local CLI 0.160.1, not every historic release. Capability checking fails clearly on unsupported installations. A missing or untrusted hook still requires review through the supported UI, and existing shared sessions need a controlled relaunch. Do not automatically trust hooks, alter installed hooks to satisfy checks, or restart another owner's server.

Two one-second rereads add a bounded delay and cannot replace future nudges. Document that limit and keep the idle line last. Neither the plan nor its implementation may auto-release safety holds based on completion or missing telemetry.

## Conclusion

Implement isolated Codex launch, preserve real lifecycle evidence, and allow only a safely observed first delivery after a correlated completed turn. Include the bounded rereads and specific diagnostics requested by issues 174 and 176. Publish and review this plan first; do not expand it into product changes during the current action.

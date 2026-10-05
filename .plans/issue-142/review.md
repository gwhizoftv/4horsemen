# Issue 142 peer plan review

Bound plans reviewed:

- cursor: `c7466372b4fe2f7f268df795e1ebff4018f16ba9`
- claude: `b284c84240aefef1f56b23153fec83697fe540d3`
- codex: `59c72ee1faaef063b17cbb1692379073b0e950b8`

Authority is GitHub issue #142 together with the owner-updated review comment on that issue (2026-10-05): prefer native shell-tool hooks for all four agents via existing `agentHookSync`, keep one Git policy in the shim, verify coverage through the harness shell tool (not a tmux pane / doctor / launcher), warn first for unverified agents, and treat hermetic `hook-verify` as a separate follow-up.

## Findings

### 1. Cursor plan — tmux pane probe measures the wrong process

**Plan claim:** Cursor Exact File List / Reuse (`src/tmux.ts`, `src/cli.ts`, `src/runLoop.ts`) adds a post-ready pane `command -v git` probe via `send-keys` / `capturePane`, and treats that result as proof the shim is active or inert for automated work.

**Rule:** Containment must be verified in the process that executes agent tool commands. The owner issue review states a launcher check, a separate tmux pane, a hook's own shell, or `coord doctor` spawning bash cannot prove the agent's execution environment; probes must run through the actual harness shell tool after initialization.

**Concrete failure:** Following the Cursor plan as written, Cursor's harness can still reorder PATH for tool invocations while the interactive pane shell that received `send-keys` still resolves `.coord/bin/git` (or the reverse). Start/refusal and `git-shim-inert` journal events then certify the wrong environment, so automated issues continue (or refuse) on a false reading.

**Smallest correction:** Drop pane injection. Drive resolution + refusal probes through the agent's ordinary shell tool (as Claude's R1.join / `containment-probe` and Codex's `probe-git` do), and bind results to session identity.

### 2. Cursor plan — omits the preferred four-vendor shell-tool guard

**Plan claim:** Cursor Conclusion and file list keep shim PATH prepend as the interception layer and add only file-level doctor/readiness, pane observation, protocol wording, and hermetic verify. No `src/agentHookSync.ts`, no `beforeShellExecution` / `PreToolUse` wiring, no shared guard module.

**Rule:** The owner-updated recommendation's preferred approach is a narrow shell-tool hook across Claude, Codex, Cursor, and Antigravity, reusing `src/agentHookSync.ts`, with the PATH shim retained as fallback—not PATH observation alone.

**Concrete failure:** Implementing Cursor's map leaves Cursor (and any other PATH-demoting harness) able to call `/usr/bin/git status` from the tool dispatcher with no pre-execution deny. The plan's own Alternatives Rejected section admits file-level checks cannot see reorder, yet the only live control it adds is the wrong-process probe in Finding 1. The issue's measured Cursor bypass remains unenforced.

**Smallest correction:** Adopt Claude's guard installation + single-policy check-mode design (or an equally small shared decision helper) before any refuse/warn layer.

### 3. Cursor plan — hard start refusal and in-scope hermetic verify exceed the approved rollout

**Plan claim:** Cursor refuses automated work on inert PATH (`src/cli.ts` / `src/runLoop.ts`) and includes `src/hookPolicy.ts` hermetic `COORD_GIT_DELEGATE` stripping in this issue.

**Rule:** For the smallest rollout the owner review allows a prominent warning for inactive/unverified agents; refusal is optional later once vendors are measured. The same review treats the `hookPolicy.ts:121` verification-environment leak as a separate small follow-up, not part of this change.

**Concrete failure:** Shipping Cursor as written can block every automated issue on a vendor hook/PATH gap before four-agent smoke evidence exists, and couples an unrelated verify-env fix into the containment feature set—exactly the coupling the issue review deferred.

**Smallest correction:** Match Claude: warn + journal + status/doctor visibility on join; defer hermetic `inheritRunner` env isolation to a follow-up issue/PR.

### 4. Codex plan — observability without the preferred enforcement layer

**Plan claim:** Codex Exact File List / Reuse implements `coord probe-git`, clone-local observation files, warning-first journal/status/doctor, protocol text, and hermetic verify. It explicitly keeps the launcher prepend as best-effort and does not add shell-tool hooks.

**Rule:** Same as Finding 2: preferred fix is pre-execution shell-tool guards for all four vendors with one shared policy; observation alone does not restore containment when PATH is demoted.

**Concrete failure:** A workspace that follows Codex can look healthy after a successful probe on one action while every subsequent `git status` from a demoted tool shell still bypasses the shim. Warnings name the agent, but redundant Git reads—the efficiency problem in the issue title—remain unblocked.

**Smallest correction:** Keep Codex's tool-shell probe locus and warning-first posture, but add the four-vendor guard + shim check-mode from Claude (do not substitute probes for denies).

### 5. Codex plan — folds hermetic verify into this issue and probes every action

**Plan claim:** Codex section 3 changes `inheritRunner` now; Tests / Risks call for one bounded probe per action (and on shell/session changes).

**Rule:** Owner review: hermetic `hook-verify` is a separate follow-up. Probes should repeat after restart/configuration changes, not before every action—extra tool use defeats the efficiency purpose of the issue.

**Concrete failure:** Implementing Codex couples an out-of-band verify-env fix into #142 and adds a tool round-trip on every action generation, increasing exactly the class of redundant tool use the issue aims to reduce, while still not denying Git reads (Finding 4).

**Smallest correction:** Remove `src/hookPolicy.ts` / `test/verify-config.test.ts` from this issue's map. Probe once per session (e.g. R1.join / resume), invalidate on session change, and let later actions read the stored observation.

### 6. Claude plan — hook-active coverage must not require a prior denial before the join probe can succeed

**Plan claim:** Claude `src/agentLifecycle.ts` / Tests: `containmentCoverage` marks `hook` as `active` only when a `hookDenial` was recorded for the same `sessionId` as the probe; R1.join runs `git status` then `coord containment-probe`.

**Rule:** Session coverage reporting must not create a false `hook=inactive` when the guard denied the join probe but evidence recording failed, or a false `hook=unverified` loop that blocks accurate status after a successful deny. Recording failures must not turn deny into allow (Claude states this), and coverage must treat the join probe's own expected denial as sufficient hook evidence when journaled.

**Concrete failure:** If `recordContainmentEvidence` fails after a correct deny, or if `containment-probe` runs in a context that does not see the denial record written by `git-guard`, `coord status` shows `hook=inactive` while the agent was actually denied—operators then chase a phantom PATH problem or, if a later revision hardens warnings into refusals, strand the agent despite working hooks.

**Smallest correction:** Define explicitly that the R1.join `git status` denial is the session's hook proof when `containment-guard-denied` (or `hookDenial`) is present for that session; make `containment-probe` read that record rather than requiring an independent second denial; tests must cover deny-recorded-but-probe-ordering and record-failure-still-deny.

### 7. Claude plan — AGY PreToolUse matcher-group edit must not break flat lifecycle sync

**Plan claim:** Claude Exact File List for `src/agentHookSync.ts` adds AGY `PreToolUse` with matcher `run_command` inside the existing managed named set `coord-agent-lifecycle`, noting matcher-group shape unlike flat lifecycle handlers.

**Rule:** Extending `plannedDocument` / inspect / remove must preserve today's flat AGY lifecycle events (`PreInvocation`, `PostInvocation`, `Stop` in `src/agentHookSync.ts`) and owner handlers; a second installer or a shape that makes `inspectAgentLifecycleHooks` report false drift is not allowed.

**Concrete failure:** If implementation shoves matcher-group `PreToolUse` through the flat `antigravityEvents` path, install can rewrite `.agents/hooks.json` into a shape AGY ignores or that uninstall cannot peel, leaving either no guard or destroyed lifecycle hooks—both invisible if doctor only checks for a substring.

**Smallest correction:** Keep the plan's stated split (matcher-group for PreToolUse, flat for lifecycle); add an `agentHookSync` test that round-trips an existing flat AGY document plus the new PreToolUse group and asserts inspect/remove leave owner entries intact.

## Conclusion

Claude's plan is the only one that matches the owner-updated recommendation: four-vendor shell-tool guards through existing `agentHookSync`, one shim policy via check mode, verification in the agent's real shell tool at R1.join, warning-first visibility, protocol alignment, and hermetic `hook-verify` deferred. Codex correctly rejects tmux/launcher probes and chooses warning-first tool-shell observation, but omits the preferred enforcement layer, over-probes, and incorrectly includes hermetic verify in #142. Cursor follows the issue body's earlier PATH-centric sketch: its pane probe is invalid evidence, it never installs shell guards, and it hard-refuses plus hermetic-fixes beyond the approved smallest rollout.

Accept Claude as the implementation base after addressing Findings 6–7 (join-probe hook evidence and AGY document-shape tests). Do not select Cursor or Codex unless rewritten to add the shared shell-tool guard and to drop wrong-process probes / in-scope hermetic verify / per-action probing.

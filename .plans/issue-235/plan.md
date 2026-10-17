# Issue 235: default Muse onboarding and automatic terminal delivery

Baseline: `2b36122912fb55327e9872646bee3a2c0b32f5ce`. This plan implements the outcome in the coordinator's `github-issue.json`: ordinary onboarding includes Muse, and Muse completes JOIN and subsequent Git and private-response actions through the existing complete/ready protocol without lifecycle callbacks. This action publishes a plan only.

## Exact File List to be changed or deleted

No files will be deleted. The implementation may change exactly these existing files:

| File | Planned change |
| --- | --- |
| `src/cli.ts` | Append Muse to the CLI onboarding default and describe the five-agent default in help. Preserve explicit agent selections and Muse version-only maintenance. |
| `src/install.ts` | Append Muse to programmatic `onboard()` defaults; reuse installation to add its clone on re-onboarding. |
| `src/setupWorkspace.ts` | Generate Muse with `delivery: "both"`, retaining its empty prelude, Enter submit, Basic profile and existing launcher wiring. Keep its logical harness identity separate from measured process aliases. |
| `src/tmux.ts` | Add the measured Muse foreground aliases, composer parsing, busy/dialog rejection, pending-action recognition, safe submission and recapture checks. Apply the Muse composer protection to automatic sends and explicit Muse reminders. |
| `src/doctor.ts` | Recognize Muse's terminal-delivery support separately from lifecycle-hook support; report absent lifecycle/containment observations as nonblocking information, while retaining real installation failures and existing vendors' hook checks. |
| `src/runLoop.ts` | Add clear explanations for Muse terminal refusal codes and make only any narrowly required connection to the existing delivery/watchdog paths. Preserve receipt authority, completion validation and durable send accounting. |
| `scripts/lib/launcher.sh` | Correct the obsolete opt-in/pull-only comment. Preserve the actual Muse launch flags, environment and version/update behavior. |
| `test/onboard.test.ts` | Extend CLI/programmatic default, re-onboarding, explicit-selection and frozen-issue-roster coverage. |
| `test/install.test.ts` | Update the existing Muse launcher test to require automatic delivery, retaining its assertions about launch flags, external paths, Git shim and absent lifecycle-hook installation. |
| `test/doctor.test.ts` | Cover healthy automatic Muse installation with absent lifecycle hooks, truthful informational output, real shim/launcher failures and unsupported-agent regression behavior. |
| `test/tmux.test.ts` | Extend existing terminal fixtures with sanitized live Muse captures and assertions for process aliases, composer states, keys, pending prompts and races. |
| `test/runLoop.test.ts` | Extend `safetyFixture` and ready/watchdog cases for Muse with no lifecycle events or transcript reader, including restart/recovery and bounded sends. |
| `test/integration.test.ts` | Add a compact Muse publication canary using the existing local-origin, mirror, order and submission patterns to validate both Git and private-response acceptance. |
| `config.example.json` | Change its Muse example to `both` and include the verified logical harness-process setting. |
| `README.md` | Replace optional/pull-only Muse claims and four-agent onboarding requirements with the five-agent default and explicit-selection alternative. |
| `docs/setup-workspace.md` | Update default onboarding/install examples and Muse operational guidance; record the implementation's live validation version, procedure, results and any concrete blocker here. |
| `docs/readiness-policy.md` | Document Muse's terminal safeguards, lack of callback/transcript evidence, ready-driven progress and recovery limits, including the focused Muse owner-reminder safety rule. |

The deliberately selected two-agent example in `config.product.example.json` remains a valid explicit configuration. Historical research in `docs/issue-210-agent-cli-analysis.md` remains an assessment of its recorded baseline. Neither needs to become a new default-roster declaration.

## Exact file list to be created

No new implementation, test, dependency or documentation files. Live capture strings join `test/tmux.test.ts`; durable validation results join the existing Muse section of `docs/setup-workspace.md`. Disposable scripts, terminal captures and test workspace preparation are scratch artifacts, kept outside tracked product files and the active issue runtime. This `.plans/issue-235/plan.md` is the requested coordination artifact, not a new product component.

## Reuse and Scope

The current implementation already has the essential protocol. `maybeLifecycleNudge()` authorizes JOIN without hooks and subsequent actions using ready receipts; prompt acknowledgment is display-only. `consumeReady()`, `deliver()`, `watchOwedWork()`, `markActionInjected()` and `markActionWorkflowComplete()` already maintain action identity, send reservations, resend accounting and completion truth. Extend terminal support around them rather than add a Muse lifecycle mapping, acknowledgment timeout or parallel state machine.

Implement in this order:

1. **Measure the existing launcher in isolation.** Use a disposable product clone, local bare origin, separate runtime/completion roots and an isolated tmux session. Capture actual `pane_current_command` and ANSI pane text for startup, idle composer, an owner draft, a pending action, an executing turn and interruption/restart. During planning, `MUSE_NO_AUTO_UPDATE=1 muse --version` returned `Muse Code 1.4.10 (1.4.10-R6427.1)`; only version execution is claimed so far. Measure the implementation's installed version again. Preserve the launcher command `muse --approval-mode never --disable-sandbox --trust-workspace` and `MUSE_NO_AUTO_UPDATE=1`; this issue does not redesign sandboxing. No lifecycle hooks are installed for this experiment.

2. **Add a small terminal adapter in `src/tmux.ts`.** Reuse `stripAnsi`, `paneLines`, `harnessLooksReady`, `harnessPromptReadiness`, `resolveNudgeKeys`, `pendingPromptInComposer`, `renderNudgeText`, `injectionGate`, `capturePane` and `typeAndSubmit`. Accept only measured Muse process names and bounded version/truncation variants, never an arbitrary shell or generic `node` process merely to make delivery pass. Parse the active composer and its measured footer, including wrapped input, independently of transcript history. Unknown or incomplete screens fail closed. Reject startup/trust/permission overlays, a running turn and owner drafts before reserving or sending keys. Busy Muse must not inherit the Codex/Cursor exception that allows Enter-only delivery during a turn: Enter can steer Muse's active work.

   Empty Muse input receives the current action prompt and Enter, with the existing text/key delay and no vim prelude or automatic Escape. The only nonempty input eligible for submit-only recovery is the complete current coordinator prompt, including matching action ID, digest and path (with its recognized resend prefix). Compare normalized wrapped composer content with the rendered prompt; a UUID appearing in history or in an owner's draft is insufficient. Extend the pending-prompt helper's inputs only as needed for this Muse check; retain other agents' semantics. Recapture immediately before the send batch so a draft or busy state appearing after the first read prevents delivery. A refusal before typing spends no credit; failure after typing retains uncertainty. Explicit Muse reminders reuse the composer/busy guard and submit-only recognition so recovery cannot append to an owner's draft. Other agents retain their existing explicit-owner-send contract.

3. **Enable onboarding and capability reporting together.** Change both existing onboarding defaults to `claude,codex,cursor,antigravity,muse` in that order. Reuse `buildWorkspaceConfig`, `agentOwnerUiDefaults`, `agentHarnessProcess`, `ensureAgentClone`, `writeAgentLauncher`, `writeGitWrapper` and the installed protocol overlay. The existing install loop regenerates config and wires all requested clones, so default re-onboarding adds Muse without a migration system. Explicit `--agents` and programmatic `agents` remain exact. Do not rewrite `start.json`, active rosters or delivery settings of an existing issue from the new workspace config.

   In doctor, a narrowly identified Muse terminal capability makes absent lifecycle-vendor mapping nonfatal. Keep `inspectAgentLifecycleHooks()` truthful: Muse remains unsupported there. Add a small informational field to `DoctorReport` and render it without contributing to `exitCode`; it states that Muse delivery uses ready receipts, lifecycle hooks and transcript observation are unavailable, and native containment is unverified. Do not infer live PATH-shim coverage from installation. Missing Git hooks, shim, launcher, identity or declarations remain findings. Existing supported vendors still require their installed hook definitions, and unknown agent IDs are not granted automatic capability by this Muse exception. No new vendor framework or configuration schema is necessary.

4. **Prove progress and recovery with existing authority.** Keep sends marked injected until actual evidence changes them; do not fabricate accepted callbacks or sessions. Matching `complete` artifacts advance the workflow even with no lifecycle session. Matching ready authorizes each next action, and reread pickup can complete an unsent replacement without a redundant send. The watchdog can use pane repaint without a Muse transcript; a static running pane still cannot pass the Muse send gate. Idle owed work retains the existing one-watchdog-resend then one wait report, 60/120/240-second spacing and four-send ceiling. Blank captures are not quiet evidence. A partial send remains `delivery-uncertain` across coordinator restart until existing owner recovery or validated completion resolves the relevant state; there is no permanent wait for a nonexistent prompt hook. A dead pane retains `harness-gone` recovery. Document that restarting Muse does not manufacture a fresh-session callback: repair/relaunch and release the relevant hold through existing owner controls.

Reuse `ProductFixture`, `makeProduct`, `ensureBuilt`, `installOnce`, `runnerWithPrompt`, `commandsIn`, `safetyFixture`, `nextAction`, fake-clock advancement and the integration suite's `BareMirror`, `buildOrder`, Git publication and `writeAgentResponse` patterns. Keep live captures inline in the existing test file; no generic fixture library, dependency or transport is justified. Do not modify `githooks/`, lifecycle schemas, analytics, quota handling, version numbers or peer-agent behavior.

## Tests

Use the fewest cases that cover distinct failure modes, parameterizing related terminal states and recovery states in the existing files above.

- **Onboarding/install:** extend the existing happy-path default assertion to five ordered agents and verify Muse's clone, launcher, `both`, empty prelude and Enter. Add programmatic-default coverage, then re-onboard a four-agent workspace using defaults and prove Muse is added. Start an issue before re-onboarding and verify its frozen roster/config remain unchanged on resume; a fresh issue uses the five-agent config. Retain explicit one/subset selections exactly, including explicit selections without Muse. The current baseline fails the five-agent and automatic-delivery assertions.
- **Doctor:** an installed Muse with `both` and no lifecycle files exits successfully with accurate informational output; remove its shim or launcher and retain the real failure. Keep existing missing/modified lifecycle-hook tests for supported vendors and the unknown-ID test. The baseline wrongly reports Muse's missing vendor mapping as a fatal error.
- **Terminal:** use measured process strings and captured idle, wrapped pending-action, owner-draft, busy, trust and unknown-screen states. Assert the exact literal prompt/Enter sequence and absence of Escape/vim keys. A pending current prompt sends only Enter; wrong digest/path, stale action, quoted UUID, extra owner text and submitted history send nothing. Cover a draft or busy transition on the final recapture and a transport error after reservation. Run the corresponding Muse owner-reminder cases. These expose the baseline's missing aliases, generic ready result and draft/pending handling.
- **Run loop:** use `safetyFixture("muse")` with the real Muse harness expectation and capture shape, without calling its `working()`/`stop()` hook simulators or creating transcript files. Send initial JOIN, then at least two subsequent actions authorized by matching ready receipts; repeated ticks, stale ready files and coordinator restarts must not duplicate sends. Cover both receipt/order arrival orders and completion by rereading a replacement. Parameterize static-busy, idle-stalled, changing-pane, blank-capture, draft and pending-prompt states. Verify one permitted resend, bounded budget, durable uncertainty, dead-pane/hold release and explicit owner recovery without inventing acknowledgments. Retain the existing Codex/Cursor continuous-turn regressions.
- **Publication integration:** extend existing local bare-origin and run-loop patterns with a Muse automatic-delivery lane and controlled peers sufficient to reach a response-mode ballot. Validate real pushed Git artifacts and their exact SHA completion markers, then private JSON bound to the current action/input set plus `response <actionId>`, accepted response and coordinator publication. A wrong/stale completion must not advance. No lifecycle events may be emitted for Muse. This test proves artifact acceptance; its fake terminal is explicitly not the live transport proof.

Focused commands during implementation:

```sh
pnpm exec vitest run --config vitest.config.ts test/doctor.test.ts test/tmux.test.ts test/runLoop.test.ts
pnpm exec vitest run --config vitest.system.config.ts test/onboard.test.ts test/install.test.ts test/cli.test.ts
pnpm exec vitest run --config vitest.e2e.config.ts test/integration.test.ts
```

`package.json` defines `check:fast` as lint, typecheck, fast tests and system tests, and `check` as build, `check:fast` and e2e. For product submission let the installed hook run its mandatory `pnpm check:fast`; do not run it again immediately before committing. Follow the active implementation action's verification mode: when coord owns candidate/final suites, cite its results; otherwise run required local checks. The frozen issue declares final `pnpm run check`, which is coordinator-owned and must not be claimed as an agent-run result. Publishing this plan requires only artifact/format/evidence validation.

**Live acceptance is mandatory for the implementation.** In the isolated disposable workspace, launch the real generated Muse launcher and run the real terminal delivery path, with no Muse lifecycle callbacks or transcript reader. Have Muse itself perform JOIN and at least two subsequent actions automatically, continuing far enough to publish both a pushed Git artifact and a valid private response. Inspect artifacts, origin refs, exact completion/ready markers, accepted cursor/batch records and action/digest-correlated sends. Do not replace these actions with an echo stub or write Muse's completion evidence on its behalf. Ordinary handoffs receive no owner reminder. Separately exercise a pending prompt, owner draft, running turn, interrupted/restarted harness, coordinator restart, bounded resend and uncertainty recovery, recording automatic versus explicit recovery sends. Confirm drafts survive and completed work is not repeated.

Record tested Muse version/build, OS/tmux and foreground observations, capture-derived readiness rules, commands/workspace layout, action IDs, publication pins/response digests and per-scenario results in `docs/setup-workspace.md`. Keep secrets and raw personal terminal history out of committed evidence. If authentication, tool permission, network publication, terminal access or another concrete capability blocks the live run, record the failing operation, reproduction, observed output and missing capability; report live acceptance incomplete. Neither stub tests nor a return to pull delivery satisfies that requirement.

## Alternatives Rejected

- Keeping Muse opt-in or generating pull delivery fails normal onboarding and automatic handoffs.
- Adding lifecycle callbacks, acknowledgment timers or a transcript reader as prerequisites ignores the existing ready/complete protocol and expands scope.
- Treating every Muse process or screen as ready, or accepting an action UUID anywhere in the pane, risks steering running work or submitting an owner draft.
- Sending Escape to repair submission can interrupt Muse. Use its measured Enter semantics and existing timing instead.
- Introducing a vendor registry, MSP/SDK transport, new configuration schema or general plugin system is unnecessary for this focused adapter.
- Declaring success solely from mocked terminal tests misses the acceptance requirement for real Muse behavior and publication.

## Risks and Mitigations

- **Process and UI differences:** measure the installed version and supported OS truncation, retain narrow aliases and capture-based fixtures, and fail closed on unrecognized composer layouts. Report a concrete blocker instead of widening detection speculatively.
- **Draft/paste races and duplicate submission:** check active composer content against the full current prompt, recapture before sending, preserve the existing authority callback and reserve-before-write behavior, and retain uncertainty after partial transport failure.
- **Absent observation channels:** distinguish injected, accepted and completed states. Ready receipts and validated artifacts drive progress; lack of callbacks never becomes an acknowledgment wait. Static busy chrome blocks resends, while uncertain delivery uses explicit existing recovery.
- **Default-roster expansion:** verify new onboarding and re-onboarding independently from frozen issue snapshots; explicit rosters retain exact membership and order.
- **Misleading capability claims:** doctor permits the demonstrated terminal capability while reporting absent native hooks/observations. Installation alone proves neither native enforcement nor PATH-shim use.
- **Existing launcher permissions:** preserve the documented unsandboxed/trusted run policy and Git verification. Run experiments only in disposable roots and report publication/receipt limitations honestly; do not expand this issue into sandbox redesign.
- **Incomplete file map:** if measured integration needs an additional tracked file, request the coordinator's plan amendment before submitting product edits outside this list.

## Conclusion

Enable Muse as the fifth default agent with automatic delivery through a small, measured terminal adapter. Preserve the existing ready/complete authority and recovery protections, distinguish terminal capability from lifecycle observability, and require real Muse Git/private-response publication plus successive automatic handoffs before claiming the implementation complete.

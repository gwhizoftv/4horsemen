# Issue 230: integrate Meta Muse Code into normal coordination configuration

The requested outcome is an installed Muse participant that can receive an action, publish its Git or private-response artifact, write complete/ready, and receive the next action. Add Muse to new-install/onboard defaults and both example configurations once that contract works. Explicit agent selections and existing issue snapshots remain authoritative. This is an integration of the CLI, not a model selector or an MSP transport migration.

The issue source is the coordinator's `github-issue.json` for #230. The design follows `docs/issue-210-agent-cli-analysis.md`, particularly “Exact future Muse change map under the current architecture” and “Bounded follow-up and acceptance criteria.” Baseline: `884df5fe1200f1cfbd3cecae887488d8c376fdf9`; planning action: `dbe587a9-52ae-4352-87c3-d714813bf8ce`.

Planning observations on 2026-10-16: `MUSE_NO_AUTO_UPDATE=1 muse --version` reports **Muse Code 1.4.10 (1.4.10-R6427.1)**, and the local wrapper declares launcher version **3**. Help has no `update` command or `--add-dir`; it exposes run-local configuration, trust, approval, permission-profile and workspace options. These observations supersede the report's local 1.4.9 observation only for this installation. No live Muse model session or successful publishing/containment test is claimed.

Meta's [permissions reference](https://dev.meta.ai/docs/muse-code/permissions) documents protected `.git`, `.muse`, and `.agents` directories and restrictions on enforceable custom filesystem profiles. Its [configuration reference](https://dev.meta.ai/docs/muse-code/configuration) documents trusted-project AGENTS loading. The [hooks reference](https://meta-models.github.io/muse-code-sdk/next/guides/extend/hooks/) documents cleared hook environments, managed-only environment allowlisting, nested hooks, session/prompt fields, and explicit denial responses. These are compatibility constraints, not evidence that the installed version already satisfies coord's workflow.

## Exact File List to be changed or deleted

No deletions. The complete proposed product map is:

| Existing path | Intended change |
| --- | --- |
| `scripts/lib/launcher.sh` | Add Muse environment/launch cases; disable wrapper auto-update during maintenance and sessions; separate resolved coordination roots from vendor argv; render only a proved Muse grant policy. Preserve existing vendors' generated argv and Bash 3.2 compatibility. Prepare run-bound Muse hooks before exec. |
| `src/cli.ts` | Replace executable strings with a small maintenance record supporting nullable updater argv; collect Muse's version without invoking `muse update`. Add Muse to install defaults and vendor help. Expose the narrow internal launch-configuration operation and explicit binding arguments needed by Muse callbacks. |
| `src/setupWorkspace.ts` | Add Muse label and measured process/UI defaults; generate the Muse launcher and the intended delivery mode through the existing config builder. |
| `src/install.ts` | Add Muse to the onboard default roster; wire its existing hook generator/removal through installation, preserving dry-run, idempotence and owner settings. |
| `src/agentHookSync.ts` | Add Muse path, nested events, matcher and command rendering; preserve unrelated handlers and disabled-hook settings in install/inspect/remove. Render run-bound commands for the cleared environment. |
| `src/agentEvent.ts` | Accept Muse and normalize measured lifecycle fields into existing observations; validate explicit run bindings before routing callbacks; retain exact action path/ID/digest checks. |
| `src/shellGuard.ts` | Normalize the actual Muse shell envelope and response; validate run binding independently of inherited environment, then reuse static recognition and the Git policy shim. |
| `src/tmux.ts` | Add measured Muse process aliases, positive idle-prompt/composer checks, busy/trust/draft refusal, empty-prelude/Enter policy, and recapture before submission. |
| `src/runLoop.ts` | Give Muse refusal reasons concrete operator messages; retain existing readiness receipts, acknowledgement and no-blind-resend rules. |
| `src/doctor.ts` | Recognize the supported Muse wiring and report absent, disabled, modified or incompatible configuration without claiming measured containment from installation. |
| `src/productIgnore.ts` | Add `.muse/` to managed clone exclusions. |
| `templates/product/gitignore.coordination.block` | Keep the product ignore template aligned with `.muse/`. |
| `.gitignore` | Ignore generated Muse state in this self-hosted repository. |
| `config.example.json` | Add the Muse participant with the verified launcher, process and key/delivery configuration. Preserve unrelated verification policy. |
| `config.product.example.json` | Demonstrate the same supported Muse integration in the generic product example. |
| `test/cli.test.ts` | Extend fresh-start maintenance, defaults and command-routing cases. |
| `test/install.test.ts` | Extend installer, generated launcher/grants, ignore, idempotence, dry-run and uninstall cases. |
| `test/onboard.test.ts` | Update actual default-roster expectations and verify explicit selections and Muse configuration. |
| `test/agentHookSync.test.ts` | Extend nested-hook ownership/inspection/removal and executable callback tests for Muse. |
| `test/agentEvent.test.ts` | Extend normalization and runtime routing fixtures with Muse lifecycle and binding cases. |
| `test/shellGuard.test.ts` | Extend vendor payload/denial and stale/manual binding cases. |
| `test/tmux.test.ts` | Add measured Muse pane fixtures inline and assert safe keys and send timing. |
| `test/runLoop.test.ts` | Extend delivery/receipt regressions for Muse deferrals, acknowledgement and next-action progression. |
| `test/doctor.test.ts` | Extend supported, missing, disabled and modified wiring checks. |
| `README.md` | Add Muse to supported-agent and setup descriptions when acceptance is established; retain product branding and artwork. |
| `docs/setup-workspace.md` | Document normal defaults, installation, launch policy, run-local trust, binding, supported version evidence and limitations. |
| `docs/coord-driver.md` | Document Muse lifecycle delivery and completion behavior. |
| `docs/readiness-policy.md` | Document positive Muse readiness and busy/draft refusal. |
| `docs/analytics.md` | Explicitly document unavailable Muse usage/quota telemetry. |

The plan does not authorize edits to product `githooks/`, the local AGENTS overlay, package/version manifests, dependency lockfiles, historical issue-210 analysis, or unrelated test rosters. If compatibility discovery requires another tracked path, request a plan amendment before using it.

## Exact file list to be created

No new tracked product modules, scripts, dependencies, test files or fixture files are planned. Small sanitized payloads and pane samples belong alongside the existing tests that use them. The current action creates only this coordination artifact, `.plans/issue-230/plan.md`.

At installation/runtime the existing generators will create untracked `start-muse.sh` and `.muse/hooks.json` inside the Muse clone. The launcher is necessary for normal installer validation; the hook document is necessary for the lifecycle and shell-guard adapter. Use the existing managed marker and atomic writer. Any grant configuration needed by the verified vendor interface is generated per launch under ignored clone-local state, never committed with machine paths or credentials. It must be validated before execution and owned/removed through the existing installation lifecycle.

## Reuse and Scope

Reuse `AgentConfig` and the generic agent-ID schema unchanged; `muse` already satisfies the ID grammar. Reuse `validateAgentIds`, `buildWorkspaceConfig`, `agentOwnerUiDefaults`, `writeAgentLauncher`, `launcher_environment`, `launcher_command`, and `write_launcher`. The shell library remains the only source of launch flags, including post-merge regeneration. The maintenance record in `src/cli.ts` describes only maintenance/version commands, not launch flags.

Reuse `syncAgentLifecycleHooks`, `plannedDocument`, `withoutManagedNestedHandlers`, `removeAgentLifecycleHooks`, `inspectAgentLifecycleHooks`, `shellQuote`, and `atomicWriteJson`. Reuse `normalizeAgentEvent`, `extractPromptActionIdentity`, `resolveWorkspaceConfig`, `readStartState`, and the existing lifecycle reducer. Reuse `normalizeShellRequest`, `staticGitCalls`, `guardShellRequest`, `shellGuardResponse`, and containment recording; do not make a second Git-command parser. Reuse `harnessLooksReady`, `harnessPromptReadiness`, `resolveNudgeKeys`, `pendingPromptInComposer`, `injectionGate`, `nudge`, and `typeAndSubmit` for terminal delivery.

Tests reuse `makeProduct`, `effectOptions`, the installer launcher-capture stubs, the CLI's `setup`/`successfulStartGit`/fake-loop facilities, `runtimeFixture` in agent-event tests, and existing tmux fake runners and pane strings. No generic vendor registry, adapter framework, new transport, model selector or participant/vendor split is justified. No new persistent trust writer is needed if measured run-local trust loads the existing AGENTS overlay. No legacy `setup_muse.sh`, transcript reader, quota probe, automatic recovery or replacement artwork is included.

Implementation order and contracts:

1. **Establish the blocking compatibility contract first.** In an isolated disposable product/clone/runtime, record exact CLI and wrapper versions and demonstrate native instruction loading, shell/tool payloads and permission behavior. The necessary writes are the clone including Git staging/commit, that agent's completion mailbox and response directory, and the existing per-issue inputs/worktrees roots. Owner cursors/journal, peer mailboxes and accepted-response archives must remain outside agent write grants. Demonstrate checks and push to a disposable remote. A local bare remote proves Git mechanics; actual network push needs separate evidence. Do not treat `--workspace` as additive grants without testing it.

   There is currently **no demonstrated narrow grant/Git policy** in the research or this planning session. This is a release blocker, including for pull mode. If the installed CLI cannot express and enforce that policy, report the concrete blocker through the implementation action's escalation mechanism rather than submit a nominally supported configuration. Do not silently switch to `--yolo`, disable the sandbox, grant the runtime parent, or accept a read-only fail-open profile. A different containment design or additional files require review/amendment. This plan does not claim those compatibility questions have already been solved.

2. **Implement maintenance and normal installation.** Existing vendors keep their executable, update argv, version argv, timeouts and update-before-version-before-launch ordering. Muse has `executable: muse`, `versionArgv: [--version]`, and `updateArgv: null`; skipping its updater is intentional and still records the installed version. Set the observed `MUSE_NO_AUTO_UPDATE=1` in the shared Muse environment so neither the version probe nor pane launch upgrades a running issue. Add Muse last to new default rosters; do not append it to explicitly supplied `--agents` or frozen issues. Preserve existing agents' generated defaults. Use no hard-coded model. New Muse configs target `delivery: both` only after all acceptance gates below pass.

3. **Render grants and hooks with an explicit issue binding.** Resolve the existing four extra roots once, then render the measured vendor-specific permissions. Existing `--add-dir` clients retain exactly their current grants. Validate generated Muse policy before exec and refuse an unsupported policy instead of launching with fewer or broader permissions.

   Muse project hooks cannot rely on inherited `COORD_ISSUE`. Extend the existing hook renderer with an optional explicit issue/session binding. A narrow internal CLI operation, invoked by the generated launcher, validates `COORD_ISSUE`, clone identity, registered workspace, active frozen issue and roster, then atomically refreshes only managed Muse hook commands before starting Muse. Embed quoted literal `--issue` and `--issue-session-id` arguments in those commands; the bridge validates them against the configured owner runtime before dispatch. The shell guard supplies the validated issue to the existing policy evaluation. Never infer the current issue from a guessed latest directory. Manual launches render unbound callbacks that cannot attach themselves to an unrelated active issue through the existing observational fallback. Reinstallation/inspection compare the managed structure with its validated binding; they must not silently erase a live binding or report arbitrary stale binding as current. Old sessions must not route observations or containment claims into a replacement issue/session.

   Start with the measured equivalents of SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop and SessionEnd. Normalize session/turn IDs and exact action prompt identity; ignore unsupported payloads and child-thread callbacks that cannot be correlated to the top-level participant. Do not infer quota semantics from StopFailure or ordinary Stop. Match the actual managed shell tool as well as any supported legacy shell name; copying a Bash-only matcher is insufficient without evidence. Preserve owner handlers and disabled settings. A callback emitting deny is insufficient: verify that the actual shell tool request is refused, and record hook and shim coverage separately.

4. **Implement conservative terminal delivery.** Capture the installed Muse process name, including tmux/OS truncation, and actual idle/busy/trust/draft panes. Require a recognized idle composer; unknown or blank panes refuse injection. Block busy Muse even with Enter-only keys because it can steer an active turn. Preserve explicit empty prelude and Enter without the generic `a`/Escape repair. Do not reuse Codex/Cursor's busy-queue exception. Before typing and again before submit, recapture and verify that no busy transition or owner draft appeared. Detect an already pending exact action prompt so it is submitted once rather than appended again. Keep existing authority checks, send reservation, receipt gating, uncertainty handling and no-blind-resend behavior. Record clear refusal reasons in the run loop.

5. **Publish configuration and documentation after proof.** Enable normal Muse defaults/examples only when Git publication, private-response publication and subsequent delivery work. Describe installed wiring separately from actual runtime containment. Keep usage unavailable and recovery owner-driven. An explicit pull setting remains usable after filesystem publication is proved, but pull is not a substitute for this plan's automatic-delivery acceptance target.

## Tests

Add focused cases in existing files; use parameterized variants for closely related cases instead of a new framework. Each new case below must fail against the baseline behavior it addresses:

| Test home | Regression to prove |
| --- | --- |
| `test/cli.test.ts` | Muse is versioned without ever receiving `update`; other vendors retain ordering/timeouts; missing/version-failing Muse is reported honestly. Validate internal launch binding and command arguments. |
| `test/install.test.ts`, `test/onboard.test.ts` | Default installation includes Muse; explicit selections remain exact. A fake Muse executable captures argv/environment under paths containing spaces/quotes. Assert only the intended roots, no `--add-dir`, stable update policy, manual mode, repeated install, dry-run, owner settings and uninstall preservation. Check `.muse/` exclusion at the generated and template levels. |
| `test/agentHookSync.test.ts` | Install/inspect/remove round-trip for Muse with mixed owner/managed nested groups and disabled hooks. Execute generated handlers under a cleared environment and verify explicit validated binding reaches the bridge. Rebinding/reinstall cannot route stale or manual callbacks into an active issue. |
| `test/agentEvent.test.ts` | Measured startup/prompt/tool/stop/end payloads retain session/turn identity and acknowledge only the current action path/ID/digest; wrong clone, issue/session, stale session and child-thread callbacks cannot authorize progress. |
| `test/shellGuard.test.ts` | Real Muse-shaped command payloads produce the required denial envelope for prohibited clone commands and allow authorized Git publication. Cleared environment still enforces the bound automated issue; manual and stale inputs cannot claim active containment. |
| `test/tmux.test.ts` | Measured process aliases and idle prompt pass; busy, trust, unknown and draft panes send no text/keys. Explicit `[]`/`[Enter]` survives resolution. A busy transition between paste and submit suppresses Enter; a pending matching action is not duplicated. |
| `test/runLoop.test.ts` | Muse refusal messages are specific; prompt acknowledgement requires exact identity; both Git and private-response completion still require the matching ready marker before the next action, and restart/uncertain delivery does not trigger a blind resend. |
| `test/doctor.test.ts` | Valid Muse wiring is supported; missing, disabled and edited wiring remains a finding. Installation alone never reports measured containment. |

Use these existing suite entrypoints for focused development:

```sh
pnpm exec vitest run --config vitest.system.config.ts test/cli.test.ts test/install.test.ts test/onboard.test.ts test/agentHookSync.test.ts
pnpm exec vitest run --config vitest.config.ts test/agentEvent.test.ts test/shellGuard.test.ts test/tmux.test.ts test/runLoop.test.ts test/doctor.test.ts
bash -n scripts/lib/launcher.sh
```

The current registered workspace declares precommit `pnpm run check:fast`, prepush `pnpm run test:e2e`, and final `pnpm run check`; `package.json` and the three Vitest configurations confirm the commands and suite split. Let installed product hooks run their mandatory suites instead of manually duplicating them immediately before commit. The coordinator owns final checks at the approved pin; cite those recorded results separately. If a later action selects coordinator verification mode, follow its candidate results and cheap-hook policy rather than rerunning its suites.

Live acceptance is additional to stub tests: exact installed version/wrapper; trusted AGENTS loading; permitted writes and denied neighboring writes; staging/commit/checks/push; actual-tool containment refusal with hook/shim distinction; automatic delivery at idle and refusal during work/drafts/trust; a Git action followed by complete/ready and another action; a private-response action followed by complete/ready and another action; and restart without stale acknowledgement or duplicate submission. Record sanitized evidence in `docs/setup-workspace.md`, not credentials or full transcripts. Missing live evidence is a blocker, not a passing result.

For this plan-only action, validate required headings, every file's existence and intended scope, action digest, and the artifact itself. No product tests or live Muse session are required or claimed for publishing the plan.

## Alternatives Rejected

- Adding only an example entry or a launcher case: installer validation, generic updater behavior, filesystem publication and terminal-key fallbacks make that insufficient for a normal participant.
- Treating pull delivery as a permission workaround: it avoids key injection but cannot repair blocked Git or external receipt writes.
- Passing `muse update`, reusing `--add-dir`, or assuming a generic permission profile works: local help and documented sandbox behavior do not establish those contracts.
- Broad sandbox bypass or granting the whole runtime: that would expose coordinator-owned and peer state merely to obtain receipt writes.
- Copying Claude hooks unchanged: cleared environment, actual shell names, payloads and top-level session identity need explicit adaptation and measured refusal.
- Replacing all vendor switches with a registry, adding an SDK transport, or bundling analytics/quota/model-selection support: the issue-210 map recommends existing boundaries and none of those changes solves the blocking CLI contracts.
- Changing all existing configs and generic fixture rosters: explicit owner choices and unrelated arbitrary-ID fixtures are not default-roster definitions.

## Risks and Mitigations

- **Muse may not support the necessary narrow filesystem policy.** Verify before advertising support. Current help/documentation is not a successful publication run. Escalate a concrete incompatibility instead of weakening isolation or declaring a partial launcher complete.
- **Version drift invalidates terminal or hook observations.** Record exact binary/wrapper versions, disable wrapper auto-update in issue sessions, retain sanitized measured fixtures, and refuse unknown pane states. Do not invent a minimum supported range from one tested build.
- **Hook environment clearing or stale binding silently disables enforcement.** Embed a validated per-run binding in managed commands, validate it at receipt, exercise cleared environments and restarts, and require actual-tool refusal evidence. Manual launches cannot adopt the unique-active-issue fallback for Muse.
- **Enter steers and Escape can interrupt ongoing work.** Use Muse-specific key resolution and recapture immediately before submission; busy/uncertain states defer with no automatic retry authorization.
- **Shared launcher refactoring changes established vendors.** Keep their emitted argv/environment behavior covered by existing capture tests while separating only root resolution from argument rendering.
- **Installation overwrites owner settings.** Reuse marker-based merge/remove semantics, preserve disabled hooks, test mixed groups/dry-run/idempotence, and prefer run-local trust over global changes.
- **Default roster expansion surprises installations without Muse.** Document the new default and explicit `--agents` selection; never auto-install/login to Muse or rewrite frozen issues. Missing executable/version must be reported clearly.
- **The approved map proves insufficient.** Use the coordinator's amendment protocol before changing another tracked file; preserve the selected plan and required parent pin.

## Conclusion

Integrate Muse through the existing maintenance, installer, launcher, hooks, guard and tmux boundaries, then include it in normal new-workspace defaults and examples. Completion means both publication modes and repeated automatic action delivery work with measured permissions and containment. The first implementation gate is the unresolved narrow-grant/Git contract; this plan deliberately does not confuse a configured name, a passing stub or a documented hook with a working participant.

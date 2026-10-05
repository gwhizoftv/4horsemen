# Plan — issue 142: Git containment that survives harness PATH reordering

Baseline: `main` at `6fbbe84be880ce28d41da4d34255247557a5a592`.

## Summary

The `.coord/bin/git` shim only runs if `git` resolves to it on the agent's
shell PATH. Cursor's harness reorders that PATH, and any `bash -lc` / `zsh -lc`
call reorders it through `path_helper`. Either way the refusals silently stop
applying. Following the owner-account review on the issue, this plan:

1. Adds a **shell-tool guard**: a vendor hook that inspects the proposed shell
   command before it runs, for all four agents. Claude and Codex use
   `PreToolUse` matched to `Bash`. Cursor uses `beforeShellExecution`.
   Antigravity uses `PreToolUse` matched to `run_command`. All four are
   installed through the existing `src/agentHookSync.ts` installer.
2. Keeps **one** Git policy, the existing shim. A new check mode makes the shim
   decide without running git. The guard turns the shell text into git argv
   lists and asks the clone's own shim to classify each one. There is no second
   copy of the policy in TypeScript.
3. **Verifies in the agent's real process.** The participation-ready (R1.join)
   action asks the agent to run one harmless refusal probe and one resolution
   probe through its own shell tool. Coverage is recorded per session in the
   agent lifecycle state and reported in `coord status`, the journal, and a
   prominent warning when the join is accepted. A doctor finding covers
   installed-but-missing hooks.
4. **Aligns the protocol text** with the guardrail that is actually supported.

Making `hook-verify` hermetic (`src/hookPolicy.ts:121`) is deliberately a
**separate follow-up**, as the issue review recommends. It is not part of this
change.

## Exact File List to be changed or deleted

- `scripts/lib/launcher.sh`: `write_git_wrapper` gains a check mode. When
  `COORD_GIT_POLICY_CHECK=1` is set, `delegate()` and the `COORD_GIT_DELEGATE`
  short-circuit `exit 0` instead of `exec`-ing real git. Refusals are unchanged:
  exit 2 with the message on stderr. Nothing changes when the variable is unset.
  The launcher PATH prepend (lines 367-368) stays as the fallback layer.
- `src/agentHookSync.ts`: the planned, removed, and inspected documents gain the
  managed guard handler for each vendor:
  - codex and claude: `PreToolUse` → `{ matcher: "Bash", hooks: [{ type: "command", command, timeout: 10 }] }`. This goes through the same nested path as the lifecycle events, so `withoutManagedNestedHandlers` keeps owner handlers that share a matcher group.
  - cursor: `beforeShellExecution` → `{ command }`, added to the local `cursorEvents` list used by plan and remove.
  - antigravity: inside the existing managed named set `coord-agent-lifecycle`, add `PreToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command, timeout: 10 }] }]`. This is a matcher-group shape, unlike the flat lifecycle handlers.

  A new `renderShellGuardHookCommand(cliEntry, clone, vendor)` carries the
  existing `AGENT_LIFECYCLE_HOOK_MARKER`, so the existing idempotence, owner
  preservation, managed-only removal, and `inspectAgentLifecycleHooks` cover the
  guard with no second installer. The command is a short `/bin/sh` prefilter:
  if the payload has no `git` substring, it prints the vendor's allow literal
  without starting Node. Otherwise it pipes the payload to
  `node <cli> git-guard --vendor <v> --clone <clone>`.
- `src/agentEvent.ts`: export the existing `object` and `stringField` helpers so
  the guard reuses the vendor JSON normalization conventions. The fail-open
  `agent-event` behaviour is unchanged.
- `src/agentLifecycle.ts`:
  - `agentLifecycleEntrySchema` gains `containment: z.object({...}).nullable().default(null)`, the same compatible-extension pattern as `lastFailure` and `claudeRateLimits`. `AGENT_LIFECYCLE_FORMAT_VERSION` does not change. The object holds `hookDenial: { sessionId, vendorVersion, policyRevision, at } | null` and `probe: { sessionId, shim: "active" | "bypassed", resolvedGit, issueEnv: boolean, at } | null`.
  - New `recordContainmentEvidence(paths, agent, patch, now)` built on `mutateAgentLifecycle`.
  - New pure `containmentCoverage(entry)` returning `{ hook: "active" | "inactive" | "unverified", shim: "active" | "bypassed" | "unverified" }`. Without a probe, or with a probe whose `sessionId` differs from the entry's current `sessionId` (a restart), both are `unverified`. With a probe, `hook` is `active` only if a denial was recorded for the same session.
- `src/cli.ts`: two commands plus help text.
  - `git-guard --vendor <v> --clone <path>` reads the bounded stdin payload, calls `src/shellGuard.ts`, prints the vendor response, and returns 0. Any internal error prints the vendor allow response plus a stderr note, so hook crashes stay fail-open as documented.
  - `containment-probe [--clone <path>] [--issue <n>]` records and prints the agent shell's own shim resolution and the session's hook coverage.
- `src/steps.ts`: the `R1.join` task text gains the probe instruction. Before
  writing the artifact, run `git status --porcelain` in this clone (it is
  expected to be refused; do not work around it), then run
  `coord containment-probe`.
- `src/runLoop.ts`: in `accept()`, when the accepted step is `R1.join`, compute
  `containmentCoverage` for that agent and append a `containment-coverage`
  journal entry with both readings. If `hook` is not `active`, `this.log` a
  prominent `WARNING` naming the agent and both readings. The warning says the
  agent is **not** contained when the shim is not `active` either. This is a
  warning, not a refusal, which is the smallest rollout the review allows.
- `src/issueReport.ts`: the per-agent line in `coord status` appends
  `containment hook=<x> shim=<y>`.
- `src/doctor.ts`: the existing `lifecycleHooks` missing and modified messages
  now name the shell guard, so missing or disabled guard definitions are
  reported. A new `gitShim` finding is added when `.coord/bin/git` is missing or
  not executable. Doctor states that runtime coverage is shown by `coord status`,
  because doctor's own spawned shell cannot prove the agent's environment.
- `templates/product/AGENTS.protocol.md`: rewrite the refusal paragraph.
  `git status`, `git diff`, and the pinned `git show` are protocol instructions.
  Coordination enforces them through the shell-tool guard where it is verified,
  and through the PATH shim where it resolves. The paragraph states what the
  guard does not catch: scripts, dynamically constructed commands, and input
  typed into an already-open terminal. It points to `## Bound input files`.
- Tests listed under **Tests**: `test/install.test.ts`,
  `test/agentHookSync.test.ts`, `test/agentLifecycle.test.ts`,
  `test/issueReport.test.ts`, `test/doctor.test.ts`, `test/runLoop.test.ts`,
  `test/cli.test.ts`.

No files are deleted.

## Exact file list to be created

- `src/shellGuard.ts`: the dedicated blocking handler. It is kept apart from the
  fail-open `agent-event` receiver, as the review requires. It contains:
  - **Vendor input adapters** that return `{ commands: string[] | argv, cwd, sessionId, vendorVersion }`:
    - claude and codex read `tool_input.command`, as a string or as an argv array, plus `cwd` and `session_id`.
    - cursor reads `command`, `cwd`, `conversation_id`, and `cursor_version`.
    - antigravity reads `toolCall.args.CommandLine`, `toolCall.args.Cwd`, and a session id where present.
  - **Vendor output serializers**:
    - claude and codex: `hookSpecificOutput.permissionDecision: "deny"` plus `permissionDecisionReason`.
    - cursor: `permission: "deny"` plus `user_message` and `agent_message`.
    - antigravity: `decision: "deny"` plus `reason`.
    - Each vendor has an allow literal, the same one the `/bin/sh` prefilter prints.
  - **A bounded static shell splitter** that never executes the text. It handles single and double quotes, backslash escapes, and the separators `; & && || | |& ( )` and newline. It skips redirections, and heredoc bodies up to their delimiter. It collects leading `NAME=value` assignments, passing `GIT_DIR` and `GIT_WORK_TREE` through. It unwraps `env`, `command`, `exec`, `nohup`, and `time`. It tracks `cd` and `pushd <literal>` for later segments in the same text. It recurses into `bash`, `sh`, `zsh`, and `dash` when the flags include `-c` (`-c`, `-lc`, `-l -c`). It recognises git by `basename(word) === "git"`, which covers direct paths such as `/usr/bin/git`. A dynamic command word (`$`, backtick, `$(`) or an unresolvable `cd` makes that segment unanalyzable, and it is allowed. This is the stated limitation, not a new shell interpreter.
  - **The decision.** For each git argv, spawn `<clone>/.coord/bin/git` with the parsed `cwd`, `PWD=cwd`, the inline assignments, and `COORD_GIT_POLICY_CHECK=1`. `COORD_GIT_DELEGATE` is removed from the env so that neither an inherited value nor an inline assignment can serve as a bypass. The call has a 5 s timeout. Exit 2 means deny, with the shim's own stderr as the reason, plus one line pointing at `## Bound input files`. Anything else means allow. A missing shim, a nonexistent cwd, or an oversized payload (the `AGENT_EVENT_MAX_BYTES` bound) means allow.
  - **On deny**, record `hookDenial` through `recordContainmentEvidence` and journal `containment-guard-denied` with vendor, sessionId, vendorVersion, policyRevision, and subcommand. Policy revision is the first 12 hex digits of `sha256` of the shim bytes, from `src/hash.ts`. The issue comes from `COORD_ISSUE`, which is the same scope the shim uses. Clone identity comes from `consensus.agentId`, as `handleAgentEvent` resolves it. A recording failure never turns a deny into an allow.

  A new file is justified because the splitter, the adapters, and the decision
  are one blocking concern. `agentEvent.ts` must stay fail-open telemetry, and
  `cli.ts` is already the dispatcher, not a home for logic.
- `test/shellGuard.test.ts`: the shared policy test matrix for the new module.
  One table of command texts runs through all four vendor adapters and
  serializers against a real installed shim fixture. A new file is justified
  because no existing test file covers this module, and the matrix is the
  acceptance surface the issue asks for.

## Reuse and Scope

Reused, not duplicated:
- **Policy.** `write_git_wrapper` in `scripts/lib/launcher.sh` stays the only
  place that decides status, diff, show, repository targeting, global-option
  parsing, and the materialization-dependent pinned-read rule
  (`coord_action_lists_files` together with `INCOMPLETE_MATERIALIZATION_NOTE`).
  The guard calls it in check mode. `writeGitWrapper` and `resolveRealGit` in
  `src/setupWorkspace.ts` are unchanged, and so is regeneration by
  `coord install` and `githooks/post-merge`.
- **Installer.** `syncAgentLifecycleHooks`, `removeAgentLifecycleHooks`,
  `inspectAgentLifecycleHooks`, `withoutManagedNestedHandlers`, `readDocument`,
  `shellQuote`, `AGENT_LIFECYCLE_HOOK_MARKER`, and `agentLifecycleHookPath`.
  `src/install.ts` already calls sync and remove, so it needs no change.
- **Normalization.** `object` and `stringField` from `src/agentEvent.ts`,
  `localConfigGet` from `src/gitExec.ts`, `resolveWorkspaceConfig` from
  `src/hookPolicy.ts`, `workspaceLocationFromConfig`, `issueRuntimePaths`, and
  `AGENT_EVENT_MAX_BYTES`.
- **State and surfaces.** `mutateAgentLifecycle`, `readAgentLifecycle`,
  `appendJournal`, `renderIssueReport`, doctor's `finding`, and
  `RunLoop.accept()`.
- **Tests and fixtures.** `test/support/workspaceFixture.ts`, plus the
  `product()`/`installOnce()`/`shimEnv()` helpers and the `runGit` harness in
  `test/install.test.ts` ("generated git shim").

Out of scope:
- Hermetic `hook-verify` env, the follow-up named above.
- Containers and custom shells.
- Fixing the harnesses themselves.
- The legacy `scripts/setup_*.sh` guards and comments. `coord install` is the
  supported path, and editing those scripts would be unrelated cleanup.
- Startup refusal of unverified agents. This change warns; refusal can follow
  once all four vendors are measured.

## Tests

The fast suite is `pnpm check:fast`; the coordinator runs `pnpm check`. Each new
case fails on the baseline and passes after the change.

1. `test/install.test.ts` ("generated git shim"): with
   `COORD_GIT_POLICY_CHECK=1` and `COORD_ISSUE=42`, `git status` in the clone
   exits 2. `git log -1` and `git -C <fixture> status` exit 0 without running
   git: there is no stdout, and a marker file a fake real git would write is
   absent. The pinned `git show <40hex>:<path>` exits 0 when the action is
   missing or incomplete and 2 when it is complete.
2. `test/shellGuard.test.ts` holds the shared matrix, with every row asserted
   for all four vendors' decision formats.
   - **Deny rows.** `git status`, `git --no-pager diff`, `/usr/bin/git status`,
     `cd <clone> && git diff`, `bash -lc 'git status'`, `zsh -lc "git diff"`,
     `env FOO=1 git status`, `COORD_GIT_DELEGATE=1 git status`,
     `echo x | git -C . diff`, and an argv-array Codex command
     `["bash","-lc","git status"]`.
   - **Allow rows.**
     - Manual mode: no `COORD_ISSUE`.
     - Wrong repository: `git -C /tmp/fixture status`, `cd /tmp/fixture && git status`.
     - Ordinary git: `git add`, `git commit`, `git push`, `git show HEAD:AGENTS.md`.
     - Text that only mentions git: `echo "git status"`, and `git status` inside a heredoc body.
     - The pinned read when materialization is incomplete.
     - A non-git command.
     - Commands outside static analysis: a dynamic `$GIT status`.
     - Guard failures: a missing shim, and malformed or oversized JSON.
   - Deny output parses as the vendor's documented JSON. Allow output equals
     the prefilter literal. A deny records `hookDenial` and journals
     `containment-guard-denied`.
3. `test/agentHookSync.test.ts`:
   - All four vendor documents contain the guard entry with the right matcher
     shape.
   - An owner `PreToolUse` handler in the same matcher group survives sync and
     uninstall.
   - A second sync reports `changed: false`.
   - Uninstall removes only managed entries.
   - The prefilter command prints the allow literal for a payload without `git`.
4. `test/agentLifecycle.test.ts`: `containmentCoverage` returns `unverified`
   with no probe or after a session change. It returns `hook=active` when a
   denial and a probe share a session, `hook=inactive` when there is a probe and
   no denial, and the shim reading the probe recorded. Old state files without
   `containment` still parse.
5. `test/cli.test.ts`:
   - `containment-probe` run with a PATH whose first `git` is the clone shim
     records `shim=active`. With `/usr/bin` first, the same command records
     `bypassed`. With the shim first but no `COORD_ISSUE`, it records
     `bypassed`.
   - `git-guard` with an internal failure prints the allow response and
     returns 0.
6. `test/issueReport.test.ts`: the status line shows
   `containment hook=… shim=…`.
7. `test/doctor.test.ts`: a missing guard entry produces `lifecycleHooks`, and a
   missing or non-executable shim produces `gitShim`.
8. `test/runLoop.test.ts`: accepting R1.join for an agent with unverified
   coverage journals `containment-coverage` and logs a warning naming the agent.
   With verified coverage there is no warning.

**Real-CLI smoke check.** This is acceptance evidence, not part of the
automated suite. For each of claude, codex, cursor, and antigravity (local AGY
`1.2.16`), start the agent with its real launcher and options. Then let the
R1.join action run both probes through the harness shell tool. Record the
session, CLI version, policy revision, `coord status` coverage, and whether the
denial appeared in the agent. If a vendor cannot enforce the rule, it stays
visibly `unverified` or `inactive`, and the exact capability, version, or
configuration gap is recorded in the PR. Codex project trust is one example.

## Alternatives Rejected

- **Re-prepend PATH only** (launcher, `BASH_ENV`, `.zshenv`). Cursor rebuilds
  PATH after `exec`, and login shells run `path_helper` after `.zshenv`. This
  layer remains a fallback, but it cannot be the enforcement layer.
- **Port the shim policy to TypeScript for the hook.** That leaves two copies of
  the policy, and they drift. The project already removed one duplicated
  template for that reason. Calling the shim from the shim itself would also put
  a Node cold start on every git call, including the test suite's.
- **Copy the legacy `setup_claude.sh` regex guard.** It is broad, it is not
  repository-aware, and the review rejects it as complete enforcement.
- **Route the guard through `coord agent-event`.** That receiver is fail-open
  telemetry by design. Mixing blocking decisions into it changes its contract.
- **Containers or a modified bash/zsh.** These are disproportionate to reducing
  redundant Git reads. They mean images, credentials, and toolchains, or
  maintaining a shell.
- **Probe from `coord doctor` or a separate tmux pane.** That proves the wrong
  process. The probes have to run through the harness shell tool.
- **Refuse unverified agents at start.** This is deferred until all four vendors
  are measured. Refusing now could block issues on a vendor-side gap.

## Risks and Mitigations

- **Vendor payload or response fields differ from the docs or the installed
  version.** This applies to the Codex PreToolUse response shape and to AGY
  session id fields. *Mitigation:* the adapters accept the documented aliases.
  The real-CLI smoke check covers each vendor. A mismatch shows up as
  `hook=inactive` or `unverified` rather than as claimed containment.
- **Hook crashes or timeouts fail open.** *Mitigation:* `git-guard` itself never
  throws to the vendor. The shim stays as a second layer. Per-session coverage
  makes a silent gap visible.
- **False denials in a legitimate verification or another repository.**
  *Mitigation:* the shim's existing repository targeting decides. `cd` and `-C`
  are tracked, and heredoc bodies and quoted text are not commands. Dedicated
  matrix rows cover each case. `pnpm check:fast` runs as a git-spawned child,
  not as a shell-tool command, so it is unaffected.
- **Latency on every shell call.** *Mitigation:* the `/bin/sh` prefilter skips
  Node when the payload has no `git`. The guard makes no model calls and no
  network calls.
- **Static analysis limits** (scripts, `eval`, dynamic words, typing into an
  existing terminal). *Mitigation:* these are allowed by design, and the
  protocol text and doctor state the limits plainly. Already-materialized
  inputs remove the reason to try.
- **COORD_ISSUE missing from a harness's hook env.** *Mitigation:* the guard
  then allows, as the shim does in manual mode. The probe records
  `issueEnv: false` and coverage shows inactive, so the gap is visible and not
  hidden.
- **The R1.join text change shifts the action digest or snapshot tests.**
  *Mitigation:* update the affected expectations in the same commit. Digests
  are computed, not pinned.
- **Probe cost.** It adds two tool calls once per session, inside an existing
  turn, with no extra model calls. It is not repeated for every action.

## Conclusion

The shim stays the single Git policy. A check mode lets the shell-tool hooks of
all four vendors (Claude and Codex `PreToolUse`/`Bash`, Cursor
`beforeShellExecution`, AGY `PreToolUse`/`run_command`) reuse it before a
command runs, whatever PATH the harness builds. The hooks are installed by the
existing `agentHookSync.ts` machinery. Coverage is verified once per session
inside the agent's real shell tool, recorded as hook and shim readings kept
apart, and surfaced through `coord status`, the journal, a join-time warning,
and doctor. The protocol text now describes what is actually enforced.
Hermetic `hook-verify` is a separate follow-up. Required checks:
`pnpm check:fast` before each commit, and the coordinator's `pnpm check` on the
approved commit.

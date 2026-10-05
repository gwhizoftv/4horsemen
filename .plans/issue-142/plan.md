# Issue 142 — observe Git interception in the agent's tool shell

The issue snapshot identifies two independent losses of the launcher PATH
prepend: harness reconstruction and login-shell startup. Keep the existing
shim and its policies, but stop treating installation as evidence that an
agent's commands reach it. Implement the issue's **warning-first** option:
an automated run must visibly name every agent whose interception is inactive
or unverified. A successful probe describes one tool-shell observation, not a
security boundary or a guarantee about all later shells.

## Exact File List to be changed or deleted

No deletions. Change these existing files only:

| File | Necessary change |
| --- | --- |
| `src/cli.ts` | Add the in-session diagnostic command and pass containment observations to status reporting. |
| `src/runLoop.ts` | Include the diagnostic instruction in generated actions; log and journal named-agent warnings and observation changes, including on start/resume. |
| `src/state.ts` | Add a dedicated observational journal event kind, without changing workflow gates, cursor requirements, or artifact schemas. |
| `src/doctor.ts` | Distinguish installed shim wiring from actual tool-shell observations; report inactive or unverified active-issue agents. |
| `src/issueReport.ts` | Render an optional, explicitly time-scoped containment summary per active agent. |
| `src/hookPolicy.ts` | Pass an explicit sanitized environment at the declared-check subprocess boundary. |
| `templates/product/AGENTS.protocol.md` | Describe restrictions as mandatory instructions, conditional shim enforcement, and the narrowly authorized diagnostic exception. |
| `docs/setup-workspace.md` | Document diagnostic usage, warning-first behavior, doctor results, probe limitations, and verification-environment isolation. |
| `test/install.test.ts` | Extend existing generated-shim integration coverage to actual shell resolution and behavioral diagnostics. |
| `test/cli.test.ts` | Cover diagnostic argument/binding validation and clone-local publication. |
| `test/runLoop.test.ts` | Cover action instructions and bounded, durable observation/warning behavior. |
| `test/doctor.test.ts` | Cover installed-versus-observed state, active-issue findings, and unchanged fresh-install success. |
| `test/issueReport.test.ts` | Cover concise per-agent observation output without implying permanent enforcement. |
| `test/verify-config.test.ts` | Exercise the real default verify runner with a contaminated parent environment. |
| `test/agentLanguage.test.ts` | Assert accurate installed guidance and preserve its existing language contracts. |

Do not modify the clone-local AGENTS.md, any githooks/ body, generated
launchers, harness configuration, package versions, dependencies, or lockfiles.
The existing prepend in scripts/lib/launcher.sh remains best-effort and is
not presented as the fix.

## Exact file list to be created

- `src/gitContainment.ts`: one shared diagnostic module for CLI collection and
  coordinator/doctor interpretation. It owns a small bounded observation schema,
  expected-path comparison, probe execution, safe local read/write, freshness
  classification, and formatting primitives. Sharing this logic prevents doctor
  and the run loop from disagreeing about what was measured. No new framework or
  dependency is needed.

The implementation writes a single ignored **runtime** observation at
`<clone>/.coord/git-containment.json`; this is not a tracked product file or a
new workflow artifact. The existing .coord/ clone exclusion already covers it.
This plan is the only coordination artifact published for the present action.

## Reuse and Scope

### 1. Observe the environment that actually executes agent tools

Add `coord probe-git --issue <n> --action <uuid> --resolved-git "$(command -v git)"`.
Generated actions tell the agent to run this from its clone root using its
ordinary shell tool, before product work, without prepending PATH, changing
shell/login options, invoking the shim explicitly, or setting/unsetting the
coordination environment. The command substitution executes in the same shell
the harness supplied, after its initialization. Do not probe in the launcher,
coordinator process, lifecycle hook, or a newly created owner-side shell and
claim that this represents the agent. Do not inject shell text into a busy AI
pane. A pull-mode agent receives the same instruction through its action file.

The CLI resolves the installed clone identity and workspace through
`resolveWorkspaceConfig`, `localConfigGet`, `workspaceLocationFromConfig`,
`issueRuntimePaths`, and `agentRuntimePaths`. Require the supplied issue/action
to match this agent's current action and active roster, and require the
configured clone root to match the caller. Reuse `readAction`, `readStartState`,
`readCursorsState`, `readAgentLifecycle`, and `sha256OfFile` rather than creating
another identity or runtime-discovery system.

Compare the supplied shell resolution with the canonical clone's
`GIT_WRAPPER_RELATIVE_PATH`, and verify that the expected shim is a regular,
executable, managed file using `GIT_WRAPPER_MARKER`. A different executable is
inactive; an empty/non-path resolution, shell alias/function, missing shim,
unreadable state, or unsupported situation is unverified with a concrete reason.
Do not invoke an arbitrary executable supplied by the argument. A matching
resolution alone is insufficient: require the inherited `COORD_ISSUE` to match
and `COORD_GIT_DELEGATE` not to disable interception. Do not repair either value
inside the probe. Repository-redirecting Git environment must not let a probe
silently test some other repository; classify it as unverified instead.

Only after those checks, invoke that matching resolved executable with the
read-only `status --porcelain` diagnostic, in the clone, with the environment
unchanged. Require both the shim's expected exit code 2 and its specific refusal
diagnostic for this issue; exit 0 means inactive, while other errors/timeouts
mean unverified. Bound execution (for example, a two-second timeout and 8 KiB
captured output), discard repository listings, and retain only normalized
diagnostic reasons. The generated instructions explicitly authorize this one
probe, not arbitrary status/diff reconnaissance. Do not change refusal policy.

Write the observation atomically in the ignored clone-local directory, reusing
`containedPath` and `assertNoSymlink` and the existing atomic-write pattern.
Reject symlink/nonregular/oversized observation files. Record only schema version,
canonical clone, agent, issue/session identity, action id and digest, observed
time, lifecycle session id when available, resolved/expected Git paths, normalized
outcome/reason, and probe exit code. Do not persist PATH, credentials, arbitrary
stderr, or shell snapshots. A failed publication prints an explicit diagnostic;
the coordinator then continues to classify the missing observation as unverified.
Exit zero only for a successful sample; document inactive/unverified as nonzero
diagnostic results which do not themselves reject the requested artifact.

### 2. Report uncertainty instead of silently certifying containment

Reuse `buildOrder` to append the probe instruction for both submission modes;
the diagnostic file is separate from published artifact/ballot JSON, and does
not permit a commit during a response-mode action. No changes to
`participationReadyArtifactSchema`, ballot payloads, pins, or approval gates.

On initialization/resume and action preparation, emit a visible, named-agent
warning until there is an applicable observation. In `runTick`, read the bounded
local record without running Git or launching another shell. Match clone,
agent, issue session, action id/digest, and known lifecycle session. Old actions,
changed sessions, malformed records, and missing observations are unverified,
never success. An absent lifecycle session cannot establish session freshness;
show the sample, if present, as uncorrelated rather than certifying the session.
Treat observed session termination/replacement as invalidation. A successful
record is always described as "active when sampled at <time>", not "enforced".
The action/protocol asks for another probe after a harness restart or tool-shell
mode change; nothing here can attest to arbitrary future PATH changes.

Use `appendJournal`/`readJournal` for a dedicated `git-containment-observation`
event containing normalized state and binding, and the run loop's existing log
sink for warnings. Deduplicate by agent, issue/action/session binding, and
normalized observation state, not by polling timestamp. Resume may print the
current warning again but must not append identical journal events indefinitely.
Repeated polling performs no subprocess probes, no extra deliveries, and no
hold/retry-budget mutation. Inactive and unverified states are advisory warnings,
the explicit minimum behavior allowed by this issue, not a new deadlocking gate.

`coord status` and run-loop reports use the shared classifier and the existing
`renderIssueReport` extension point. Doctor checks expected shim installation
for each configured clone and reads observations for active issues belonging to
that exact workspace/config, using existing workspace issue enumeration.
Never substitute doctor's own PATH or a tmux server environment for a tool shell.
Add doctor class `gitContainment` (code 23) for broken shim installation or an
inactive/unverified active-issue observation. With no active issue, show
"installed; tool shell not observed" as informational output, not an error:
`onboard` calls doctor before a harness exists and must still succeed. Preserve
doctor's lowest-finding-code behavior and all existing static checks.

### 3. Isolate declared verification from coordination and Git control state

In `inheritRunner`, construct a fresh environment per command, pass it explicitly
to `spawnSync`, and leave `process.env` untouched. Reuse `hermeticGitEnv` for
repository/config/identity redirectors, then remove `COORD_GIT_DELEGATE` and
`COORD_ISSUE`. Remove generated `.coord/bin` entries from the child's PATH while
preserving all other entries and their ordering. Preserve ordinary toolchain,
HOME, temporary-directory, authentication, and project variables: this is a
narrow control-environment boundary, not a universal allowlist of build inputs.
Keep argv, cwd, inherited stdio, stop-on-first-failure, exit handling, and the
injected `VerifyRunner` contract unchanged. Test execution through the actual
default runner, not merely an injected mock. Do not remove the existing defensive
shim-test environment cleanup or alter hooks to make tests pass.

### Existing support to reuse

Reuse the generated-shim `runGit`/`shimEnv` coverage and install fixtures in
`test/install.test.ts`, `makeProduct`, `ensureBuilt`, `git`, and `passingVerify`
from `test/support/workspaceFixture.ts`, `installed`/`report` in
`test/doctor.test.ts`, `fixture` and injected time/log dependencies in
`test/runLoop.test.ts`, `setup` in `test/cli.test.ts`, and the existing config and
temporary-repository cases in `test/verify-config.test.ts`. Extend these files
instead of introducing a new test harness. Use deterministic fake PATH ordering
to reproduce the failure without depending on a vendor release or the owner's
shell startup files.

## Tests

Add the fewest focused cases by grouping related outcomes in parameterized tests:

1. **Actual resolution and refusal** (`test/install.test.ts`): a tool shell with
   the shim first yields an active sample; the identical PATH entries reordered
   with real Git first yield inactive. A matching path with delegation enabled
   or the issue variable absent cannot pass. Include missing/nonexecutecutable
   shim and timeout/error outcomes in this same diagnostic group. Simulate a
   login startup reorder deterministically; on macOS also run a documented
   smoke check using normal `bash -lc`/`zsh -lc`, recording the observed result
   rather than assuming the owner's dotfiles have any particular behavior.
2. **Publication and binding** (`test/cli.test.ts`): the command run from an
   installed clone publishes only its bounded ignored record, rejects a wrong
   action/clone, and handles unsafe/malformed record paths without writing
   elsewhere. Include a path with spaces. The normal artifact remains unchanged.
3. **Warnings and freshness** (`test/runLoop.test.ts`): new actions contain the
   in-tool-shell instruction in Git and response modes; absent, inactive,
   active-sample, and stale-session/action observations produce correct named
   logs/journal entries. Repeated ticks and a reconstructed loop do not flood
   the journal or send another prompt. Pull mode remains observable; neither
   warnings nor a missing probe change evidence acceptance or workflow gates.
4. **Doctor/status** (`test/doctor.test.ts`, `test/issueReport.test.ts`): a fresh
   install still passes with an explicit not-observed note; active-issue missing
   or bypassed samples produce code 23, an applicable active sample is shown
   with its time, and another workspace's sample cannot certify the agent.
5. **Real verify boundary** (`test/verify-config.test.ts`): parameterize
   precommit/prepush and run a small child through `runVerifyPhase`'s default
   runner. Contaminate the parent with delegation, issue, Git redirector/config
   values, and a generated-shim PATH entry. Assert the child receives none of
   these controls, retains an unrelated sentinel/toolchain PATH entry and cwd,
   returns failures normally, and does not mutate the parent environment.
6. **Guidance** (`test/agentLanguage.test.ts`): installed text still prohibits
   redundant reads without claiming unconditional enforcement, and identifies
   the single probe exception. Existing language and idle-marker tests remain.

Commands already declared in package.json:

- Targeted iteration: `pnpm exec vitest run --config vitest.config.ts test/install.test.ts test/cli.test.ts test/runLoop.test.ts test/doctor.test.ts test/issueReport.test.ts test/verify-config.test.ts test/agentLanguage.test.ts`.
- Before each commit: `pnpm check:fast` (lint, both typechecks, fast suite).
- Before implementation submission: `pnpm check` (build, check:fast, e2e), the
  same full command used for final acceptance.

Inspect the observation file and report in a launched agent after installation
when a harness is available. Do not claim live vendor validation from a fixture
or from the coordinator's shell, and do not require networked vendor sessions
for deterministic automated tests.

## Alternatives Rejected

- Re-prepending PATH, editing login profiles, shell aliases/functions, or
  replacing bash/zsh: each still depends on the harness and does not report a
  silent bypass. Changing vendor harnesses is explicitly outside the issue.
- Containers or removing all other Git executables: disproportionate deployment
  and authentication changes for command-efficiency diagnostics, not a necessary
  fix to observation and check isolation.
- Probing a tmux pane's owner shell, launcher, or lifecycle hook: none establishes
  the PATH the harness later supplies to a tool invocation.
- Accepting `command -v` alone: the correct shim can still delegate because of
  inherited control variables; require the bounded behavioral refusal too.
- A mandatory prelaunch containment gate: the tool shell does not yet exist.
  Warning-first explicitly represents uncertainty and avoids a circular startup
  dependency, while making every unverified agent visible.
- Expanding participation/ballot schemas or adding a new workflow phase: these
  are not needed for advisory observations and would unnecessarily invalidate
  existing evidence and fixtures.
- Patching each test that sees a leaked variable: isolate at the actual verify
  subprocess boundary instead; preserve the already-landed defensive test fix.

## Risks and Mitigations

- **A probe cannot promise future behavior.** Bind observations to the current
  action/session, display their timestamp, invalidate changed bindings, and keep
  instructions mandatory even when enforcement is absent. No claim of tamper-proof
  attestation or of controlling absolute Git invocations.
- **An agent might skip the probe or lack CLI access.** Missing evidence remains
  an explicit named warning in logs, journal, doctor, and status, not success or
  a hidden prerequisite that strands the issue.
- **Extra tool use defeats the efficiency purpose.** One bounded probe per action
  (and on shell/session changes); coordinator polling only reads a small file.
  Do not add periodic injected prompts or repeated Git reads.
- **Untrusted local records or unsafe paths.** Validate bounded schema and
  bindings, reject symlinks, use atomic writes, and retain only normalized data.
  Records are advisory observations, never commit authority or security proof.
- **Doctor breaks initial onboarding.** An absent session before an issue is
  informational; an active automated issue must expose missing evidence as a
  finding. Preserve unrelated doctor codes and workspace ownership checks.
- **Environment cleanup breaks legitimate builds.** Remove only Git redirectors,
  the two coordination controls, and generated shim PATH entries; preserve
  unrelated environment values and verify this with the real subprocess test.
- **Local protocol overlay is protected.** Edit its source template only; let the
  normal installer regenerate clone guidance without clearing skip-worktree.

## Conclusion

Make actual agent-tool-shell interception measurable, make inactive or unknown
interception impossible to mistake for a healthy automated session, and prevent
shim controls from contaminating declared checks. Keep the existing workflow,
shim refusal rules, harnesses, and artifact formats unchanged. This is a bounded
observability and verification-isolation fix, not a promise that PATH is a
security sandbox.

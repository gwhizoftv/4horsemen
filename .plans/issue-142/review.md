# Issue 142 — review of the three bound plans

Reviewed the exported plans at these exact pins:

- Cursor: `c7466372b4fe2f7f268df795e1ebff4018f16ba9`.
- Claude: `b284c84240aefef1f56b23153fec83697fe540d3`.
- Codex: `59c72ee1faaef063b17cbb1692379073b0e950b8`.

The runtime issue snapshot contains the original body but not the issue's
comments. Claude's reference to an owner-account review led me to read the
[owner-account clarification, updated October 5](https://github.com/gwhizoftv/coordination/issues/142#issuecomment-5985772167).
It specifically requests one shared shell-tool policy installed for all four
vendors through the existing hook infrastructure, behavioral verification in
the real tool shell, and revalidation after session/configuration changes.
It defers verification-environment cleanup to a separate follow-up. This matters
to scope: the original body's warning-first option does not eliminate the
clarification's requested enforcement implementation.

## Findings

### 1. [P1] Cursor's proposed interception point does not implement the clarified scope

**Plan claim/section:** Cursor's Exact File List and Conclusion make a tmux
PATH probe plus startup refusal the implementation, and add environment cleanup
and legacy setup-script edits instead of managed shell-tool guards.

**Rule:** The clarified issue calls for the existing normal installer to install
Claude/Codex shell-tool hooks, Cursor's before-shell hook, and AGY's run-command
hook, all using one narrow Git policy. The environment cleanup is a follow-up.

**Concrete failure:** No listed product change installs any of those guards.
An agent whose initial ordinary shell resolves the shim can still later issue
a supported literal login-shell or direct-Git command and avoid interception.
An initially demoted agent is simply excluded rather than receiving the requested
guard. Editing the legacy scripts does not fix the normal coord-install path.

**Smallest correction:** Rebase the design on the existing managed hook installer
and shared policy, and remove the deferred cleanup and unrelated legacy-script
work from this issue's map.

### 2. [P1] Cursor's pane matcher is not evidence of a tool-shell resolution

**Plan claim/section:** The tmux change sends a one-line `command -v git` after
`harnessPromptReadiness`; Risks says to accept any captured line ending in
`/.coord/bin/git`, including lines before the probe result.

**Rule:** Verification must be a fresh result from this agent's actual shell
tool, resolving this clone's exact shim. A ready AI input widget and arbitrary
scrollback are not shell execution or a correlated probe receipt.

**Concrete failure:** The existing readiness helper recognizes vendor chat
prompts, and `TmuxController.nudge` sends text to those widgets, not to a shell
REPL. The proposed line may become another model prompt without producing the
expected shell output, blocking an otherwise healthy agent at startup. Conversely,
an old output line or a peer-clone path ending in `/.coord/bin/git` satisfies the
proposed matcher even when the current shell resolves `/usr/bin/git`. The mocked
capture tests certify precisely that false-positive rule.

**Smallest correction:** Put the probe in the agent's requested work, bind its
actual result to the session and exact clone, and treat absent/unrelated output
as unverified. Do not infer tool execution from a pane suffix match.

### 3. [P1] Cursor's environment cleanup reactivates the refusals inside verification

**Plan claim/section:** The hookPolicy change removes only
`COORD_GIT_DELEGATE`, expressly preserving the rest of the environment; its new
test only asserts the helper's returned keys.

**Rule:** Legitimate declared checks must not become subject to agent-only read
refusals because the verification boundary removed the delegation exemption.

**Concrete failure:** In a shim-active automated session, `git commit` enters
the hook with both the issue variable and the shim-first PATH. Deleting only
the delegation flag leaves both intact. A declared check that invokes
`git status --porcelain` against its own clone now receives the shim's exit 2
instead of the real Git result. The existing wrapper implements exactly this
branch: delegation is tested before the issue restriction. Testing the returned
environment without running a child does not catch the new commit failure.

**Smallest correction:** Defer this work as requested. In its follow-up, test the
actual default verify subprocess with all three controls together, not just a
single-variable helper.

### 4. [P1] Codex's plan also misses the clarified enforcement scope

**Plan claim/section:** Codex's opening scope, Exact File List, and Conclusion
explicitly leave harness configuration unchanged and implement only shim
observations, warnings, and verification-environment isolation. Reuse and Scope
requires another probe for every action.

**Rule:** The clarified issue requires the four managed shell-tool guards and
keeps environment isolation separate; verification should repeat on session or
configuration changes, not every action.

**Concrete failure:** A measured Cursor PATH bypass remains a bypass for every
supported direct Git command; the plan only reports it. None of the approved
files adds the requested hook definitions or shared blocking handler. At the
same time the plan spends implementation and recurring tool-call budget on
explicitly deferred cleanup and per-action probing. This is my own plan's scope
error, not a reason to relax the same requirement for other plans.

**Smallest correction:** Use the clarified four-vendor guard direction and
session/configuration-scoped verification; remove the deferred cleanup from
this issue rather than quietly expanding this plan during implementation.

### 5. [P1] Claude omits the schema file required by both new journal events

**Plan claim/section:** Exact File List and the new shellGuard module require
`containment-coverage` and `containment-guard-denied` journal events. The file map
does not authorize changing `src/state.ts`.

**Rule:** Every emitted journal type must be accepted by `JournalEventInput` and
`journalEventTypeSchema`, and every necessary product edit must be in the
approved file map before implementation.

**Concrete failure:** Both literals are absent from the existing closed enum in
`src/state.ts`. Typed `appendJournal` calls will fail typecheck; casting around
that would still fail its runtime schema parse. In particular, the join-time
append cannot complete as specified. Running `extractApprovedPaths` against the
bound plan confirms that state.ts is not approved, so the implementer cannot fix
this omission without an amendment.

**Smallest correction:** Include `src/state.ts` explicitly and add those two
observational event types without changing the runtime version. Existing
run-loop and guard tests can cover the real schema-backed appends.

### 6. [P1] Claude equates emitting a deny response with the harness enforcing it

**Plan claim/section:** The shellGuard "On deny" path records `hookDenial`
before returning the vendor response. `containmentCoverage` reports hook active
when that record and the resolution probe share a session. The planned probe
record contains shim resolution and issue-env presence, not the result of the
separate attempted shell-tool refusal.

**Rule:** Active hook coverage must mean the harness actually rejected the
expected-refusal tool request. A callback emitting a denial is not proof that
the installed vendor version understood or honored it. The clarification
requires unsupported versions/configurations to remain visibly unverified.

**Concrete failure:** A vendor invokes the handler but ignores an unsupported
deny response shape, then executes the requested `git status` with real Git
first on PATH. The callback has already recorded hookDenial. The following
resolution probe shares its session, so coverage becomes hook=active and
shim=bypassed and the join-time warning is suppressed, although neither layer
blocked the command. The plan's real-CLI smoke check may reveal this discrepancy,
but its specified runtime classifier still reports the opposite result.

**Smallest correction:** Keep "deny emitted" telemetry separate from a
correlated, observed tool-denial result. Require that positive result for
hook=active; if the harness result cannot be obtained, report unverified rather
than upgrading from the callback record alone. Add the emitted-but-ignored case
to the shared coverage/CLI tests.

### 7. [P2] Claude's verification is scheduled once per issue, not per session/configuration

**Plan claim/section:** Only the participation action requests probes; only
accepting that action logs coverage warnings. The classifier compares session
ids but does not compare the saved policy revision or current hook configuration.

**Rule:** Coverage must be invalidated and reverified after restart or relevant
configuration/policy changes, as the issue clarification requires. A prior
observation cannot indefinitely certify a changed guard in the same session.

**Concrete failure:** After participation is accepted, restarting an agent
makes its coverage unverified, but later actions never request the probes and
the sole warning site never executes again. Separately, disabling a hook or
updating its policy while retaining the session id leaves the old denial/probe
pair classified active, even though the current configuration is untested.
Recording a revision without checking it does not solve that stale success.

**Smallest correction:** Bind verified coverage to the relevant session,
configuration/policy revision, and vendor capability evidence, and arrange a
bounded revalidation/warning when that binding changes. Reuse lifecycle/action
delivery machinery; do not add an extra probe to every unchanged action.

## Conclusion

**Revise all three before implementation. Claude is the closest basis for
selection**, because it follows the clarified four-vendor scope and reuses
`agentHookSync`, the shim policy, lifecycle state, and the existing surfaces.
Its dedicated guard module and shared policy-matrix test file have clear
justifications; its real-vendor smoke checks correctly distinguish fixture
coverage from installed-harness evidence. Correct the missing schema-file map,
effective-denial verification, and revalidation lifecycle first.

Cursor reuses existing utilities but its central pane probe is not a reliable
measurement, and its proposed environment change can break declared checks.
Codex has a precise extracted map and useful actual-child tests, but implements
the original body's diagnostic/follow-up direction rather than the clarified
feature. Neither is an acceptable substitute for the requested guards.

All three name the real fast/full check commands. Review inspection included
the baseline shim, hook runner, tmux readiness/delivery, journal schema, and
mechanical approved-path extraction from all three exported plans. No product
implementation or live vendor enforcement has been claimed or tested by this
review. Only this review artifact is submitted.

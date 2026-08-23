# Issue 102 implementation plan

The change will make every delivery decision explainable and will give fresh,
fully-idle lifecycle evidence priority over fallible terminal chrome. The
precedence will be: pane existence/input/process safety and non-interactive
overlays remain hard blockers; a fresh idle Stop for the current delivery may
override stale or ambiguous prompt text; an exact agent-emitted waiting marker
is the next positive signal; existing vendor prompt heuristics are the final
positive signal. Every refusal will carry a stable reason code rather than the
undifferentiated value `busy`.

## Exact File List to be changed or deleted

- `package.json` — bump the pre-1.0 package version from 0.0.17 to 0.0.18 so
  the issue branch satisfies the repository ship gate.
- `src/tmux.ts` — replace the opaque string result from delivery attempts with
  a discriminated outcome containing status, stable reason, decision stage,
  and successful readiness source. Split prompt inspection into a pure,
  testable assessment that distinguishes hard blockers (dead pane, pane mode,
  input disabled, wrong foreground process, trust/account-verification UI)
  from fallible activity/prompt chrome. Recognize the exact waiting marker near
  the live tail of the pane, accept an explicitly supplied fresh-lifecycle-Stop
  authority for overrideable screen refusals, preserve the Antigravity delayed
  recapture, and return a reason from every prelude/text/submit recheck.
- `src/agentLifecycle.ts` — persist the normalized last observation kind and a
  defaulted last-delivery-deferral record without breaking existing version-1
  lifecycle files. Define freshness for a Stop against the current action's
  latest injected/ordered timestamp; allow that fresh Stop to authorize one
  retry even when execution was already idle and the numeric idle epoch did
  not transition; and ensure a successful reinjection moves the timestamp so
  the same Stop cannot be reused. Keep pending input, background work, stale
  sessions, completed actions, and mismatched action identities as suppressors.
  Make deferral recording report whether the reason actually changed so the
  journal can be de-duplicated, and clear the prior deferral on a new action or
  successful send.
- `src/runLoop.ts` — use the structured outcome in initial delivery, ordinary
  idle retry, lost-injection recovery, and corrective reissue paths. Supply
  fresh Stop authority to terminal readiness, log the exact stage/reason and
  lifecycle versus pane source, append a de-duplicated deferral event with the
  action digest and safe structured context, and enrich successful delivery
  events with the readiness source. Never persist captured terminal text.
- `src/state.ts` — add the operator-only `nudge-deferred` journal event type;
  its details will carry reason/stage/source while the existing top-level
  agent and action identity keep it queryable.
- `src/action.ts` — when rendering the completion contract, require an agent
  whose re-read finds no replacement action to end its response with the exact
  standalone line `Waiting for the next coordinator action.`; retain immediate
  execution when the action UUID changed.
- `templates/product/AGENTS.protocol.md` — mirror the exact waiting-line
  contract in the installed clone protocol so resumed and already-prepared
  work has the same rule as newly rendered actions.
- `docs/coord-driver.md` — document readiness precedence, the difference
  between hard pane/UI blockers and overrideable screen heuristics, the
  one-use fresh-Stop rule, the waiting marker, and the reason-coded/de-duplicated
  journal and verbose output.
- `test/tmux.test.ts` — update result assertions for the discriminated outcome
  and cover every hard/overrideable reason, marker detection, fresh-Stop
  override, delayed Antigravity recapture, and per-key safety rechecks.
- `test/agentLifecycle.test.ts` — cover backward-compatible defaults, a fresh
  Stop after injection while the execution state was already idle, rejection
  of stale/duplicate Stop evidence after reinjection, continued pending and
  background suppression, and deferral-reason de-duplication/reset.
- `test/runLoop.test.ts` — assert exact verbose and journal rationale for the
  initial and retry paths, one event for a repeated identical refusal, a new
  event when the refusal reason changes, successful delivery source details,
  and delivery when a fresh Stop contradicts stale busy chrome without
  bypassing a hard safety blocker.
- `test/state.test.ts` — prove the new reason-coded journal event validates and
  round-trips while malformed event identities remain rejected.
- `test/action.test.ts` — assert rendered actions contain the exact standalone
  waiting line and retain the changed-action re-read instruction and
  agent-facing vocabulary boundary.
- `test/install.test.ts` — assert the managed protocol installed into a product
  clone contains the same exact waiting-line contract without changing human
  text outside the managed block.

No files will be deleted.

## Exact file list to be created

None. The implementation extends the existing lifecycle, terminal, run-loop,
journal, protocol-template, documentation, and test files only.

## Tests

1. Run the focused fast tests while iterating:
   `pnpm exec vitest run --config vitest.config.ts test/tmux.test.ts test/agentLifecycle.test.ts test/runLoop.test.ts test/state.test.ts test/action.test.ts test/install.test.ts`.
2. In terminal tests, verify pane mode, disabled input, dead panes, foreground
   mismatches, trust UI, and account verification remain non-overrideable and
   expose distinct reasons; verify a current fresh Stop overrides only stale or
   ambiguous activity/prompt chrome; verify the exact near-tail waiting marker
   is positive only when no live activity/hard blocker is present.
3. In lifecycle and run-loop tests, start from an injected action whose entry is
   already idle, observe a fully-idle Stop after the injection timestamp, and
   prove exactly one resend occurs. Re-run without a new Stop to prove the
   evidence is consumed by the new injection timestamp. Repeat with pending
   input/background work and with a stale session to prove there is no send.
4. Exercise a persistent refusal for multiple ticks and assert one
   `nudge-deferred` record for the unchanged stage/reason, then change the pane
   condition and assert a second record with the new rationale. Assert
   successful `nudged` records identify whether readiness came from the vendor
   prompt, the waiting marker, or lifecycle Stop, and assert no captured pane
   content is written.
5. Run `pnpm check:fast` before the implementation commit (lint, typecheck, and
   all fast tests, including the version-bump gate).
6. Run `pnpm check` for final verification (build, fast checks, and e2e), which
   is the coordinator's declared acceptance gate.

## Alternatives Rejected

- Timer-based repeated sends are rejected because elapsed time cannot
  distinguish a lost prompt from a long-running turn and would reintroduce
  duplicate instructions.
- Keeping `busy` as a boolean/string and adding prose only in the run loop is
  rejected because the terminal layer would still discard the actual refusal
  cause, making journal details guessed rather than authoritative.
- Treating pane scraping as the sole authority is rejected because transient
  vendor chrome is exactly the false-negative source reported by the issue.
- Letting every Stop bypass every check is rejected because stale sessions,
  queued/background work, copy mode, disabled input, a replaced harness, and
  non-interactive verification/trust overlays can still drop or misroute keys.
- Journaling raw pane captures is rejected because it is noisy and can contain
  repository data or model output; stable reason codes and bounded metadata are
  sufficient for diagnosis.
- Appending the same refusal every polling tick is rejected because it would
  flood the journal. Persisting the last reason and journaling only its first
  occurrence or a transition preserves the useful history.
- Relying only on the new waiting sentence is rejected because old or scrolled
  output can linger. It is an additional positive hint, while lifecycle
  freshness and live hard-blocker checks remain authoritative.

## Risks and Mitigations

- A delayed duplicate Stop could otherwise authorize repeated sends. Compare
  its observation timestamp to the current injection timestamp, retain session
  checks, and advance the injection timestamp on every successful send so one
  observation is usable once.
- A stale waiting line may remain in the capture buffer. Match only the exact
  standalone marker near the live tail and evaluate live activity and hard
  blockers before accepting it.
- Overriding screen activity could type into a genuinely active turn. Permit
  the override only for healthy, fully-idle current-session evidence observed
  after the current delivery, with no queued input/background activity, and
  never override pane/input/process or trust/verification barriers.
- Adding strict lifecycle fields could strand runtimes created by the current
  release. Give both new fields schema defaults and test parsing an old
  version-1 fixture; no runtime format bump is needed.
- Reason transitions could still create excess state churn. Do not mutate or
  journal when agent, action, stage, and reason equal the persisted deferral;
  clear it only when a new action or successful send establishes a new attempt.
- Agent-facing wording could leak internal delivery vocabulary. Use the neutral
  exact waiting sentence and keep the existing action/protocol language scans
  passing.

## Conclusion

The implementation will make delivery decisions auditable, retry a current
action once when fresh Stop evidence proves the prior turn is idle even if the
screen is stale, retain the safety checks that prevent lost keystrokes, and
give terminal inspection a deterministic agent-emitted waiting hint. Focused
tests plus the repository's fast and full gates will lock down the precedence,
one-use freshness, journaling, messaging, compatibility, and safety behavior.

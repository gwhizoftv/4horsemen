# Issue 181 — review of bound plans

Reviewed inputs:

- Claude: `e5799ab1db49b0bb61d8d333b1c515c4d378a50a`
- Cursor: `849745d7cee1911d5ce7f0d5d12d87a2de3e39c8`
- Codex: `ea32c444439647a453ad05ebd45ea135a5237dce`
- Antigravity: `9fa11cb87b296c072d853f13b218897c25231b55`

The coordinator-exported bound plan copies were read directly. Source references
below describe the inspected baseline implementation, not implemented changes.

## Findings

### 1. [P1] Antigravity: an omitted `fullyIdle` field must not clear known background work

**Plan claim/section:** Antigravity's Reuse and Scope item 3, Tests item 2
(plan lines 41–42), and Risks item 3 require a Stop without `fullyIdle` to
normalize to `backgroundActive: false, allowInjectedIdle: true`, while claiming
task telemetry will still protect background work.

**Rule:** Missing vendor evidence is not positive proof that background tasks
have ended or that an injected, uncorrelated action has finished. In particular,
a Stop without that evidence must not erase a previously observed background
task merely because the field is absent.

**Concrete failure:** Start with an Antigravity status reporting
`pending_input_count: 0, task_count: 1`. The current normalizer records
`backgroundActive: true` (`src/agentEvent.ts:199–218`). Under this plan, a
subsequent same-session Stop lacking `fullyIdle` supplies `backgroundActive:
false`; `applyLifecycleObservation` uses that supplied value instead of the
previous one. Its injected-action guard is also disabled by
`allowInjectedIdle: true` (`src/agentLifecycle.ts:655–672`). Execution becomes
idle and `decideLifecycleNudge` can authorize another send while the task is
still running. A later status callback cannot prevent the intervening unsafe
send. The proposed mitigation therefore does not preserve its stated rule.

Smallest correction: remove this lifecycle-default change from the issue. The
incident journal already shows the cited Antigravity review accepted and the
agent returning to idle. If omitted-field support is independently necessary,
it needs an evidence-backed contract and a sequence test preserving prior
background/queue evidence, not a test that equates omission with `true`.

### 2. [P1] Cursor: the observed footer rejection remains unfixed

**Plan claim/section:** Cursor's Exact File List entry for `src/tmux.ts`
(plan lines 13–19), Tests items 1–2, and Conclusion attribute the Codex refusal
to timing decoration and a wrapped placeholder. No change admits the observed
`← for agents · ? for shortcuts` footer.

**Rule:** The implementation must recognize the actual idle pane from the
reported failure, including all of its footer lines, while retaining the
empty-composer requirement.

**Concrete failure:** Give Codex a valid ready receipt, a single-line dim empty
composer, the existing `Context N% left` footer, and the observed
`← for agents · ? for shortcuts` line. Even after the proposed timing and
wrapped-placeholder fixes, the unchanged `CODEX_FOOTER` rejects the last line;
`codexTail(..., false)` returns null at `src/tmux.ts:185–189` and the ready-file
send still returns `codex-composer-not-ready`. No lifecycle relaxation repairs
this rejection. The plan's “known footer” fixture misses the actual stall.

Smallest correction: explicitly add the anchored agents/shortcuts footer form
and exercise it in the existing ready-file and sentinel per-key send tests.
The observed single-line composer is sufficient to reproduce the issue.

### 3. [P1] Cursor: extending only the lifecycle gate does not enforce terminal proof for `unknown`

**Plan claim/section:** Cursor's `src/runLoop.ts` file-map entry
(plan lines 20–23) specifies extending the `neverSentWorking` gate so unknown
execution reaches `deliver()`, where file/terminal proof is expected to be
attempted. Tests item 4 requires a no-proof case to remain deferred.

**Rule:** A newly admitted unknown-lifecycle send without a valid ready receipt
must require positive idle proof and retain the same per-key composer/lifecycle
revalidation as the stale-working override. Passing an earlier gate is not
itself that proof.

**Concrete failure:** With unknown execution, a never-sent ordered action, no
ready receipt, and an owner draft visible in an otherwise quiet Codex composer,
the specified `neverSentWorking` extension allows the retry through
`maybeLifecycleNudge`. But `deliver` still computes `staleWorking` only for
`execution === "working"` (`src/runLoop.ts:1176–1178`); with neither a receipt
nor an owner reminder, `staleOverride` remains undefined at lines 1188–1201.
Ordinary Codex readiness does not reject a draft, and the override-only
composer/per-key checks in `TmuxController.nudge` do not run. The coordinator
can append and submit the action into the owner's draft rather than satisfying
the plan's no-proof-waits requirement.

Smallest correction: omit this unneeded policy expansion for the observed
ready-file bug. Valid ready-file proof already bypasses the unknown wait via
`fileReady` at `src/runLoop.ts:1819–1820`, and existing readiness tests include
an unknown-execution case. If the expansion is retained, explicitly pair both
gates with a proof-required override and test missing proof, owner drafts, and
proof changes between keys.

### 4. [P2] Claude: the summary-above-sentinel test has the wrong expected result

**Plan claim/section:** Claude's Tests item 3 (plan lines 148–152) groups a
summary line *above* the sentinel among guards that must return
`vendor-prompt`.

**Rule:** With no live-turn or dialog veto, a current sentinel followed only by
an empty composer and recognized footer remains valid even if older transcript
content precedes that sentinel. The proposed change must preserve that existing
behavior.

**Concrete failure:** A pane containing `Worked for 12s`, then the latest
`COORD-IDLE` sentinel, then an empty `›` composer and legacy shortcuts footer
already returns `idle-sentinel`. `linesAfterCodexSentinel` intentionally slices
away the earlier summary. The planned helper change preserves that result, so
the mandated new test fails against the otherwise-correct implementation.
Changing production code to meet this assertion would instead suppress valid
sentinel-based deliveries whenever an earlier summary remains in scrollback.

Smallest correction: expect `idle-sentinel` for that ordering; keep
`vendor-prompt` for unrecognized content after the latest sentinel. If the
intended case has an additional blocker, specify it explicitly in the fixture.

### Scope, reuse, and verification assessment

- **Claude:** The product change is tightly scoped to shared parser inputs;
  updating `docs/readiness-policy.md` is directly justified. The existing
  stateful nudge fixture covers both proof sources and early acceptance with
  very little new support. Correct finding 4; the core design addresses the
  observed failure without changing lifecycle policy.
- **Codex:** No blocking finding. One product file and two existing test files;
  the controlled-clock/acceptance helpers are reused, and the added run-loop
  regression checks delivery across restart and an accepted peer waiting for
  Codex. No new product files, dependencies, or abstractions are proposed.
- **Cursor:** Reuses existing helpers, but its broader wrapped-placeholder and
  multi-vendor policy work is not needed to reproduce the observed footer
  failure. Resolve findings 2–3 and narrow the change. Also name the actual
  focused test commands rather than only saying to run the suites above.
- **Antigravity:** Correctly identifies both Codex layout differences and
  reuses existing tests, but the unsafe lifecycle default and additional
  logging change expand beyond the demonstrated delivery defect. Remove the
  unsafe default; any retained logging work must stay diagnostic-only. Name
  executable focused verification commands in the revised plan.

No product suite was run for this evidence-only plan review. Findings are
supported by the bound plans and the inspected parser, lifecycle, run-loop, and
existing test code; they are not claims of executed failing tests or coordinator
verification results.

## Conclusion

Prefer the narrow Codex parser fix shared by Claude and Codex. Codex's bound plan
is implementable as written; Claude's core approach is also sound after fixing
the contradictory test expectation. Cursor and Antigravity require revision
before selection: the former misses the actual footer and leaves a proof-gating
gap, while the latter can manufacture idle evidence from an omitted field.

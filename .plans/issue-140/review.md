# Issue 140 plan review

Protocol version: 1. Action: `73ecb287-04dc-4230-b939-01edd8f911bc`.

Reviewed the coordinator-exported plans against the saved issue-140 requirements and the existing runtime:

- Cursor: `76116be8f36c46d59c4558f704216bacb4e2b087`.
- Codex: `834e74bf431c9b12adf5706233181eb8b47b0658`.
- Claude: `301e148296e001b97191b7e3a97e5fc98a8323f4`.

## Findings

### 1. [P1] Claude: native lifecycle boundaries are not fresh capacity evidence

**Plan claim:** `src/runLoop.ts` / “Claude recheck,” `claudeReleaseDecision`, and tests 3/10 authorize release after a same-session `stopped` or `prompt-submitted` boundary following the reset, provided no newer failure or post-reset exhausted telemetry contradicts it.

**Required rule:** Automatic release requires fresh matching evidence clearing the resource; ordinary Stop, native activity, and statusline renders do not prove capacity. Missing evidence must not count as clearance, and native cancellation/exhaustion cannot transfer retry ownership.

**Concrete failure:** After an exhausted window's deadline, the user submits a prompt in the same session before any fresh capacity response arrives. The failure precedes that boundary and there is no post-reset telemetry, so all listed conditions permit release while the resource remains unverified. The next ordinary delivery path can resume without the required proof. A later render of cached below-limit data is not sufficient either. Retain owner recovery unless a validated fresh-capacity signal exists; replace the positive native-Stop release test with a non-release regression.

### 2. [P1] Claude: the explicit Codex clearance predicate admits missing blockers

**Plan claim:** `codexProbe()` declares a read clear when `ordinaryUsageAllowed === true`, no returned bucket has a reached type or window at 100, and `spendControlReached !== true`; `parseCodexLimits()` maps missing/ill-typed fields to null.

**Required rule:** Every previously applicable blocked bucket/window must have affirmative fresh clearance. Null, omitted, malformed, or conflicting evidence cannot clear a hold. This rule must be enforced by the concrete predicate, not only the general statement that null never counts as clear.

**Concrete failure:** A previously exhausted weekly bucket disappears from a later response with `ordinaryUsageAllowed: true`, while the remaining bucket is below 100. The listed negative checks all pass; similarly null spend-control data passes `!== true`. The algorithm releases without proving the prior weekly restriction cleared. Compare against the persisted blocker set, validate completeness and compatibility-view consistency, and add missing-prior-bucket/null-field non-release cases.

### 3. [P1] Claude: observation maintenance is unreachable through the normal held runner

**Plan claim:** Recovery runs on the existing `runTick` cadence by adding `maintainResourceHolds()` before its paused return; reuse includes unchanged `authority()` checks after awaits. The listed loop tests repeatedly invoke ticks.

**Required rule:** A held issue must actually reach its authorized deadline observations through `run()`, including after restart, without enabling ordinary paused workflow effects.

**Concrete failure:** Existing `src/runLoop.ts:2444` returns from `run()` immediately for a paused issue, and `:2452` exits as soon as a tick creates a hold. Neither path reaches the new deadline maintenance. Furthermore, existing `authority()` at `:854` rejects every paused state, so using it unchanged to authorize a held observation/release also rejects the intended operation. Add a narrowly fenced observation-only runner path, keeping initialization/delivery effects blocked, and exercise `run()` from both newly held and restarted-held states. Do not relax the ordinary effect fence globally.

### 4. [P1] Claude: elapsed reservation age cannot prove a helper was reaped

**Plan claim:** `src/codexLimits.ts` treats an in-flight marker older than timeout plus five seconds as ended. “Probe storms across ticks, restarts or issues” also accepts separate per-root throttles for the same binding as a residual limitation.

**Required rule:** There must be at most one live helper per account/home binding and one start per five minutes. Restart must not infer successful termination from elapsed time, and multiple runtime roots cannot silently weaken this hard cap.

**Concrete failure:** The coordinator dies after spawning a hung helper, before its timer kills/reaps it. On restart the marker ages out; after the cooldown a second helper starts while the first remains alive. Two independently managed roots can also launch simultaneously because their records are disjoint. Keep uncertain orphan reservations owner-only unless termination is proved, and require exclusive binding ownership or disable observation for unsupported shared-root arrangements. Test crash-after-spawn with an unreaped child, not only cursor restart.

### 5. [P2] Claude: ordinary owner release replenishes an unresolved action's probe budget

**Plan claim:** The `src/state.ts` changes reset `probe` to zero in `releaseHold`; “An owner release begins a new episode.”

**Required rule:** The six-start cap covers the unresolved action/hold episode, across detection and deadline checks. Acknowledging a hold does not itself finish or replace the action.

**Concrete failure:** An action consumes six starts, the owner acknowledges its hold without changing the action, and the next observation of the same failure gains six more starts. The unchanged unresolved work therefore exceeds the stated cap. Preserve its probe accounting across acknowledgment; use genuinely new work as the episode boundary rather than hold removal/recreation.

### 6. [P2] Claude: directly parameterizing the existing shell tee loses owner input bytes

**Plan claim:** Generalize `renderStatusLineWrapper` and asynchronously pipe the “same bytes” to the downstream command; the shell wrapper is explicitly preferred over a Node-based tee.

**Required rule:** The Claude tee must preserve the owner's stdin and resulting output while bounding observation work.

**Concrete failure:** Existing `src/agentHookSync.ts:320` captures input with `payload="$(cat)"`, which removes trailing newlines; the subsequent `printf '%s'` cannot restore them. Parameterizing that implementation changes the input to a newline-sensitive owner command and therefore its output. Its unbounded per-render background receiver also lacks a bound when input/receiver execution stalls. Reuse the ownership machinery, but specify a byte-preserving bounded forwarding implementation; test trailing newlines and a stalled receiver, not only a normal JSON fixture's stdout.

### Scope, reuse, and test assessment

- **Cursor:** No blocking finding. The plan stays within vendor evidence/recovery, names the existing state/loop/lifecycle/ownership primitives, justifies its two modules and two focused test files, and preserves conservative freshness and ownership requirements. Its implementation must honor its stated `run` reuse and held-observation policy through both runner entry points, and realize its per-binding caps across concurrent issues rather than only within one cursor file. Those are acceptance checks, not permission to broaden scope.
- **Codex:** No blocking finding. The extra paths/doctor/CLI changes have specific containment, ownership-diagnostic, and byte-forwarding purposes; the new modules have separate policy, subprocess, and tee boundaries. Tests predominantly extend existing fixtures, with one new adapter test file. The explicit observation-only runner, blocker completeness, durable reservation, and conservative Claude non-release rules address the failures above. Keep implementation to those enumerated responsibilities rather than introducing a provider framework.
- **Claude:** The two policy/I/O modules and version-pinned sanitized fixture are justified, and the test extensions reuse existing support. However, its positive native-release tests encode an unsafe result, and tick-only recovery tests miss the production entry point. Generalizing the working Antigravity wrapper is unnecessary scope if only Claude needs different forwarding semantics; preserve Antigravity behavior. The listed findings require policy/test changes before implementation, not merely additional prose asserting fail-closed behavior.

### Review verification

Ran `pnpm check:fast` twice: lint and typecheck passed both times; each full fast-test run finished with 569 passing tests and the same existing `test/onboard.test.ts:68` happy-path test exceeding its 15-second timeout, plus Vitest worker `onTaskUpdate` timeouts. The isolated unchanged command `pnpm exec vitest run --config vitest.config.ts test/onboard.test.ts` then passed all five tests (the affected case took about six seconds). No product code, test limits, hooks, or verification configuration were changed. The full suite is not claimed green.

## Conclusion

Request changes to Claude's plan at `301e148296e001b97191b7e3a97e5fc98a8323f4`. Cursor's `76116be8f36c46d59c4558f704216bacb4e2b087` and Codex's `834e74bf431c9b12adf5706233181eb8b47b0658` are acceptable planning bases; Codex gives the most explicit treatment of held-run execution and conservative recovery boundaries. This review validates plan/source reasoning only, not live vendor recovery behavior.

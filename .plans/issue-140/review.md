# Issue 140 — plan review

Reviewed bound plans:

- cursor `76116be8f36c46d59c4558f704216bacb4e2b087`
- codex `834e74bf431c9b12adf5706233181eb8b47b0658`
- claude `301e148296e001b97191b7e3a97e5fc98a8323f4`

Authority: GitHub issue #140 (vendor evidence + recheck-before-release on top of #126). Protocol version 1.

## Findings

1. **claude `301e1482` — Claude recheck / `claudeReleaseDecision`.** The plan releases a `usage-window` hold when, after `resetsAt + 30s`, the same session shows a non-failure lifecycle boundary (`stopped` / `prompt-submitted`) and post-reset `claudeRateLimits` are below 100. Issue #140 Claude items 6–7 require a one-shot evidence re-evaluation at the exact deadline plus 30 seconds, treat a new statusline render as not proof of newly fetched capacity, and forbid native activity from defeating other pauses or authorizing unproved recovery. Following the plan as written would auto-release on native Stop plus a re-rendered statusline below 100 without an independently validated fresh-capacity signal, so unproved Claude recovery ships enabled. Smallest correction: keep the deadline+30s cache re-evaluation, and retain owner release for Claude unless a separately defined, tested fresh-capacity signal exists (codex `834e74bf` already states this fence).

2. **claude `301e1482` — Exact file list / `src/agentHookSync.ts`.** The plan generalizes the Antigravity status-line multiplexer into a vendor-parameterized form so Claude can share it. Issue #140 leaves Antigravity on #126’s vendor-independent path and requires an ownership-preserving Claude tee without Antigravity quota work. Refactoring the live Antigravity install/remove/wrapper path to add Claude can change quoting, stream handling, or uninstall semantics for Antigravity clones even when only Claude telemetry is intended. Smallest correction: add a Claude-specific tee that reuses ownership/manifest patterns without rewriting `syncAntigravityStatusLine` / `removeAntigravityStatusLine` behavior (cursor `76116be8` and codex `834e74bf`).

3. **claude `301e1482` — `src/codexLimits.ts` per-binding throttle.** A stale in-flight marker older than helper timeout + 5s is treated as ended so another start may proceed. Hard observation caps require one helper in flight per binding and terminate/reap on every exit path; an unreaped child must not authorize a second spawn. An aged marker over a still-running helper would start a second App Server against the same home/account, breaking the one-in-flight cap and risking overlapping probes. Smallest correction: unresolved/orphan in-flight reservations stay owner-only until the child is proved reaped (codex `834e74bf`).

4. **cursor `76116be8` — Claude statusline tee (“mirror Antigravity pattern”).** The plan tells implementers to mirror the Antigravity statusline ownership pattern for Claude stdin/stdout. Issue #140 requires an ownership-preserving tee that retains the owner’s effective command and stdin/stdout; the live Antigravity wrapper uses `payload="$(cat)"` (`src/agentHookSync.ts`), which drops trailing newlines and is not byte-exact. Copying that wrapper for Claude fails owner byte preservation and the acceptance tee tests. Smallest correction: reuse manifest/precedence/uninstall ownership only; forward stdin with a byte-exact path, and do not copy the `$(cat)` wrapper (codex `834e74bf` already rejects it).

5. **cursor `76116be8` — Claude behavioral scope / recovery.** The plan requires a single recheck at epoch+30s and states that a statusline render is not fresh capacity, but it never defines the Claude clearance predicate (clear vs retain-for-owner). A plan that promises recheck-before-release must state when automatic release is allowed so implementation cannot invent a signal. Without that rule, “recheck” can become release on any post-deadline Stop, render, or omitted expired window. Smallest correction: state explicitly that Claude automatic release stays disabled / owner-only unless an independently validated fresh-capacity signal is named and tested (align with codex `834e74bf`).

6. **cursor `76116be8` — Codex probe caps / file list.** Behavioral scope requires one helper in flight per account/home and coalesced triggers, but the change list only persists probe budgets in `cursors` / hold episode state and does not add a binding-keyed exclusion across concurrent issues in the same owner runtime. Two issues sharing one `CODEX_HOME` can each see a free in-flight slot in their own cursors and start overlapping helpers, violating the per-binding cap. Smallest correction: add a binding-keyed runtime lock/throttle under existing path-containment helpers (codex `834e74bf` `src/paths.ts`, or claude `301e1482`’s per-binding file with the orphan-reap fix from finding 3).

7. **codex `834e74bf` — Documentation target (`README.md`).** The plan documents binding, tee ownership, caps, and disabled recovery in `README.md` only. #126 left the operator-facing “no automatic recovery / deferred to #140” gap in `docs/coord-driver.md`, and issue acceptance expects that gap to be replaced with the real #140 policy. Shipping README-only docs leaves `docs/coord-driver.md` still denying automatic recovery after the feature lands. Smallest correction: update `docs/coord-driver.md` for classification, deadline rechecks, probe caps, and ownership limits; keep README changes only if they stay consistent with that driver doc.

## Conclusion

All three plans correctly keep #126 loop-prevention, pause ownership, and nudge budgets in place, stay inside the vendor-evidence follow-up, justify new modules, and aim at focused Vitest coverage with `pnpm check:fast` / `pnpm check` and no ordinary version bump.

**codex `834e74bf`** is the only plan that already fences Claude automatic release to owner-unless-proved, rejects the Antigravity `$(cat)` tee for byte-exact Claude forwarding, adds cross-issue binding exclusion, and defines a narrower resource-only release that must not call owner `releaseHold`. Fix finding 7 (document in `docs/coord-driver.md`) and it is the safest base.

**cursor `76116be8`** matches issue taxonomy and caps at a high level and reuses the right #126 surfaces, but is not implementable as written until findings 4–6 are fixed (tee bytes, Claude clearance rule, binding exclusion).

**claude `301e1482`** has the most concrete schemas and fake-clock cases, but findings 1–3 are ship-blocking: unsafe Claude auto-release, Antigravity multiplexer generalization, and stale in-flight reuse. Do not implement that recovery or throttle rule as written.

# Issue 235 — plan review (cursor)

Reviewed bound plans:

- cursor `f372678b802f7b8cba21e5d325ee15f7132244bf`
- codex `ae92f75414b10cc9863c28688ba7336b741fb2da`
- claude `4aefc91e7638ee270c8b4d86da4db867f899dc1b`

Scope check: all three stay inside issue 235 (default Muse roster, `delivery: "both"`, terminal adapter, doctor capability without lifecycle hooks, ready/complete handoffs). None require new product modules; tests extend existing files (codex also extends `test/integration.test.ts`). Claude alone lands measured Muse 1.4.10 pane facts that the other two still treat as open measurement work.

## Findings

1. **cursor `f372678b` — Exact File List / `src/tmux.ts` (new `PromptBlockedReason` members) without `src/runLoop.ts`.**
   Rule: every automatic-delivery refusal code used in journals must have an entry in `DEFERRAL_RATIONALE` (`src/runLoop.ts`); unknown codes fall through to generic text and can hit `unrecognized-overflow` after repeated deferrals.
   Failure if followed as written: Muse-specific reasons such as `muse-turn-chrome` / `muse-composer-not-ready` are emitted from `tmux.ts` but never mapped, so operators see opaque "the terminal refused delivery" / unrecognized-overflow suppression instead of actionable Muse deferral text.
   Smallest correction: list `src/runLoop.ts` and add `DEFERRAL_RATIONALE` lines for each new Muse reason (as in claude `4aefc91e`).

2. **cursor `f372678b` — Exact File List / `src/tmux.ts` (`resolveNudgeKeys` “never introduce Escape”) and Tests item 4.**
   Rule: Muse Escape interrupts a turn; configured or stale `nudgeSubmit: ["Escape","Enter"]` must be repaired to Enter-only before any automatic or owner key batch (same class of repair Antigravity already has in `resolveNudgeKeys`).
   Failure if followed as written: the plan only asserts defaults and “never introduce Escape,” but today's Muse path still returns a hand-written `["Escape","Enter"]` unchanged (the Antigravity downgrade is id-gated). A migrated or edited Muse config would interrupt in-flight turns on every nudge.
   Smallest correction: explicitly extend the Escape+Enter→Enter downgrade to `muse` and test that case (claude `4aefc91e` Tests §1 last bullet).

3. **cursor `f372678b` and claude `4aefc91e` — Reuse / `pendingPromptInComposer` for Muse submit-only recovery.**
   Rule: submit-only is allowed only when the live composer holds the current coordinator prompt for this action; an action UUID appearing in an owner draft or history must not authorize Enter.
   Failure if followed as written: both plans reuse `pendingPromptInComposer`'s actionId-substring check. An owner draft that quotes the owed action id (or a wrapped UUID fragment) makes `proofRefusal` treat the pane as pending and sends Enter on a non-coordinator draft.
   Smallest correction: for Muse, require normalized composer text to match the rendered nudge (action id + digest + path / resend prefix) as specified in codex `ae92f754` Reuse step 2; keep other agents' UUID-tail semantics unchanged.

4. **cursor `f372678b` — Exact File List / `src/tmux.ts` readiness sketch vs measured Muse chrome (claude `4aefc91e` Summary).**
   Rule: Muse keeps an empty `❯` composer while a turn runs and paints `(… esc to interrupt)` status above it; composer visibility is not readiness, and Enter mid-turn steers the active turn.
   Failure if followed as written: the cursor plan says to “block on measured in-flight chrome” and optionally extend `COMPOSER_LINE`, but does not require fail-closed parsing when the `❯` + pure-`─` + footer tail is absent, nor that Muse must stay outside the Codex/Cursor “Enter-only during turn chrome” allowance if an implementer reuses those reason strings. A composer-only or `default: ready()`-shaped adapter would steer actions into live turns.
   Smallest correction: adopt the measured contract in claude `4aefc91e` (`muse-bin-*` alias, `museTurnChrome`, `museComposer` null → `muse-no-prompt`, Muse excluded from mid-turn Enter bypass).

5. **codex `ae92f754` — Exact File List / `src/doctor.ts` (“small informational field to `DoctorReport`”).**
   Rule: doctor changes for this issue must make Muse+`both` nonfatal without pretending lifecycle hooks exist, while preserving fatal findings for unsupported custom ids; avoid new report schema unless necessary for that outcome.
   Failure if followed as written: `DoctorReport` today is only `{ configPath, findings, exitCode }`. Adding a first-class informational field forces `renderDoctorReport`, onboard printing, and doctor tests to grow an API surface that is not required to clear exit 20—absent hooks are already visible via lifecycle inspection/`coord status` unverified coverage.
   Smallest correction: Muse-specific (or terminal-adapter) exemption from the unsupported-mapping finding only; put operator-facing “no hooks/transcript” prose in `docs/setup-workspace.md` / readiness docs, not a new `DoctorReport` field.

6. **codex `ae92f754` — Exact File List / `src/tmux.ts` (“composer protection … explicit Muse reminders”).**
   Rule: `TmuxController.remind` is an explicit owner instruction that intentionally skips automatic readiness policy (source comment at the remind entrypoint); automatic `nudge` owns draft/busy gates.
   Failure if followed as written: gating Muse `remind` on the same busy/draft rules makes owner recovery (`n` / remind) fail closed during a draft or turn while other agents still deliver owner text, contradicting the existing remind contract and Claude's documented “owner reminder bypasses false busy” recovery path.
   Smallest correction: apply draft/busy/pending-prompt gates to automatic `nudge` (and Muse pre-send recapture) only; leave `remind` on resolveNudgeKeys + transport unless a separate, tested Muse remind policy is justified as in-scope.

7. **codex `ae92f754` — Exact File List / `src/runLoop.ts` (“narrowly required connection to delivery/watchdog paths”).**
   Rule: implementation discipline — only mapped file edits that are necessary; ready/complete, budgets, and watchdog already authorize hookless agents.
   Failure if followed as written: the open-ended “any narrowly required connection” license can expand into delivery/watchdog logic changes beyond rationale text, without a concrete failing behavior named in the plan.
   Smallest correction: limit `runLoop.ts` to `DEFERRAL_RATIONALE` (and any journal string maps) for new Muse refusal codes, matching claude `4aefc91e`.

8. **claude `4aefc91e` — Exact File List / `src/setupWorkspace.ts` (`hasTerminalDeliveryAdapter`) + doctor coupling.**
   Rule: automatic-delivery exemption from the unsupported-lifecycle finding must stay aligned with an actual `harnessPromptReadiness` / nudge adapter; unsupported custom ids must still fail doctor.
   Failure if followed as written: a static allowlist in `setupWorkspace` that includes all five default agents becomes a second source of truth beside `tmux.ts` cases. Adding an id to `hasTerminalDeliveryAdapter` without a real Muse-quality adapter would clear doctor/`recordOwnerWorkspace` while delivery still uses unsafe defaults.
   Smallest correction: either keep the predicate but define it as “ids with an explicit `case` in `harnessPromptReadiness`” and test drift, or use a Muse-id-only doctor exception (cursor `f372678b`) so capability cannot be granted by editing a list alone.

## Conclusion

Prefer claude `4aefc91e` as the implementation base: it alone pins measured Muse 1.4.10 foreground/composer/turn-chrome facts, names the concrete `tmux.ts` helpers and refusal codes, strips Escape for Muse, updates `DEFERRAL_RATIONALE`, and keeps run-loop protocol logic unchanged. Fold in codex `ae92f754`'s stricter Muse pending-prompt match (full rendered prompt, not UUID substring) and its frozen-roster / re-onboard test emphasis; reject codex's new `DoctorReport` field and remind-gating, and reject cursor `f372678b` as written until it gains Escape repair, fail-closed Muse chrome parsing, and `runLoop` rationale entries. No plan invents unjustified new product modules; focused test extensions are appropriate once the pending-prompt and Escape findings above are applied.

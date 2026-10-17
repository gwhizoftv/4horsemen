# Issue 235 plan — minimum Muse CLI automation and default onboarding

## Summary

Muse joins the default roster with `delivery: "both"`. It gets a small,
measured terminal adapter in `src/tmux.ts`, and doctor accepts automatic
delivery for an agent that has a terminal adapter even when it has no
lifecycle-hook mapping. Every handoff uses the existing protocol: JOIN with no
prior acceptance, `complete`, `ready <actionId>`, then the next send. No Muse
hook is added. The existing watchdog, bounded resend, delivery-uncertain hold
and owner-recovery paths are reused unchanged and are proven for an agent that
sends no callbacks.

### Measured Muse terminal facts (Muse Code 1.4.10, 1.4.10-R6427.1, tmux 3.7b)

These were measured while planning, in an isolated tmux socket in a scratch
directory with `MUSE_NO_AUTO_UPDATE=1 muse --trust-workspace --approval-mode never`.
Two trivial prompts were sent and the probe was then killed.

- `#{pane_current_command}` is `muse-bin-1.4.10` (idle and mid-turn). The
  issue-210 analysis recorded `muse-bin-1.4.7-R6101.1` for 1.4.7. The name has
  the version in it, so today's `harnessLooksReady(fg, "muse")` returns false
  and every gate refuses with `foreground-mismatch`.
- Idle tail (plain text):
  ```
  ── Voice input (alt(option)+v to start) ──────…
  ❯
  ──────────────────────────────────────────────…
    muse-wonder-1.0 · high · <path> · Launch overrides
  ```
  The live composer is the last line that starts with `❯`, followed by a
  pure `─` rule and a status footer. Submitted prompts also stay in history
  as `❯ <text>` lines above it.
- An owner draft is undimmed text on the composer line (`❯ owner draft text`).
  It has no placeholder. Text from `send-keys -l` paints progressively; a 300 ms
  gap before `Enter` (the existing `NUDGE_AFTER_TEXT_MS`) submitted an
  85-character prompt intact.
- A running turn keeps an empty `❯` composer painted and adds a status line
  just above the voice-input rule:
  `◈ Thinking (0s · esc to interrupt)` and
  `◇ Running command · Sleep for twenty seconds — running (7s · esc to interrupt)`
  (the glyph cycles through `◆◇◈`, never braille), plus
  `└ (ctrl+alt(option)+b to send to background)`. Finished items look like
  `◆ Ran command · … · ✓ · 20s · ctrl+o` and `◆ done`, with no `esc to interrupt`.
  Under the documented key semantics, Enter during a turn steers text into
  that turn and Escape interrupts it. So composer visibility is **not**
  readiness, and today's `default: ready()` branch would steer an action into
  a running turn.

## Exact File List to be changed or deleted

- `src/install.ts`: export `DEFAULT_AGENTS = ["claude", "codex", "cursor", "antigravity", "muse"] as const`
  and use it as the `onboard()` default (it replaces the inline four-agent array at line 921).
- `src/cli.ts`: the `onboard` default becomes `DEFAULT_AGENTS.join(",")` (line 1392).
  The help line for `onboard` notes the default roster. `agentExecutables` and
  Muse's version-only maintenance stay unchanged.
- `src/setupWorkspace.ts`: `buildWorkspaceConfig` generates `delivery: "both"` for
  every agent, which removes the Muse `"pull"` special case and its comment (lines 366–368).
  It also adds `hasTerminalDeliveryAdapter(agent)` next to `agentHarnessProcess`, true
  for `claude`, `codex`, `cursor`, `antigravity` and `muse`. The `agentOwnerUiDefaults`
  comment is updated; its Muse defaults (`[]`, `["Enter"]`, `Basic`) are kept.
- `src/tmux.ts` (the Muse terminal adapter):
  - `harnessLooksReady`: when `expected === "muse"`, also accept `/^muse-bin-\d[\w.-]*$/`.
    This covers the measured truncated and full forms. Nothing else changes.
  - `PromptBlockedReason` gains `"muse-turn-chrome"`, `"muse-no-prompt"` and `"muse-composer-not-ready"`.
  - Private helpers `museComposer(paneText)` and `museTurnChrome(paneText)`:
    - `museComposer` finds the last line that starts with `❯` and collects lines up
      to the first pure-`─` rule. It returns `null` when there is no composer or
      no rule (unknown tail, fail closed). It is empty only when that is exactly one
      line whose plain text is `❯`.
    - `museTurnChrome` is true when one of the last four non-blank lines above
      that composer, excluding the voice-input rule, matches
      `/^[◆◇◈]\s.*\([^)]*esc to interrupt\)/`.
  - `harnessPromptReadiness` gets a `case "muse"`. The shared trust-dialog check
    still runs first. `museTurnChrome` → `muse-turn-chrome`; `museComposer(...) === null` → `muse-no-prompt`;
    otherwise ready.
  - `nudge()`:
    - `proofRefusal` refuses `muse-composer-not-ready` when the Muse composer is not
      empty and does not hold this action's pending prompt. This mirrors the existing
      Codex owner-draft rule.
    - The pre-send recapture in `send` (now `claude || codex`) also covers `muse`, so
      readiness and the draft rule are proven again right before the single key batch.
    - Muse stays out of the "queued mid-turn" allowance, because Enter steers its turn.
  - `resolveNudgeKeys`: the existing Antigravity Escape+Enter→Enter downgrade also
    applies to `muse`, so a stale or hand-written Escape is never sent and cannot
    interrupt a Muse turn. The explicit empty prelude stays empty (`vimInsertPrelude` already returns `[]`).
  - `pendingPromptInComposer`, `paneActivityDigest`, `typeAndSubmit` (batched run-shell
    path, 300 ms before Enter) and `remind()` are reused unchanged; `❯` is already in `COMPOSER_LINE`.
- `src/runLoop.ts`: `DEFERRAL_RATIONALE` gets operator text for the three new
  reasons, so the journal and stdout do not fall back to "unrecognized".
  There are no delivery, watchdog, resend, budget or completion logic changes.
- `src/doctor.ts`: the `lifecycleHooks` "unsupported" finding (lines 357–368) is raised only when
  `!hasTerminalDeliveryAdapter(agent.id)`. The message becomes "…has nudge delivery
  enabled but no supported lifecycle-hook vendor mapping or terminal delivery adapter."
  The remediation lists `muse`. The missing/modified hook checks for hook-backed agents are unchanged.
- `scripts/lib/launcher.sh`: the comment only (line 93), "Opt-in pull participant"
  → "Automatic participant without lifecycle hooks". The launch flags and `MUSE_NO_AUTO_UPDATE=1` are unchanged.
- `config.example.json`: the Muse entry changes to `"delivery": "both"`.
- `README.md`: the roster sentence (lines 14–15) and "all four agents" (lines 99–101) become five,
  without "(pull delivery)". It notes that Muse has no lifecycle hooks or usage analytics.
- `docs/setup-workspace.md`: the Muse paragraph (lines 155–166) describes default inclusion,
  automatic delivery, the measured terminal contract, what is unavailable (lifecycle hooks,
  prompt acknowledgement, transcript watchdog input, hook containment; `coord status`
  reports hook coverage unverified) and the tested version with live results. The
  advanced-install example (line 207) lists five agents.
- `docs/coord-driver.md`: the `nudgeSubmit` defaults (lines 427–433) name Muse as Enter-only
  (Escape is stripped) and the batch sentence (line 435) includes Muse.
- `docs/readiness-policy.md`: the refusal table (lines 150–158) gets the three Muse reasons.
- Tests (extended, none new): `test/tmux.test.ts`, `test/runLoop.test.ts`,
  `test/doctor.test.ts`, `test/install.test.ts`, `test/onboard.test.ts`.

## Exact file list to be created

None in the repository. Live-verification evidence (the Muse version,
transcripts of pane captures and the artifact/marker checks) is written only
inside the disposable test workspace, outside this repo. A summary goes in the
implementation's `docs/setup-workspace.md` edit and in the submission report.

## Reuse and Scope

Reused without modification:
- the delivery reservation and budget: `CoordinatorRunLoop.deliver`,
  `maybeLifecycleNudge`, `NUDGE_REPEAT_DELAYS_MS`, the 4-send `nudge-loop` hold;
- the ready-receipt path: `consumeReady` → `recordAgentReady`;
- JOIN authorization through `lastAcceptedActionId == null`, and owner-release
  authorization through `sentHoldGeneration`;
- the pane-only stall watchdog: `watchOwedWork` with `paneActivityDigest`;
  `transcriptStamp` already returns `"none"` for non-Claude/Codex;
- `reconcileSubmitted` and the `delivery-uncertain` hold, which stay unresolved
  for Muse only through owner release, exactly as for Antigravity mid-send ambiguity;
- `markActionInjected`, `pendingPromptInComposer`, `renderNudgeText` / `RESEND_PREFIX`,
  `typeAndSubmit`, `injectionGate`, `remind`;
- `containmentCoverage` and `renderIssueReport`, which already report a Muse with
  no probe as hook `unverified`;
- the launcher and installer generation for Muse from #232 (`scripts/lib/launcher.sh`, `agentExecutables`).

Tests and fixtures reused: `safetyFixture`, `IDLE_PANE`, `promptFor`, `commandsIn`,
`ok`, `noopSleep`, `installed()`/`report()` in doctor tests, `product()` and
`installOnce` in install tests, and the onboarding CLI fixture in `test/onboard.test.ts`.

Small additions, justified:
- `DEFAULT_AGENTS` is one constant shared by CLI and programmatic onboarding, so
  the two defaults cannot drift. Both must change for this issue.
- `hasTerminalDeliveryAdapter` lets doctor express "delivery capability without
  lifecycle hooks". Without it, doctor's error exit would make `onboard()` skip
  `recordOwnerWorkspace` for every default onboarding.
- The two Muse pane helpers are needed because the measured Muse chrome matches
  neither `inFlightStatusLine` (its glyphs are not braille, and timers use
  `(Ns · esc to interrupt)`) nor `codexTail`.

Outside scope (kept as is): Muse lifecycle or prompt-submit hooks,
`.muse/hooks.json`, transcript reading, usage analytics, quota recovery, a
vendor registry, sandbox or launcher-flag changes, and other agents' key or
readiness behavior. The Git hooks and Git shim are unchanged. Existing issue
snapshots keep their frozen roster because `coord start` copies agents into
`start.json`/`originalRoster` (`src/cli.ts:1234`) and later commands read that,
not `config.json`. An explicit `--agents` list stays authoritative because the
default applies only when the flag or option is absent.

## Tests

Each item fails on the baseline and passes after the change. All join existing files.

1. `test/tmux.test.ts`
   - The `harnessLooksReady` block (around line 791) gains
     `("muse-bin-1.4.10","muse")` and `("muse-bin-1.4.7-R6101.1","muse")` → true,
     with `("node","muse")` and `("bash","muse")` → false. The baseline returns false for the first two.
   - New `it` next to the readiness tests (around line 829), using measured
     sanitized Muse fixtures:
     - the idle tail → ready;
     - `◈ Thinking (0s · esc to interrupt)` and the
       `Running command … (7s · esc to interrupt)` tails → `muse-turn-chrome`;
     - a splash with no `❯` → `muse-no-prompt`;
     - an idle tail that has `❯ <old prompt>` history and `◆ done` above the empty composer → ready.

     The baseline returns ready for the running-turn tails.
   - New `it.each` nudge cases over the Muse fixtures:
     - an owner draft `❯ owner draft text` → `busy`/`muse-composer-not-ready` with no `send-keys`;
     - a running turn → `busy`/`muse-turn-chrome` with no `send-keys`;
     - idle → exactly one batch `[-l text, sleep 0.3, Enter]` with no Escape and no prelude key.
   - `promptFor` gains a `muse` case, and `"muse"` is added to the existing
     `it.each(["claude","cursor"])` cases at lines 996 (history is not a pending prompt)
     and 1029 (a pending prompt is submitted without retyping). That shows that
     pending-prompt handling uses the live composer only.
   - The existing "keeps Muse owner reminders free of vim preludes and Escape" test (line 283)
     switches to `delivery: "both"` and adds `nudgeSubmit: ["Escape","Enter"]` → `["Enter"]`.
     The baseline returns Escape+Enter.
2. `test/runLoop.test.ts`
   - `safetyFixture` uses a measured Muse idle tail as its default `ui.text` when
     `vendor === "muse"`, and `IDLE_PANE` otherwise.
   - "records ready before verification and sends the next action exactly once after
     acceptance" (line 1634) becomes `it.each(["claude","muse"])`, and the Muse case
     calls no `f.working()`. This covers JOIN plus a ready-driven handoff with no
     lifecycle callback. The test then writes a second `complete`/`ready` for the new
     action and asserts a third send with `readyFor` (two subsequent actions). The
     baseline fails on `foreground`/readiness for Muse.
   - "resends a lost %s prompt once after a quiet minute, then reports [WAIT], with no ack timer"
     (line 2793) adds `"muse"`: the send is bounded, there is exactly one resend and one
     `[WAIT]`, and there is no hold.
   - "resends the current action once after an owner hold release, without ready"
     (line 4549) becomes `it.each(["claude","muse"])`, covering the restart and
     `harness-gone` recovery path without SessionStart.
   - "charges partial sends and does not retry them on restart" (around line 1286) becomes
     `it.each(["codex","muse"])`: a failed submit leaves `delivery-uncertain` charged and
     makes no duplicate send. That proves no callback is required to stay safe.
3. `test/doctor.test.ts`: a new `it` next to "reports nudge delivery for an agent id
   with no lifecycle vendor mapping" (line 140) installs `muse` with `delivery: "both"`
   and asserts there is no `lifecycleHooks` finding. The existing `claude-a` case keeps
   its finding and its `delivery to pull` remediation. The baseline reports the finding for Muse.
4. `test/install.test.ts`: the "launches Muse unsandboxed with pull delivery and no
   self-update" test (line 1269) is renamed for automatic delivery and expects
   `delivery: "both"` and `harnessProcess: "muse"`. The launcher argv and env
   assertions are unchanged.
5. `test/onboard.test.ts`: the default-roster assertions (lines 240 and 277) expect
   five agents ending with `muse`, so plain onboarding still ends with "no findings"
   (doctor is clean). The existing explicit `--agents claude` cases (lines 80, 149, 302)
   remain the evidence that an explicit list is exact.

Required checks: the commit hook runs `pnpm check:fast` (do not duplicate it by hand).
While developing, run focused `pnpm vitest run test/tmux.test.ts test/runLoop.test.ts test/doctor.test.ts test/install.test.ts test/onboard.test.ts`.
Final `pnpm check` (build + check:fast + e2e) is owned by the coordinator at the approved pin.

Live verification (required by the issue, not replaced by stubs). Record the
results in the disposable workspace and summarize them in the submission:
1. Disposable product: a throwaway GitHub repository or test product with its
   own coord-runtime, plus a throwaway issue. Record `muse --version`.
2. Plain `coord onboard <product>`: confirm five clones, `start-muse.sh`, a Muse
   `delivery: "both"` config entry and a clean doctor. Re-onboard with
   `--agents muse,claude` for the live run, so Muse is in a two-agent consensus
   roster; Claude only completes peer steps.
3. `coord <issue>`, with no owner input to Muse. Observe:
   - automatic JOIN delivery and Muse's `participation-ready` Git commit, push and `complete`/`ready`;
   - the next action (plan, Git mode) delivered automatically after `ready`;
   - a ballot (private-response mode) with `response <actionId>` and `ready`.

   Validate each artifact path and SHA and each marker against `action.md`.
4. Terminal behavior on the live pane:
   - leave an owner draft in Muse's composer while an action is owed and confirm a `muse-composer-not-ready` deferral with no keys sent;
   - confirm a running turn yields `muse-turn-chrome` and no steering or Escape;
   - type an action prompt without Enter and confirm the resend submits it without retyping;
   - kill and relaunch the Muse pane mid-action and confirm the `harness-gone` hold, owner release and one resend without duplicate work;
   - confirm the quiet-minute resend happens at most once.
5. The JOIN containment probe: record Muse's actual `git status --porcelain` result
   (expected `shim-refused`, since there is no hook) and confirm `coord status` reports
   hook coverage unverified without blocking progress.

If any step hits a concrete blocker, record its reproduction and missing
capability and report it. Do not fall back to pull.

## Alternatives Rejected

- **Add Muse lifecycle hooks (`.muse/hooks.json`) for prompt acknowledgement.**
  The issue defines the ordinary cycle without callbacks, and issue-210 records
  Muse's cleared hook environment as unverified. A hook would become an
  undocumented progression dependency.
- **Use `default: ready()` with only a process alias.** The measurements show a
  running turn keeps `❯` visible, so a generic or composer-only readiness check
  would steer actions into live turns.
- **Reuse `inFlightStatusLine` / Codex helpers for Muse.** The Muse glyphs and timer
  syntax don't match their anchors, and widening the shared regex would change
  other vendors' readiness.
- **Rewrite `harnessProcess` in generated config to `muse-bin`.** The name carries
  the version and changes on every update, and existing Muse configs say `muse`.
  An alias in `harnessLooksReady` covers both new and old configs.
- **Downgrade doctor's finding to a warning for every unsupported id.** That would
  hide the real misconfiguration (`claude-a` with nudge) that the finding exists for.
- **A vendor registry or capability module.** Out of scope per the issue and the issue-210 recommendation.
- **Muse SDK/MSP or `muse exec` transport.** These would replace the tmux protocol rather than complete it.

## Risks and Mitigations

- **Muse chrome changes across versions.** The adapter fails closed: an unknown tail
  gives `muse-no-prompt` and an unknown composer content gives `composer-not-ready`.
  The measured version is documented. The bounded watchdog and owner `n` remain recovery paths.
- **False busy from prose that quotes `(… esc to interrupt)` with a `◆` prefix in the
  last four lines.** This blocks a send (safe), it is bounded by the existing deferral
  journaling, and the owner reminder bypasses it.
- **Text painting is slower than 300 ms for the longer action prompt.** Live step 3
  checks real prompt length. If it fails, report it with a capture and do not tune
  timing blindly. A pending prompt is then submitted (not retyped) by the existing
  `pendingPromptInComposer` path.
- **No prompt acknowledgement, so mid-send ambiguity can never auto-clear.** This is
  identical to Antigravity: the `delivery-uncertain` hold needs owner release, with no
  duplicate send (Test 2, last item). Ordinary sends do not wait for acknowledgement
  because `deliver` clears `reserved` on transport success.
- **`coord status` shows `[WARN]` for Muse because the hook is never active.** That is
  accurate reporting, does not gate progress, and is documented.
- **Muse's default sandbox is disabled (from #232).** This is unchanged; the docs
  already state there is no filesystem isolation.
- **Default onboarding now requires a Muse install.** That is the issue's stated
  requirement. An explicit `--agents` list stays the opt-out, and the README says so.

## Conclusion

Five focused source edits (`install.ts`, `cli.ts`, `setupWorkspace.ts`,
`tmux.ts`, `doctor.ts`), plus one rationale map entry set in `runLoop.ts`,
make Muse a default, automatically delivered participant. The terminal
adapter rests on measured 1.4.10 pane facts: a version-suffixed foreground,
a `❯` composer, and `(… esc to interrupt)` turn chrome above it. The run
loop's ready/complete, watchdog, bounded-resend and uncertainty protections
are reused unchanged and are proven by extended tests for an agent with no
lifecycle callbacks. Live verification in a disposable workspace covers Git-mode
and private-response handoffs, owner drafts, running turns and restart recovery.

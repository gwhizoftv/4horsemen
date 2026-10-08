# Issue 181: recognize the actual idle Codex terminal layout

Baseline: `0bf31ac88cd2d8e482fd3f38085470594626bb94`. Planning action:
`c6afc6f0-0f68-421f-b262-df5b824df4c2`.

## Exact File List to be changed or deleted

- `src/tmux.ts`: narrowly extend the existing Codex terminal-tail parser to
  recognize the observed agents/shortcuts footer and completed-turn timing
  decoration. Use the same recognized layout for empty-composer, exact-nudge,
  Vim-mode, and submitted-nudge checks. Preserve all injection safeguards.
- `test/tmux.test.ts`: extend the existing ANSI Codex pane fixtures and
  parameterized idle-override delivery tests with the observed layout and its
  unsafe near-misses.
- `test/runLoop.test.ts`: extend existing acceptance/readiness and stale-working
  delivery coverage with the realistic Codex layout, including first-send
  recovery across coordinator restart and a completed peer waiting on Codex.

No product files are deleted. No changes to lifecycle schemas, event routing,
hook installation, product hooks, dependency manifests, or version numbers.

## Exact file list to be created

- `.plans/issue-181/plan.md`: the coordinator-required planning artifact, created
  by this action rather than by the later product implementation.

No new product, test, or fixture files. Keep sanitized terminal samples inline
in the existing test files; no new dependencies or reusable parsing framework.

## Reuse and Scope

### Evidence and failure mechanism

The frozen issue snapshot describes a completed Codex response with the idle
sentinel followed by `Worked for 6m 15s • 4:10 AM`, while delivery is refused as
`codex-composer-not-ready`.

A read-only ANSI capture of this session's `coord-181:codex.0` pane confirms the
current layout: the composer still uses `›` and an SGR-2 dim placeholder; the
footer includes a context/Vim line followed by
`← for agents · ? for shortcuts` and the existing warning suffix. The capture
also retains the completed previous response's `Worked for 47s • 1:46 PM` line.
This is current layout evidence, not a claim to have recovered the original
issue-161 terminal bytes.

`CODEX_FOOTER` currently recognizes shortcuts only when the trimmed line starts
with `?`. Consequently, `codexTail(..., false)` rejects the agents-prefixed
footer even when the composer is empty. A valid durable ready receipt therefore
cannot pass `TmuxController.nudge`'s ready-file check. Independently,
`linesAfterCodexSentinel` leaves the completed-turn timing line in front of the
composer, so the sentinel fallback rejects the reported completed layout too.
The same layout parsing feeds the per-key exact-nudge and submission checks;
fixing only the initial readiness check would still stall partway through a
send.

The retained issue-161 journal corroborates the distinction between agents:
Codex's review action `ce2adaf4-7f07-4761-91c1-ba510ab2e5ff` was deferred for
`codex-composer-not-ready` at `2026-10-08T11:10:23.131Z`. Antigravity's reported
action `ca8f69a9-4efd-4e2e-b95c-a4a128d38b20` had already been injected; its
`working` deferral was recorded at `11:10:21.048Z`, its review was accepted at
`11:12:58.230Z`, and a Stop plus subsequent status returned it to idle by
`11:13:19.385Z`. The earlier printed deferral is not evidence of an outstanding
Antigravity delivery after acceptance. Do not bypass its working/queue rules to
make that historical message disappear.

### Implementation

1. Extend the anchored Codex footer recognition for the observed optional
   `← for agents ·` prefix before `? for shortcuts`. Retain existing context,
   Vim, and warning-tail forms. Recognize it only in the structural footer
   position after the composer, not as arbitrary matching text in a draft.
2. Permit the known completed-turn timing decoration immediately after the
   latest sentinel and before the composer (or the subsequently submitted
   nudge). Match the terminal's `Worked for <duration> • <clock>` form narrowly;
   do not discard arbitrary intervening lines or search past new transcript
   items. Keep the timing decoration distinct from the post-composer footer.
3. Reuse that layout in `codexTail`, `codexSentinelAtTail`,
   `codexComposerHolds`, `codexNudgeSubmitted`, and `codexVimNormal`. A ready-file
   send must still prove an empty composer without requiring a sentinel; a
   sentinel-based override must still require the current sentinel and reject
   a newer action/transcript item. Both paths must recognize exactly the
   injected nudge before submitting it.
4. Preserve `codexTurnChrome`, `codexComposerEmpty`'s ANSI placeholder/draft
   distinction, `harnessPromptReadiness` blocker precedence, and
   `TmuxController.injectionGate`. Keep per-key lifecycle/receipt revalidation,
   reservation accounting, and suppression of the fallback submit key once
   acceptance of this nudge is proved. Never clear or submit an owner draft.

Reuse the existing `PaneLine`, `paneLines`, `stripAnsi`, and `IdleOverride`
types/helpers rather than introducing a second parser. Reuse `codexPane`,
`codexComposer`, `codexFooter`, `ok`, `noopSleep`, and the stateful `attempt`
helper in `test/tmux.test.ts`; extend them only as needed for the two supported
footer forms and completed-turn decoration.

For integration coverage reuse `fixture`/`safetyFixture`, the fake
`TmuxController` runner, `BareMirror` acceptance stub, controlled clock,
`agentRuntimePaths`, `readJournal`, and existing ready-file timestamp helpers.
Model the literal paste appearing in the composer so per-key checks exercise
real delivery behavior rather than a permanently empty mocked prompt.

`CoordinatorRunLoop.readyForNextAction`, `deliver`, `maybeLifecycleNudge`, and
`accept`, plus `decideLifecycleNudge`, already implement the required receipt,
first-send, and accepted-peer behavior. They are inspected/reused unchanged:
`src/runLoop.ts` and `src/agentLifecycle.ts` are not added to the change map.
If implementation demonstrates an additional necessary product change, request
a plan amendment instead of expanding this scope silently.

## Tests

Add the fewest focused cases by extending existing tests:

1. **Terminal parsing and sending — `test/tmux.test.ts`.** Add the observed ANSI
   footer to the existing Codex fixture variants. Cover an empty/dim composer
   under a valid ready-file override, and the sentinel plus completed-turn
   timing line under a sentinel override. Both must send the exact action text
   and submit successfully. These positive cases fail on the baseline parser.
   Exercise Normal versus Insert and early `C-j` acceptance using the existing
   stateful send test, so no literal `i` is inserted in an already-Insert
   override and no fallback `C-m` enters the newly running turn.
2. **Negative controls in the same tests.** Retain old layouts and all current
   refusal assertions. Add a non-dim owner draft, an unrecognized line between
   sentinel and composer, an unrecognized footer line, and a newer transcript
   item around the newly accepted decorations. They must not become valid idle
   proof. Keep existing live-Working, trust-dialog, stale-action, failed-capture,
   lifecycle-change, owner-edit-between-keys, and exact-message checks. Do not
   weaken their expected outcomes to accommodate the new samples.
3. **Workflow regression — `test/runLoop.test.ts`.** Extend the existing real
   acceptance/ready-file scenario with Codex's new footer and unknown hooks
   (also exercise the existing stale-working path). After the prior action is
   accepted, retain its ready receipt while the pane is still busy; after it
   becomes safely idle, deliver the never-sent next action once without manual
   `continue`. Assert the ready file is consumed only after successful delivery,
   sends/reservations and the `nudged` record are correct, and another tick or
   reconstructed loop cannot duplicate the send. Include an accepted
   Antigravity peer in waiting-peer state: its earlier working diagnostic must
   neither cause a duplicate of its accepted action nor prevent the outstanding
   Codex delivery. This combined regression fails before the footer fix;
   existing lifecycle tests remain the guard against unsafe idle assumptions.

Focused development command, verified against the repository's Vitest include
configuration:

```sh
pnpm exec vitest run --config vitest.config.ts test/tmux.test.ts test/runLoop.test.ts
```

For product implementation, the commit hook owns `pnpm check:fast` (currently
lint, typecheck, fast tests, and system tests); do not manually duplicate it
immediately before committing. The frozen start configuration assigns final
verification to the coordinator with `pnpm run check` (build, check:fast, e2e).
Follow any subsequent action's coordinator-verification instructions and cite
its recorded results separately from locally executed checks.

This planning action runs only artifact/heading/file-map validation and the
normal evidence-only commit/push hooks, not a product test suite. The commands
above are proposed implementation checks, not claimed results.

## Alternatives Rejected

- Treat any visible sentinel or ready file as unconditional permission to
  type: that would paste into drafts, active turns, or dialogs and defeat
  per-key safety checks.
- Relax every `working` or `unknown` lifecycle state, deduplicate active
  Antigravity status receipts, or add a timeout-based force-send: the inspected
  incident does not justify these changes, and the existing never-sent
  override already handles stale/absent hooks with positive terminal proof.
- Recognize an arbitrary last `›` and ignore everything else: transcript
  prompts and unknown footer/dialog content must continue to fail closed.
- Add a terminal parsing library, persisted readiness schema, or separate
  fixture subsystem: the existing small parser and test fixtures can express
  both observed differences without a new abstraction.
- Require the owner to type `continue`, adjust themes, or remove the agents
  footer: this works around the false refusal instead of correcting it.

## Risks and Mitigations

- **Overbroad chrome matching:** allow only the observed anchored footer prefix
  and completed-turn timing grammar in their correct positions; retain
  unknown-line and draft vetoes and test near-misses.
- **Partial-send regression:** exercise the same layout before paste, between
  submit keys, and after acceptance. Preserve charged reservations and the
  existing delivery-uncertain hold on ambiguous partial sends.
- **Theme/ANSI variation:** keep raw lines for dim-state interpretation and
  stripped lines for structural matching; extend the existing colored fixture
  rather than replacing it with an unrealistic plain-text-only example.
- **Misdiagnosing another agent from old stdout:** use action-correlated journal
  acceptance and current workflow state. Keep Antigravity lifecycle semantics
  unchanged and verify that an accepted peer is not resent.
- **Future unsupported terminal layouts:** continue to defer safely rather
  than broadening readiness to arbitrary text. Further observed layouts need
  equally narrow regression evidence.

## Conclusion

Change one product file and extend two existing test files. Correct the two
observed Codex layout mismatches so both durable-ready and sentinel fallback
delivery can advance an idle session automatically, while preserving active
turn, owner-draft, receipt freshness, duplicate-send, and peer-acceptance safety.

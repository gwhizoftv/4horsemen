# Issue 241 implementation plan

Fix Muse placeholder text being mistaken for an unsent draft. This plan uses the
issue snapshot in `coord-runtime/issue-241/github-issue.json` and source at the
frozen baseline `997cb3a9b90b9f5ec2708bc98f51e6dd1dc73a9a`. The measured Muse
Code 1.4.10 placeholder uses foreground RGB `103,108,116`, without SGR dim.

## Exact File List to be changed or deleted

- `src/tmux.ts`: extend the private `composerLineEmpty` helper with a
  `"codex" | "muse"` vendor argument defaulting to `"codex"`. Select the
  corresponding composer marker (`›` or `❯`), retain Codex's SGR 2/22 handling,
  and track foreground styling for Muse. Ignore Muse text only while the
  foreground is exactly the measured `38;2;103;108;116` true color. Consume
  extended foreground, background, and underline-color operands as a unit so
  their numeric values cannot accidentally activate dim or reset attributes.
  SGR 0 (including an empty SGR parameter list) resets dim and foreground;
  SGR 39 and standard/bright foreground selections clear the placeholder
  foreground; other true-color or 256-color foreground selections replace it.
  Background and underline colors must not establish placeholder foreground.
  Preserve accumulated non-placeholder text even if later text uses the
  placeholder style. Change `museComposerEmpty` to pass the recognized
  composer's raw lines joined with newlines to this helper with `"muse"`,
  preserving attribute state across wrapped lines instead of requiring one
  stripped line equal to `❯`. Keep the Codex caller's existing behavior.
- `test/tmux.test.ts`: extend the existing `Muse automatic delivery` tests
  with the measured ANSI placeholder, wrapping, real-draft variants, foreground
  transitions, and recapture/busy scenarios described below. Reuse existing
  fixtures and assertions; add only local constants or parameter rows needed
  to express these cases.
- `docs/setup-workspace.md`: update the Muse terminal-adapter explanation to
  identify the measured foreground placeholder as empty, including wrapped
  hints, and explain that matching words, dim alone, unknown colors, and
  text after a foreground reset do not establish an empty composer. Preserve
  the explanation of draft blocking, current-prompt recovery, busy turns,
  final recapture, and unknown footer rejection.

No files are deleted. No package version, dependency, launcher, runtime
configuration, product hook, or other vendor adapter changes are required.

## Exact file list to be created

No product or test files are created. `.plans/issue-241/plan.md` is the sole
coordination artifact created by this planning action; implementation uses the
three existing files listed above.

## Reuse and Scope

Reuse `composerLineEmpty` and `stripAnsi` in `src/tmux.ts` for ANSI-aware text
classification, and `PaneLine`, `paneLines`, and `museComposer` for the existing
composer boundaries and recognized rule/footer. Reuse `museComposerEmpty` as
the integration point; no exported parser, new abstraction, or dependency is
needed. The existing `codexComposerEmpty` caller retains its default vendor
and one-line requirement.

Keep `museTurnChrome`, `harnessPromptReadiness`, `musePromptPending`,
`renderNudgeText`, and `TmuxController.nudge` unchanged. Their existing checks
continue to reject a running turn, require the exact current action prompt
for submit-only recovery, and recapture immediately before any keys are sent.
`capturePane` already requests ANSI-preserving `capture-pane -ep`; no transport
change is needed. No English hint matching or broad gray-color heuristic is
introduced.

Reuse `musePane`, `museNudge`, `commandsIn`, `ok`, `noopSleep`, and the existing
`action`, `digest`, `current`, and `esc` values in `test/tmux.test.ts`. Preserve
the measured composer prefix/reset and blue prompt-marker styling when
constructing the positive fixture from the existing pane, then vary only the
composer text or styling needed by each test. Use that same hint text for
positive and negative cases to demonstrate that the decision depends on ANSI
evidence. Existing Muse pending-prompt, draft, and readiness cases and Codex
placeholder delivery cases provide the surrounding regression coverage.

## Tests

All new cases join `test/tmux.test.ts`; prefer parameterized cases and extending
the existing refusal table over separate fixtures or duplicated runner setup.

1. Extend the successful delivery case with the exact measured single-line
   placeholder and a wrapped version whose continuation inherits the first
   line's foreground without re-emitting its color. Both must send precisely
   one literal `current` prompt and one Enter, with the existing sleep only
   and no prelude or Escape. These cases reproduce the bug and fail against
   the baseline because its emptiness predicate rejects placeholder text.
2. Parameterize draft refusals for the identical hint in normal true color
   `204,211,219`, without ANSI, with SGR 2 alone, and with an unmeasured gray.
   Also exercise the measured RGB used as background/underline color rather
   than foreground. Each must return `muse-composer-not-ready` and send no
   keys. These are guard tests that already block on the baseline and must
   keep blocking after the new allowance.
3. Parameterize a measured placeholder followed by real draft text after
   SGR 39, SGR 0, empty SGR reset, standard foreground, bright foreground,
   256-color foreground, and normal true-color foreground. Include a wrapped
   continuation with the reset before the real text, and a real draft before
   a later placeholder-colored span. Assert `muse-composer-not-ready` and no
   keys for every row. Color operands containing values such as 0 or 2 must
   remain operands rather than independent attributes.
4. Use `museNudge(placeholderPane, draftPane)` to verify that a real draft
   replacing the placeholder before the final recapture blocks every key.
   Count captures in the existing local helper if needed to assert that this
   scenario reached the second capture; a failure at the initial placeholder
   check must not masquerade as a successful recapture test. Add a running-turn
   pane containing the placeholder and assert `muse-turn-chrome` with no keys.
5. Run the full existing tmux test file to retain empty-input delivery, exact
   current-prompt submit-only recovery (wrapped and unwrapped), stale-digest
   rejection, unknown-footer rejection, and Codex dim-placeholder behavior.

During implementation, first run the focused new positive cases against the
unchanged parser to record the expected failure, then run
`pnpm exec vitest run --config vitest.config.ts test/tmux.test.ts` after the fix.
Do not run product suites merely to publish this plan.

The current runtime configuration declares `pnpm run check:fast` for the
product commit hook and `pnpm run test:e2e` for the push hook. Let those hooks
own their mandatory checks instead of manually duplicating them immediately
before publication. `check:fast` in the inspected `package.json` includes
lint, typecheck, fast tests, and system tests, so it also supplies the issue's
requested typecheck. The coordinator's configured final check is
`pnpm run check`, which adds build and e2e; cite its recorded result as
coordinator verification, not as an agent-run suite. If a later action assigns
candidate verification to the coordinator, follow that action's ownership.

For this evidence-only action, validate the required headings, nonempty
bodies, exact file map, and cited baseline before committing and pushing the
plan. No implementation or test execution is claimed by this plan.

## Alternatives Rejected

- Matching the English hint would submit an owner's draft containing the same
  words and would break when Muse changes its hint copy.
- Reusing Codex's dim criterion for Muse does not recognize the measured
  capture and would wrongly exempt dim-styled Muse drafts.
- Treating arbitrary gray or ANSI-colored text as empty would weaken draft
  protection without measured evidence for those styles.
- Stripping ANSI before classification, or parsing each wrapped line with
  fresh attributes, loses the evidence needed to distinguish a placeholder
  from a draft.
- A separate Muse parser, new fixture file, or ANSI package duplicates the
  existing helper and exceeds the scope of this focused correction.
- Changing readiness, prompt recovery, footer matching, or send sequencing is
  unnecessary; existing gates already provide the required protection once
  emptiness is classified correctly.

## Risks and Mitigations

- A foreground reset or color change could leave stale placeholder state and
  hide real text. Track foreground explicitly and cover reset, standard,
  bright, indexed, and true-color transitions with zero-key assertions.
- Extended-color operands could be mistaken for SGR dim/reset codes. Preserve
  the current operand skipping for all three extended-color selectors and
  update foreground only for selector 38.
- Wrapped placeholders could be rejected if style state is restarted per
  line. Feed the recognized raw composer to one parser invocation and cover
  a continuation that inherits color.
- Shared-helper changes could alter Codex behavior. Keep Codex as the default
  vendor, retain its dim semantics and existing caller, and run all existing
  tmux delivery tests.
- The input or turn state may change after the initial capture. Retain the
  final pre-send checks and test placeholder-to-draft replacement explicitly.
- Other Muse themes or future versions may use different placeholder colors.
  Accept only the supplied measured RGB; unknown styling continues to block
  delivery until there is additional measured evidence. Document this limit.

## Conclusion

Implement the correction in the existing ANSI helper and Muse emptiness
predicate, prove the measured placeholder is deliverable while drafts remain
protected, and update the existing adapter documentation. The implementation
is limited to `src/tmux.ts`, `test/tmux.test.ts`, and `docs/setup-workspace.md`.

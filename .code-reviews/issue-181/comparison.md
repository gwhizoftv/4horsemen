# Issue 181 implementation comparison (claude)

Bound implementation pins compared:

- cursor `8524928479df04db525ad9ea81bd0c989093d72e`
- codex `c9708f8f091dd21e57240bbb1a15a9b3532aec12`
- antigravity `88babdba642d1290e80089e30fbe881557613f6b`
- claude `24fbca708b391f9322ab0435f4f9c40de3e8ed56`

Method: I read each exported worktree directly and compared each peer's
`src/tmux.ts`, `test/tmux.test.ts` and `docs/readiness-policy.md` against the
claude pin with plain `diff -u`. All four touch exactly those three product
paths, plus their own coordination artifacts. All three paths are in the
approved path list. No implementation changes `src/runLoop.ts`, lifecycle
normalisation, or any other file.

I ran no tests in the peer worktrees, and this comparison claims no
verification results for them. For the claude pin, the pre-commit hook's
`check:fast` passed (fast tests 681/681, system tests 181/181). Earlier, the
focused `test/tmux.test.ts` failed 3 cases with the two predicate changes
reverted, and passed all 58 with them.

## Comparison

### Product code (`src/tmux.ts`)

All four implement the selected plan identically in substance:

- `CODEX_FOOTER` gains the anchored optional `←\s+for agents\s+·\s+` prefix
  before `\?\s+for shortcuts`.
- A new anchored `CODEX_TURN_SUMMARY` constant matches
  `[─\s]*Worked for <h/m/s parts>[ • h:mm [AM|PM]][─\s]*` as a whole line.
- `linesAfterCodexSentinel` drops exactly one leading line that matches
  `CODEX_TURN_SUMMARY`. `codexTail`, `codexSentinelAtTail`,
  `codexComposerHolds`, `codexVimNormal` and `codexNudgeSubmitted` therefore
  inherit the fix without any other changes.

The differences are cosmetic except one:

- **cursor:** wraps both regex constants onto a second line and rewords the
  comments. Behaviour is identical to claude's.
- **codex:** writes the skip as
  `CODEX_TURN_SUMMARY.test(after[0]?.plain ?? "")` and updates the helper's
  doc comment to say it excludes the summary. Behaviour is identical: the
  empty string fails the pattern.
- **antigravity:** widens both separators to `[·•]`, i.e.
  `←\s+for agents\s+[·•]\s+` in the footer and `\s*[·•]\s*` before the clock in
  the summary. The issue capture shows `·` in the footer and `•` before the
  clock. Neither alternative has been observed. Both patterns stay anchored
  to the whole line, so this adds no concrete unsafe acceptance: a matching
  line is still Codex chrome, not a dialog or draft. It is speculative
  flexibility beyond the selected plan's exact patterns, but not a defect.

No implementation has a correctness finding. Each one preserves:

- the `codexTurnChrome` veto order;
- the dim-placeholder test in `codexComposerEmpty`;
- the single-composer-line requirement;
- the per-key revalidation in `TmuxController.nudge`.

### Tests (`test/tmux.test.ts`)

All four reuse the existing `codexComposer` / `codexFooter` / `codexPane`
fixtures, the readiness test
`"vetoes a live Codex turn and reads its idle sentinel only above an empty composer"`,
and the stateful `attempt` harness in the existing
`it.each(["idle-sentinel","ready-file"])` nudge test. Each one:

- switches the shared footer fixture to the live
  `← for agents · ? for shortcuts` line. This makes the existing ready-file
  and sentinel send cases reproduce the stall on the baseline parser;
- adds the `Worked for 5m 21s • 5:42 AM` line to the default
  `idle-sentinel` body, so the `submitOnCtrlJ` case covers
  `codexNudgeSubmitted` through the summary.

None adds a test file or a new test block. Differences:

- **codex:** strongest coverage.
  - The summary fixture is wrapped in SGR 2 dim, matching the capture.
  - A loop proves both footer forms work with no summary, the
    `Worked for … • time` form, and the legacy `─ Worked for 12s ─────` rule
    form.
  - Earlier transcript above the latest sentinel stays `idle-sentinel`.
  - Six near-misses after the sentinel fail closed:
    - a dialog after the summary;
    - a second summary;
    - bulleted prose;
    - `Worked for the reviewer: …`;
    - a summary followed by trailing prose;
    - a summary followed by a new `›` request.
  - An unknown footer line fails closed, and live turn chrome after a summary
    still vetoes.
  - It is the only pin that exercises the `─` rule alternative and the
    trailing-text rejection that the regex is built for.
- **claude:** covers the live summary, the legacy footer (via `.replace`), a
  summary above the sentinel (`idle-sentinel`), three near-misses (dialog
  after summary, `Worked for the reviewer: …`, bulleted prose) and the
  turn-chrome veto. It does not cover the `─` rule form or the
  unknown-footer case.
- **cursor:** adds a `legacyCodexFooter` constant and a `footer` parameter to
  `codexPane` instead of `.replace`. It covers the same cases as claude
  except the `Worked for the reviewer: …` near-miss. The fixture addition is
  small and justified but not necessary: the other pins test the legacy
  footer by editing the fixture string.
- **antigravity:** covers the live summary, the legacy footer, the
  turn-chrome veto, a summary with no sentinel, a dialog after the summary,
  and bulleted prose. It has no test for the summary above the sentinel or
  for whole-line anchoring (`Worked for the reviewer: …`). Its `[·•]`
  widening also has no test exercising the `•` footer form it adds.

### Docs (`docs/readiness-policy.md`)

All four update the Codex paragraph to list the `← for agents` footer and the
optional single summary line.

- **codex:** the most precise. It names both summary forms, states the
  whole-line requirement and the `N% context left` footer that the code
  already accepted, and notes that the submitted-nudge check uses the same
  rule.
- **claude:** additionally states that the file-backed path applies the same
  composer and footer rules without the sentinel. That is accurate:
  `codexTail(…, false)` and `nudge`'s `codex-composer-not-ready` check.
- **cursor** and **antigravity:** concise and accurate. They omit the
  whole-line rule.

### Scope and discipline

| Pin | Within issue | Reuse | New files/abstractions | Focused coverage |
|---|---|---|---|---|
| cursor `85249284` | yes | existing helpers and fixtures | one extra fixture constant/param | yes |
| codex `c9708f8f` | yes | existing helpers and fixtures | none | yes, most complete negative set |
| antigravity `88babdba` | yes, with unobserved `[·•]` widening | existing helpers and fixtures | none | partial: no anchoring or `•`-form test |
| claude `24fbca70` | yes | existing helpers and fixtures | none | yes |

### Recommendation

All four are mergeable fixes for the observed stall, and their product code
is behaviourally equivalent, apart from antigravity's untested separator
widening. Prefer **codex `c9708f8f091dd21e57240bbb1a15a9b3532aec12`**. It has
the same minimal product change as the selected plan, the most complete
fail-closed test set, a fixture that reproduces the dim summary rendering,
and the most precise policy text. **claude `24fbca70`** and **cursor
`85249284`** are close equivalents. Rank **antigravity `88babdba`** last for
the speculative `[·•]` widening and thinner anchoring coverage.

## Comparison

This review compares the four bound implementation pins for issue 181:
- `cursor`: `8524928479df04db525ad9ea81bd0c989093d72e`
- `codex`: `c9708f8f091dd21e57240bbb1a15a9b3532aec12`
- `antigravity`: `88babdba642d1290e80089e30fbe881557613f6b`
- `claude`: `24fbca708b391f9322ab0435f4f9c40de3e8ed56`

### Scope and Discipline

All four implementations adhered strictly to the approved plan (`e5799ab1db49b0bb61d8d333b1c515c4d378a50a`) and scope:
- Each implementation modified only `src/tmux.ts`, `test/tmux.test.ts`, and `docs/readiness-policy.md`.
- No unapproved files, helper modules, or speculative abstractions were added.
- `src/runLoop.ts` and `src/agentEvent.ts` remained completely untouched, preserving consensus from the plan review phase.
- All implementations stayed fail-closed, ensuring that unrecognized chrome or draft content does not mistakenly register as idle readiness.

### Implementation Analysis

#### 1. Codex Footer Matching (`src/tmux.ts`)
- All implementations updated `CODEX_FOOTER` to accept the optional leading `← for agents ·` prefix before `? for shortcuts`:
  - `cursor` (`8524928479df04db525ad9ea81bd0c989093d72e`), `codex` (`c9708f8f091dd21e57240bbb1a15a9b3532aec12`), and `claude` (`24fbca708b391f9322ab0435f4f9c40de3e8ed56`) used `/^(?:(?:←\s+for agents\s+·\s+)?\?\s+for shortcuts|Context \d+% left|\d+% context left)/`.
  - `antigravity` (`88babdba642d1290e80089e30fbe881557613f6b`) used `[·•]` to match either an interpunct or a bullet separator.
- All four implementations keep the regex anchored at line start (`^`), preventing arbitrary prose mentioning shortcut instructions from matching as chrome.

#### 2. Turn Summary Decoration and Sentinel Slicing (`src/tmux.ts`)
- All implementations introduced `CODEX_TURN_SUMMARY` matching the completed-turn duration line (`Worked for …` with optional clock time and rule delimiters `[─\s]*`).
- All implementations updated `linesAfterCodexSentinel`:
  - `cursor`, `claude`, and `antigravity` check `after[0] !== undefined && CODEX_TURN_SUMMARY.test(after[0].plain)` and slice off `after.slice(1)`.
  - `codex` checks `CODEX_TURN_SUMMARY.test(after[0]?.plain ?? "") ? after.slice(1) : after`.
- Only a single leading summary line is skipped; any trailing dialogs, owner drafts, or extra output immediately fail closed to `vendor-prompt` or `null`.

#### 3. Test Fixtures and Verification (`test/tmux.test.ts`)
- All implementations updated `codexFooter` in `test/tmux.test.ts` to mirror the live Codex capture from issue 181.
- All implementations updated the `it.each(["idle-sentinel", "ready-file"])` test to include `Worked for 5m 21s • 5:42 AM` between the sentinel and composer, verifying that `codexNudgeSubmitted` recognizes turn submission on `C-j` without firing fallback `C-m` keystrokes.
- All implementations expanded `vetoes a live Codex turn and reads its idle sentinel only above an empty composer` with:
  - Positive tests for the sentinel followed by a turn summary line.
  - Compatibility tests for legacy footers (`? for shortcuts` without the agents prefix).
  - Precedence tests ensuring `codexTurnChrome` (`Working (… • esc to interrupt)`) still vetoes readiness even if a summary line is present.
  - Fail-closed negative tests ensuring that multiple lines after the sentinel or prose mentioning `Worked for` do not register as idle-sentinel. `codex` (`c9708f8f091dd21e57240bbb1a15a9b3532aec12`) provided an especially thorough parameterized check across multiple trailing variations and ANSI decorations.

#### 4. Readiness Policy Documentation (`docs/readiness-policy.md`)
- All four implementations updated lines 93–98 of `docs/readiness-policy.md` to document the new `← for agents · ? for shortcuts` footer line and the single permitted `Worked for …` turn-summary line.

### Conclusion

All four implementations (`cursor` `8524928479df04db525ad9ea81bd0c989093d72e`, `codex` `c9708f8f091dd21e57240bbb1a15a9b3532aec12`, `antigravity` `88babdba642d1290e80089e30fbe881557613f6b`, and `claude` `24fbca708b391f9322ab0435f4f9c40de3e8ed56`) faithfully implement the selected plan with minimal, clean diffs and complete test coverage. No defects or rule violations were found in any pin.

# Issue 181 — implementation comparison (cursor)

Bound implementation pins compared:

- cursor `8524928479df04db525ad9ea81bd0c989093d72e`
- codex `c9708f8f091dd21e57240bbb1a15a9b3532aec12`
- antigravity `88babdba642d1290e80089e30fbe881557613f6b`
- claude `24fbca708b391f9322ab0435f4f9c40de3e8ed56`

## Comparison

All four pins change only the approved product surfaces (`src/tmux.ts`,
`test/tmux.test.ts`, `docs/readiness-policy.md`) plus their own coordination
artifacts. None touch `src/runLoop.ts`, lifecycle defaults, or new modules.
Each admits the live Codex chrome that caused the stall: an optional
`← for agents ·` prefix on the shortcuts footer, and a single leading
`Worked for <duration>[ • <clock>]` turn-summary skipped inside
`linesAfterCodexSentinel` so `codexTail` / `codexNudgeSubmitted` share the fix.
Against the observed idle pane (COORD-IDLE, turn summary, dim empty `›`,
Context line, agents/shortcuts footer), every pin makes ready-file and
idle-sentinel delivery succeed while keeping draft, dialog, unknown-footer,
and `Working (… esc to interrupt)` vetoes.

### Product predicate

| Pin | `CODEX_FOOTER` agents prefix | `CODEX_TURN_SUMMARY` | Skip site |
| --- | --- | --- | --- |
| claude `24fbca708b391f9322ab0435f4f9c40de3e8ed56` | `←\s+for agents\s+·\s+` optional | duration + optional `•` clock; rule chars | `linesAfterCodexSentinel` |
| cursor `8524928479df04db525ad9ea81bd0c989093d72e` | same as claude | same as claude | same |
| codex `c9708f8f091dd21e57240bbb1a15a9b3532aec12` | same as claude | same as claude | same (equivalent `after[0]?.plain` form) |
| antigravity `88babdba642d1290e80089e30fbe881557613f6b` | `[·•]` separator class | `[·•]` before clock | same |

Claude, cursor, and codex match the selected plan’s literal middle-dot footer
form. Antigravity alone widens both patterns to accept a bullet separator that
the issue capture did not show.

### Tests and docs

- **claude** — updates the shared fixture footer, defaults the idle-sentinel
  nudge body to include the turn summary (so `submitOnCtrlJ` exercises
  post-submit acceptance through the summary), covers legacy footer via
  strip/replace, scrollback-above-sentinel stays `idle-sentinel`, and
  fail-closed cases for dialog/prose/`Working` after a summary. Docs name both
  footer forms, the one summary line, and that the file-backed path uses the
  same composer/footer rules without a sentinel.
- **cursor** — same production predicates as claude; solid fixture coverage
  including legacy footer helper and near-misses. Docs omit Claude’s explicit
  file-backed-path sentence (behavior is unchanged in `nudge`).
- **codex** — same predicates; strongest near-miss matrix (dim summary SGR,
  rule-form `─ Worked for 12s ─────`, trailing text on a summary-shaped line,
  second summary line, unknown footer line, `›` after a skipped summary). Docs
  are the most precise about grammar and rule decoration.
- **antigravity** — covers the happy path and several fail-closed cases; fewer
  near-misses than codex; docs match the behavioral change.

### Findings

1. `src/tmux.ts:130` (antigravity `88babdba642d1290e80089e30fbe881557613f6b`).
   Rule: pane chrome allowlists admit only observed, anchored forms so unknown
   dialog/transcript lines stay fail-closed. Failure: `[·•]` accepts
   `← for agents • ? for shortcuts` without a captured layout or fixture, so a
   future transcript line that uses a bullet separator could be treated as
   footer chrome. Illustrative test: keep the live `·` form green and assert
   `harnessPromptReadiness` stays `vendor-prompt` for a shortcuts line whose
   separator is an unobserved glyph the other pins reject—or drop `[·•]` and
   match the selected plan’s `·` only.

2. `docs/readiness-policy.md:93-97` (cursor `8524928479df04db525ad9ea81bd0c989093d72e`).
   Rule: the readiness policy must describe the predicates coord enforces,
   including that ready-file sends still require empty composer + known footer.
   Failure: an operator diagnosing `codex-composer-not-ready` from cursor’s doc
   alone can miss that file-backed delivery uses the same composer/footer rules
   without a sentinel (claude `24fbca70` states this explicitly). Fix sketch:
   restore Claude’s file-backed sentence beside the footer/summary list.

No pin leaves the ready-file stall in place for the observed capture. No pin
expands into lifecycle `unknown` / Antigravity `fullyIdle` changes rejected at
plan review.

### Verdict

Prefer **claude `24fbca708b391f9322ab0435f4f9c40de3e8ed56`**: it is the selected
plan’s implementation, matches the observed chrome exactly, documents
file-backed parity, and covers the idle-sentinel + turn-summary send path
without speculative character-class widening. **codex
`c9708f8f091dd21e57240bbb1a15a9b3532aec12`** is an equally safe product predicate
with the best fail-closed tests—acceptable if stronger near-miss coverage is
valued over the slightly tighter docs/plan fidelity of claude. **cursor
`8524928479df04db525ad9ea81bd0c989093d72e`** is functionally equivalent to
claude on `tmux.ts` (docs-only gap). **antigravity
`88babdba642d1290e80089e30fbe881557613f6b`** also fixes the stall but should drop
the unobserved `[·•]` widening before selection.

# Issue 186 implementation comparison

Pins compared (bound worktrees):

- claude `edab4cbee8b779be8d086b03232fcb21a4ce8ce9`
- cursor `e2868cbb3590997c9ddf91de04810ec02f3c9d0f`
- codex `89ab6ee45e8ad1da3886074bf1f5c2781d1a8c1a`

Selected plan (Claude): `--no-daemon` launcher, INSERT-aware `i` skip, bounded
composer settle + `C-m` re-press while the nudge remains, keep `sent` on
exhaustion, leave issue-176 submit proof and submit keys unchanged.

## Comparison

All three pins add `--no-daemon` to the Codex `launcher_command` exec line and
document it. Claude and Cursor stay on the selected product file map
(`scripts/lib/launcher.sh`, `src/tmux.ts`, `docs/coord-driver.md`,
`test/install.test.ts`, `test/tmux.test.ts`). Codex also edits `src/runLoop.ts`
and rewrites `codexNudgeSubmitted`, which the selected plan kept out of scope /
unchanged.

### Shared strengths

- Launcher flag matches the verified root cause for item 3 (hooks inherit the
  pane's `COORD_ISSUE`).
- `codexVimInsert` + ordinary-path skip of `i` when `Vim: Insert` is visible;
  unreadable footer still gets `i` on the ordinary path.
- Bounded settle / `C-m` confirmation while `codexComposerHolds`, without
  retyping the nudge text.
- Exhaustion still returns `sent` (selected plan contract; the mid-send
  amendment was rejected).

### Findings

1. **codex `89ab6ee45e8ad1da3886074bf1f5c2781d1a8c1a` — `src/runLoop.ts` ~1182–1226.**
   The pin threads a new `deliveryLifecycle` into ordinary Codex `nudge` calls
   and changes acceptance/changed detection for every Codex deliver. Rule: the
   selected plan's file map does not include `src/runLoop.ts`; lifecycle
   override authority must not expand without an approved map. Failure: review
   and final checks must validate reservation/hold semantics the selected plan
   never authorized, and a hook-sequence “changed” during ordinary confirmation
   can abort sends the selected shape would finish. Smallest correction: drop
   the `runLoop.ts` delta; keep confirmation inside `TmuxController.nudge` as
   Claude/Cursor do.

2. **codex `89ab6ee45e8ad1da3886074bf1f5c2781d1a8c1a` — `src/tmux.ts:217–232`
   (`codexNudgeSubmitted`).** The helper now counts new `›` transcript matches
   against a pre-send baseline and no longer requires `Working (… esc to
   interrupt)`. Rule: the selected plan states the issue-176 proof between keys
   is unchanged. Failure: acceptance can fire on a scrolled/re-painted message
   count without live turn chrome, or miss the Working-based proof existing
   override tests encode. Illustrative test: override send where C-j submits
   with Working chrome must still early-exit before fallback `C-m` using the
   prior predicate; a baseline-only match without empty composer + live chrome
   must not count.

3. **cursor `e2868cbb3590997c9ddf91de04810ec02f3c9d0f` — `src/tmux.ts:1151–1161`
   (confirmation retries).** After the configured submit keys, extra `C-m`
   presses run while the composer holds the nudge, but unlike Claude they do
   not re-check `harnessPromptReadiness` / turn chrome before `send()`. Rule:
   a confirmation key must not be typed into a live Codex turn. Failure: if
   `C-j` starts a turn while the composer paint still shows the nudge for one
   capture, Cursor sends another `C-m` into that turn. Illustrative test:
   ordinary path, after first `C-m` the pane shows Working chrome with the
   nudge still in the composer → no further `C-m` (Claude returns busy
   mid-send at `src/tmux.ts:1158–1159`).

4. **cursor `e2868cbb3590997c9ddf91de04810ec02f3c9d0f` — `src/tmux.ts:1069–1072`
   vs selected prelude rule.** Cursor skips `i` when
   `(override && !NORMAL) || INSERT`. On an override with a readable INSERT
   footer this matches Claude; the selected plan's wording is the ternary
   Claude implements (`override ? !NORMAL : INSERT`). Not a behavioral defect
   for the planned cases, but Claude's expression is the one the plan
   specifies and keeps override NORMAL/`i` identical to today's override rule
   without an extra OR.

### Relative fit

| Concern | claude `edab4cbe` | cursor `e2868cbb` | codex `89ab6ee4` |
| --- | --- | --- | --- |
| Selected file map | yes | yes | no (`runLoop.ts`) |
| `--no-daemon` | yes | yes | yes |
| INSERT `i` skip | yes (plan ternary) | yes (OR form) | yes (plan ternary) |
| Settle + bounded `C-m` | yes; settle also inside override `send` | yes; settle before submit loop | yes; heavier `checkProof` |
| Retry respects turn chrome | yes | no (finding 3) | via `checkProof` / lifecycle |
| issue-176 submit proof | unchanged | unchanged | rewritten (finding 2) |
| Exhaustion → `sent` | yes | yes | yes |

**Verdict:** Prefer Claude `edab4cbee8b779be8d086b03232fcb21a4ce8ce9`. It is the
closest faithful implementation of the selected plan: correct launcher flag,
plan-shaped prelude rule, settle/retry with a readiness gate before extra
`C-m`, no `runLoop` expansion, and unchanged submit-acceptance proof. Cursor is
a near peer but should not win while confirmation retries can key into live
turn chrome. Codex adds useful ideas (baseline-relative acceptance) but is out
of map and alters the frozen issue-176 proof; those belong in a revise or a
later issue, not this pin.

No product tests were run for this evidence-only comparison.

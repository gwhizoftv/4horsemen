# Issue 186 implementation comparison (claude)

## Comparison

This compares three bound implementation pins against baseline
`15c2973d02e848cc537efd8e7bf9acc56c0304ee`:

- claude `edab4cbee8b779be8d086b03232fcb21a4ce8ce9`
- cursor `e2868cbb3590997c9ddf91de04810ec02f3c9d0f`
- codex `89ab6ee45e8ad1da3886074bf1f5c2781d1a8c1a`

I read each pin from its bound worktree under
`coord-runtime/issue-186/worktrees/` and diffed it against baseline blobs taken with
`git cat-file`. I ran no product suites for this comparison. The coordinator owns
the final checks at the approved pin.

### Shared ground

All three pins implement the selected plan's core and stay inside the issue:

- **Launcher.** `scripts/lib/launcher.sh` adds `--no-daemon` to the Codex `exec`
  line. In `test/install.test.ts`, the argv-capture test's `expected.codex` gains
  `"--no-daemon"`. The three launcher changes are byte-identical apart from the
  comment.
- **Prelude.** `src/tmux.ts` gains `codexVimInsert(paneText)`. On the ordinary path,
  Codex's `i` prelude is skipped only on positive `Vim: Insert` evidence; the
  override path keeps its rule that `i` is sent only in NORMAL.
- **Submit confirmation.** It applies only when the first capture parses as a Codex
  composer (`codexTail(paneText, false) !== null`). It has a settle wait of at most
  `CODEX_SUBMIT_SETTLE_CHECKS = 4` captures before the first submit key, and at most
  `CODEX_SUBMIT_RETRIES = 2` extra `C-m` presses while the composer holds exactly the
  nudge. All three keep the plan's `sent` outcome when the retries run out, as the
  rejected amendment requires.
- **Docs.** `docs/coord-driver.md` documents the above.
- **Footprint.** None adds a file, dependency or abstraction. All extend the existing
  `test/tmux.test.ts` Codex stubs instead of adding a harness.

They differ in two places. One is how the extra `C-m` is guarded on the ordinary
path. The other is whether the issue-176 submission proof between keys changes.

### Pin by pin

**claude `edab4cbe`** (5 product files, about 104 insertions)

- **Settle wait.** Runs inside `send()` on the override path (`src/tmux.ts:1105`) and
  as one separate settle on the ordinary path. Existing override tests keep their
  capture indices and key lists unchanged.
- **Retry loop** (`src/tmux.ts:1151-1163`). Before each extra `C-m`, it re-runs
  `readinessForSend(latest)` (`src/tmux.ts:1158`), so an ordinary-path retry stops
  with a mid-send refusal when Codex shows turn chrome. On the override path,
  `send()` additionally re-runs the full proof and acceptance check.
- **Tests.** One stateful Codex stub with lost Enters and late paint covers:
  - INSERT versus NORMAL prelude;
  - one lost Enter;
  - the retry bound;
  - a late paint on the ready-file path.

  The cases were confirmed to fail against the baseline `src/tmux.ts` before the
  exhaustion contract was relaxed to `sent`.

**cursor `e2868cbb`** (5 product files)

- **Shape.** Nearly identical to claude's. The settle loop runs before the submit
  loop on both paths (`src/tmux.ts:1126-1136`), which shifts override capture indices.
  The existing test was correctly re-indexed (`index === 4`).
- **Retry loop.** `src/tmux.ts:1153-1162` has no readiness re-check; see finding 1.
- **Tests.** Equivalent coverage to claude's. They include a lag-on-override case and
  assert exhaustion stays `sent`.

**codex `89ab6ee4`** (6 product files, including `src/runLoop.ts`)

- **New submission proof.** Rewrites `codexNudgeSubmitted` into a comparison against
  the pre-send capture: a new exact `›` message plus an empty composer, with no
  `Working` requirement.
- **Shared proof routine.** Factors the per-key proof into `checkProof`, which now
  also runs on the ordinary path whenever the composer is readable.
- **Lifecycle on the ordinary path.** Adds a `deliveryLifecycle` parameter to
  `TmuxController.nudge`, fed from a refactored lifecycle closure in `RunLoop.deliver`
  (`src/runLoop.ts:1188-1203`, `1226`).
- **Value.** This is the only pin that removes the false `delivery-uncertain` hold
  when `C-j` already submitted and Codex shows a tool line instead of `Working` (my
  review's L2). It is also the only one that refuses to type over an owner draft on
  the ordinary path when the composer is readable.
- **Tests.** The strongest table: three sources, `C-j` accepting, lag, lost Enters,
  exhaustion, lifecycle accepted or changed, turn start, edit, lost capture, clear,
  and a stale identical transcript message. Assertions cover reservations and capture
  bounds as well as keys.
- **Cost.** It goes beyond the selected plan, which said the issue-176 proof between
  keys stays unchanged and named no run-loop change. Its `src/runLoop.ts` change has
  no run-loop test (finding 2).

### Findings

1. **cursor `src/tmux.ts:1153-1162`** (retry loop, ordinary path)
   - **Rule.** An extra `C-m` must not be sent into a Codex turn that is now running.
     On the ordinary path `send()` checks only the tmux gate, so the loop itself must
     re-check pane readiness first.
   - **Failure.** An ordinary send types the nudge, and the configured `C-m` is lost.
     Before the retry, Codex starts a turn (the live issue-186 pane showed exactly this
     interleaving: a nudge steered into a running turn), with the nudge still in the
     composer. `codexComposerHolds` is still true, because the `• Working (…)` line
     sits above the composer. So the loop presses `C-m` and submits the nudge as a
     steer into the unrelated running turn.
   - **Smallest test.** In the existing `run` helper, add an option that appends
     `• Working (1s • esc to interrupt)` to `pane.body` after the first `C-m`. Assert
     that the keys stop at `["-l", "C-j", "C-m"]` and the outcome is
     `{ status: "busy", stage: "mid-send" }`. Claude's pin returns that through
     `readinessForSend` (`src/tmux.ts:1158`), and codex's through `checkProof`.

2. **codex `src/runLoop.ts:1188-1203` and `1226`** (lifecycle observation for Codex)
   - **Rule.** A changed run-loop decision must have a run-loop test, because
     `test/tmux.test.ts` passes the lifecycle callback directly and never exercises
     `RunLoop.deliver`'s wiring.
   - **What changed, for Codex only:**
     - "accepted" now also requires a changed `hookReceipt.sequence`, a changed
       `acceptedAt`, and an unchanged `sessionId`;
     - any hook-sequence change now returns "changed" (`:1195`);
     - every ordinary Codex send now receives this callback (`:1226`).
   - **Failure.** A regression in these conditions would go unnoticed, because no test
     in the pin covers them. One example is a session replaced while a send is in
     flight, where the `latest.sessionId === entry.sessionId` clause turns a genuine
     acceptance into "changed". Every such ordinary send would end as `lifecycle-changed`
     mid-send, which is a `delivery-uncertain` hold: the issue's symptom 2 again. The
     approved paths do not include `test/runLoop.test.ts`, so the pin cannot add that
     coverage within scope.
   - **Fix sketch** (no test is possible within the approved paths). Keep the existing
     lifecycle closure unchanged. Pass it to ordinary Codex sends only for observing
     "accepted", and never map a bare hook-sequence change to "changed" on the
     ordinary path.

3. **claude `src/tmux.ts:1105`, `1111`, and `codexNudgeSubmitted` (`:218-236`)** (my
   own pin; the same applies to cursor)
   - **Rule.** A nudge Codex actually submitted must not end as a mid-send refusal.
   - **Failure.** On an override send, `C-j` submits. Codex clears the composer and
     paints `• Opened …` instead of `• Working (…)` before the check ahead of `C-m`.
     `codexNudgeSubmitted` still requires `codexTurnChrome`, so it is false. The settle
     wait cannot help, because the composer is empty rather than holding the text.
     `codexComposerHolds` then refuses with `codex-composer-not-ready` at `mid-send`,
     and `deliver` raises a `delivery-uncertain` hold for a delivered nudge. Codex's
     test row `acceptOn: "C-j"` (`• Opened current result`, sources `ready-file` and
     `idle-sentinel`) passes on codex's pin and would fail on claude's and cursor's.
   - **Weight.** Correctly routed `UserPromptSubmit` hooks (after `--no-daemon`) usually
     return "accepted" first, so this is a residual case. It is real, but outside the
     selected plan's text.

### Scope, reuse and test focus

| | claude | cursor | codex |
|---|---|---|---|
| Files outside the plan's file list | none | none | `src/runLoop.ts` (approved path, but not in the plan's list) |
| Plan fidelity | exact | exact | changes the issue-176 proof the plan said stays unchanged |
| Reuse | `codexTail` / `codexComposerHolds` / `send()` / `readinessForSend` | same, minus `readinessForSend` on retry | same, plus a refactor of the proof into `checkProof` |
| Ordinary-path retry guard | readiness re-check | gate only (finding 1) | full proof plus lifecycle |
| False hold after a `C-j` submit without `Working` | remains (finding 3) | remains | fixed |
| Test focus | 2 focused cases | 2 focused cases plus re-indexing | 1 broad table; run-loop wiring untested (finding 2) |

### Recommendation

**Prefer claude `edab4cbee8b779be8d086b03232fcb21a4ce8ce9`.**
- It implements the selected plan exactly, with the smallest footprint.
- Unlike cursor `e2868cbb3590997c9ddf91de04810ec02f3c9d0f`, it guards the
  ordinary-path retry against a newly running turn (finding 1).
- Cursor's pin is acceptable only after that fix.

**Codex `89ab6ee45e8ad1da3886074bf1f5c2781d1a8c1a`** has the most robust submission
proof and closes finding 3. However, it widens the change into `RunLoop.deliver`
without run-loop coverage (finding 2), and departs from the selected plan's stated
contract.

Its pre-send-relative `codexNudgeSubmitted` and its test table are the best candidate
for a follow-up issue that approves that behavior change explicitly, together with
the rejected mid-send-on-exhaustion change and `test/runLoop.test.ts` coverage.

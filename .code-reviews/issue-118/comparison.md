# Issue 118 implementation comparison — claude

Bound implementation pins compared:

- claude: `7d850e3549cddd9d50924c742781ac470543989e`
- codex: `17c3cf4f21786faed2eb0f30bb5e8a1ada7a6923`
- cursor: `270c9f035040dbac3f38ef79cda2dfa8ac080106`

All three implement the same selected plan (claude
`2dcc50606a58b412c4b6f527e39f578defb39456`) and touch the same twelve product
paths. Rather than compare them by reading, each pin was extracted with
`git archive`, type-checked, run against its own suites, built, and executed
against the real completed issue-121 runtime
(`/Volumes/4TB-SOURCE/REPOS/coord/coord-runtime/issue-121`) and against five
purpose-built legacy fixtures. Every number below is from those runs.

## Comparison

### Where all three agree, and are equivalent

On the production path the three pins are not merely similar — they are
numerically identical. Running `analytics --issue 121` from each build gives
the same per-agent figures:

| | claude `7d850e3` | codex `17c3cf4` | cursor `270c9f0` |
| --- | --- | --- | --- |
| codex unassigned token records (was 91) | 19 | 19 | 19 |
| codex unassigned cacheRead | 3,412,224 | 3,412,224 | 3,412,224 |
| cursor unassigned token records | 1 | 1 | 1 |
| unassigned tool records | 6 | 6 | 6 |
| run split | 335.46 / 0.00 / 335.46 min | identical | identical |

The shared substance, verified in all three diffs:

- **Cursor round trip** — a `normalizedTokenUsage` reader tried before
  `extractCursorTokenUsage` in `cursorUsageFromJournalDetails`, so the tokens
  the hook path normalizes are read back. All three then report `unavailable`
  (not `unsupported`) for a session with no token fields and collapse the dead
  `toolRecords > 0 ? "complete" : "complete"` ternary.
- **Stall-aware waits** — `!pendingNudge.has(key)` in **both** `deriveWaits` and
  `deriveResponseLatency`. No pin left the two tables on different rules.
- **Shared vendor turn** — the same rule and the same tie-break (all matching
  windows share `sessionId`+`turnId` ⇒ latest-started window, never `exact`,
  with a named reason); different `turnId`s stay unassigned.
- **Pause split, final-check duration, `tokenTotalReason`, `source`
  provenance** — present in all three, with `durationMs` measured around
  `processRunner` only and `null` (never `0`) when unmeasured.
- **Fail-closed control plane** — all three route path resolution
  (`matchesConfig`, `withStoredMailbox`) through a start-state header, and
  `coord run`/`coord status` on a legacy fixture still exit 2 with
  `Runtime format versions 2 and 3 are no longer supported…` in every pin.

The remaining differences are the whole of this comparison.

### 1. cursor `270c9f0` — a malformed known event is skipped, and the report then states a completed run's elapsed time 278× too high

`src/state.ts:832-836` (and `:818-823` for an unparsable line):
`readJournalForAnalytics` treats **any** line that fails `journalEventSchema` as
skippable — `if (!parsed.success) { skipped += 1; continue; }` — with no
distinction between an event type this build no longer knows and a malformed
record of a type it does know.

**Rule.** A reader may drop a record it cannot interpret only when dropping it
cannot change a reported number. The load-bearing event for every phase and run
metric is `gate-advanced` (`docs/analytics.md` §1.1: "the load-bearing event for
all phase analytics"), and the terminal one is what makes a run `complete`
rather than `in-progress` (`src/analytics.ts`, `terminalGate`).

**Failure.** Measured, not hypothesized. A format-2 fixture whose run started
`2026-08-19T00:00:00Z`, paused ten minutes, and ended at a terminal
`gate-advanced` was given an unparsable `at` on that final record only:

```
claude  exit=2   (Invalid journal line 4: … → at at)
codex   exit=2   (same)
cursor  exit=0   Run: 12527.62 min elapsed / 10.00 min paused / 12517.62 min unpaused (in-progress)
                 - R1.join: 12527.62 min; actions=0; in-progress
```

The true elapsed time is 45.00 min. Cursor's pin reports 12,527.62 min — the
final phase is stretched to `now` — labels a finished run `in-progress`, and
still prints a confident `Time` section above its
`- formatVersion=2; legacy=true; skippedJournalRecords=1` provenance line. A
count of skipped records does not make the numbers above it valid, and this is
precisely the number a before/after cost comparison would read. The same branch
also swallows an unparsable JSON line, so a truncated journal reports a
partial run as a whole one.

**Smallest test** (cursor's `test/analytics.test.ts` or its state coverage):

```ts
writeFileSync(paths.journal, [
  JSON.stringify({ formatVersion: 2, sequence: 0, at: "2026-08-19T00:00:00.000Z", type: "started", details: {} }),
  JSON.stringify({ formatVersion: 2, sequence: 1, at: "not-a-timestamp", type: "gate-advanced", details: { from: "R1.join", to: null } })
].join("\n") + "\n");
expect(() => readJournalForAnalytics(paths)).toThrow(/journal line 2/);
```

Skip only a line whose `type` is outside the current enum; throw on a known
type that fails validation. claude `7d850e3` and codex `17c3cf4` both already
do this — codex without a test pinning it.

### 2. claude `7d850e3` and cursor `270c9f0` — the legacy path ignores the roster that actually ran

`src/cli.ts` in claude `7d850e3` (analytics branch, `activeRoster:
header.originalRoster`) and the equivalent `else` branch in cursor `270c9f0`
deliberately do not read `cursors.json` for a legacy run.

**Rule.** Per-agent waits and the cross-roster total must describe the roster
that ran; an agent dropped mid-issue is not part of it. `coord drop` exists
precisely so the remaining roster is the one that matters, and the modern path
in all three pins honours `cursors.activeRoster`.

**Failure.** On a legacy fixture whose `cursors.json` records
`activeRoster: ["claude","codex"]`, `droppedAgents: ["cursor"]`:

```
claude   - claude - codex - cursor
codex    - claude - codex
cursor   - claude - codex - cursor
```

claude and cursor print a wait row for an agent that was dropped
(`count=0 median=unavailable`), and — on a format-3 legacy run, where session
identity exists and usage is computed — that agent resolves through
`unavailableUsage`, so `tokenCoverage` is `unavailable` and `tokenTotal` can
never be emitted for any legacy issue that ever dropped an agent. codex's
review of the plan raised exactly this, and codex `17c3cf4` is the pin that got
it right (`src/state.ts:887`, projecting `activeRoster` out of the legacy
cursors document rather than parsing it with the strict schema, which a
format-2 file cannot satisfy).

**Fix sketch** (a test cannot express the choice, only its effect): read
`activeRoster` from `cursors.json` through the same loose projection codex uses,
and fall back to `originalRoster` only when that file is missing or unreadable.

### 3. codex `17c3cf4` — requiring `cursors.json` to prove completion refuses reports it could produce, and crashes rawly when the file is absent

`src/state.ts:887-892`: `readAnalyticsRuntime` parses `cursors.json` for every
legacy run and throws unless `completed === true`.

**Rule.** A read-only reporting command should fail only when it cannot produce
a truthful report. `docs/analytics.md` §5 states that historical journals stay
useful "rather than failing", and `buildAnalytics` already models an unfinished
run as `in-progress` — a state it renders for modern runs in all three pins.

**Failure.** Two measured cases on the same journal, which by itself carries a
terminal `gate-advanced` proving completion:

```
cursors.completed=false   claude exit=0  cursor exit=0  codex exit=2
                          codex: "Legacy runtime for issue 500 is not completed; analytics will not make it resumable."
cursors.json absent       claude exit=0  cursor exit=0  codex exit=2
                          codex: "Cannot parse …/cursors.json: ENOENT: no such file or directory…"
```

An abandoned legacy experiment — the kind of run a before/after baseline most
wants — reports nothing, and a missing sibling file surfaces a raw Node
`ENOENT` rather than a coordinator-shaped message. Note the gate is defensible:
the issue text says "read **completed** legacy journals", and codex is the
only pin that reads it literally. The cost is the two rows above, and the
dependency is on a *different* file than the one that proves completion.

**Smallest correction.** Take completion from the journal's terminal
`gate-advanced` (already computed), keep reading `cursors.json` for
`activeRoster`, and degrade to `originalRoster` with a provenance note when it
is missing rather than throwing.

### 4. cursor `270c9f0` — the only pin that also fixes the exact-turn collision

`src/analytics.ts`, `result.turns` loop: cursor replaces
`agentTurns.find((turn) => …)` with `filter` plus the same
`resolveSharedTurnPhase` helper used for unattributed records.

**Rule.** One vendor turn serving two coordinator actions must never be
resolved silently to whichever action happens to be first in the list — the
same rule the shared-turn work exists to enforce.

**Failure this prevents.** On the exact-turn path, `find` returns the
earliest-started matching action and discards the rest, attributing the later
action's usage to the earlier action's phase **with `exact` coverage**. Codex
transcripts do not exercise it (0 of 308 `token_count` rows carry `turn_id`),
but journaled Cursor hook usage is turn-keyed by `generation_id`, so a reused
generation across two prompts hits it. claude `7d850e3` and codex `17c3cf4`
both left `find` in place; this is cursor's one clear advantage and should be
carried into whichever pin is selected.

### 5. Labelling and test-shape differences

- **Wait heading.** After the pairing rule changed, claude `7d850e3` renders
  `Agent wait (first outstanding nudge -> intent-seen)`; codex `17c3cf4` and
  cursor `270c9f0` still render `Agent wait (nudged -> intent-seen)`. The
  reported medians changed on the same journal (cursor's wait median on issue
  121 moved 31.8s → 33.4s), so the unchanged label now names a rule the numbers
  no longer follow. `docs/analytics.md` is updated in all three; only the
  report line disagrees.
- **Focused tests per gap.** The acceptance item asks for a focused test per
  gap. claude adds 14 cases, cursor 9 (including the only dedicated
  `runLoop` case, `records final-check durationMs around the hermetic check
  runner`), codex 5 — codex bundles gaps 5, 6 and 7 into one case
  (`subtracts paused time, anchors retries at the first nudge, and keeps
  missing check duration null`), so a regression in any one of the three fails a
  test whose name does not identify it, and codex's correct malformed-event
  behaviour (finding 1) is pinned by no test at all.
- **Smaller items.** cursor widens `journalEventSchema.formatVersion` to accept
  `2`, which its own reader never needs because it normalizes to `4` before
  parsing, and drops `.min(1)` from `originalRoster` in the header schema that
  claude and codex both keep. codex journals the `final-check` record at the
  measured completion instant rather than calling `this.now()` a third time,
  which makes `at - durationMs` exactly the check's start — the tidiest of the
  three.
- **Suite health.** All three type-check clean and pass `analytics`,
  `cursorHookUsage`, `state` and `runLoop` suites in an extracted tree. The nine
  `test/cli.test.ts` failures observed there are an artifact of running from a
  `git archive` extraction with no `.git` directory — claude's pin fails the
  identical nine — so they are not attributable to any implementation.

## Verdict

**codex `17c3cf4f21786faed2eb0f30bb5e8a1ada7a6923` is the soundest base**, with
two amendments. It is the only pin with no wrong-output defect *and* the only
one that reports a legacy run against the roster that actually ran (finding 2).
It should take cursor's exact-turn collision fix (finding 4), and its legacy
completion gate should be sourced from the journal's terminal gate rather than
from `cursors.json`, so an abandoned legacy run reports and a missing file does
not surface an `ENOENT` (finding 3). Its thin, bundled tests (finding 5) should
be split, and the malformed-known-event behaviour it already implements
correctly deserves the test it lacks.

**claude `7d850e3549cddd9d50924c742781ac470543989e` is a close second**: no
wrong output, the strongest test coverage, and the only pin whose wait label
matches its own rule — but it shares cursor's legacy-roster gap (finding 2),
which is a real reporting error on any legacy issue that dropped an agent.

**cursor `270c9f035040dbac3f38ef79cda2dfa8ac080106` must not ship its journal
reader as written.** Finding 1 is a measured wrong number — 12,527.62 min
reported for a 45.00 min run, labelled `in-progress` when the run completed —
and it is the exact failure mode the plan review predicted. Its exact-turn fix
(finding 4) is nonetheless the single best idea in the three pins and should be
carried forward regardless of which is selected.

Selecting any of the three delivers identical numbers on real production data;
the choice is decided entirely by behaviour on malformed and dropped-roster
history, and on that basis the order is codex, claude, cursor.

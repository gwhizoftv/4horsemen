# Code review — PR #141 "Stop unbounded coordinator nudges and deferral journals"

Reviewed at head `17ffddc`, base `main` @ `ae991b8`. Owner-driven manual review;
no coordinator artifacts were created.

Scope check: the PR does what the approved split asked. `journalDeferral` is
deduped before the journal append, the breaker is vendor-agnostic, and the
launcher / `--settings` / App Server work is correctly absent. Budget arithmetic
is right (one initial send plus three repeats at 60/120/240s, then latch), and
the `began` / `stage: "gate"` split so a pre-send gate refusal cannot fabricate a
`delivery-uncertain` hold is a genuinely good piece of design.

Findings 1 and 2 are the blocking pair: the central feature of this PR does not
fire on the vendor output it was written for, and its tests cannot detect that.

## Findings

### 1. `src/tmux.ts:113` — the usage-wait veto misses most real Claude banners

**Rule.** A veto that exists to stop the coordinator typing into an armed vendor
wait must match the lines that vendor actually renders. Claude Code documents its
wait states verbatim in `interactive-mode#wait-for-a-usage-limit-to-reset` and
`errors#youve-hit-your-session-limit`.

**Failure.** `claudeUsageWait` anchors every alternative at `^\s*` with an
optional single character from `[⏸⏳!⎿●]`, and its cancel/stop alternative matches
`continuation|wait`, not the documented word `continue`. Running the shipped
regex against the documented strings:

| Documented line | Result |
| --- | --- |
| `Usage limit reached · continuing automatically at 3:45pm · esc to cancel` | veto |
| `You've hit your Opus limit · resets 3:45pm` | veto |
| `Usage limit reset · continuing automatically` | **miss** |
| `continuing shortly` | **miss** |
| `Your usage limit has reset · press enter to continue` | **miss** |
| `Automatic continue cancelled` | **miss** |
| `Automatic continue stopped after repeated usage-limit hits · /rate-limit-options to try again` | **miss** |
| `⠧ Usage limit reached · continuing automatically at 3:45pm` | **miss** |
| `│ Usage limit reached · continuing automatically at 3:45pm │` | **miss** |

Seven of nine miss. The consequences are concrete and are the exact loop this PR
exists to stop. Claude Code documents that "**You send a prompt**: Claude Code
runs your prompt instead of waiting" — so on a missed banner the coordinator's
send cancels the armed wait, the next turn re-hits the same limit, `StopFailure`
fires, and the repeat budget burns down to a `nudge-loop` hold. The agent ends up
held for a reason the coordinator itself caused, and the reset it would have
waited out is still hours away.

The braille miss is the most likely one in practice. This same file already
solves it: `SPINNER_PREFIX = [\s⠀-⣿]*` at `src/tmux.ts:99` exists
because a live TUI paints braille spinner frames ahead of status text.
`claudeUsageWait` does not reuse it.

**Test.** Replace the `it.each` fixtures at `test/tmux.test.ts:63-66` with the
seven documented strings above; six fail on this head. Reusing `SPINNER_PREFIX`
in place of the `[⏸⏳!⎿●]` class, dropping the `^\s*` anchor for the
`Usage limit (reached|reset)` and `continuing (automatically|shortly)`
alternatives, and matching `continue` alongside `continuation` fixes all of them.
Braille codepoints are disjoint from `>`, `-` and backtick, so the existing
quoted-prose test at `test/tmux.test.ts:70` still passes.

### 2. `test/tmux.test.ts:63-66` — the veto fixtures are invented, not vendor output

**Rule.** A test for vendor-output matching must assert against strings the
vendor documents or emits. Otherwise it validates the implementation against
itself.

**Failure.** Three of the eight fixtures — `"Automatic continuation cancelled"`,
`"Wait stopped"`, `"Select an option for this usage limit"` — appear nowhere in
Claude Code's documentation or output. They exist only as alternatives inside the
regex under test. `"Continuing automatically"` is tested as a standalone line,
but Claude renders it mid-line after `·`, where the `^\s*` anchor cannot reach it.
This is why finding 1 shipped green: the suite asserts that the regex matches the
regex. Every future edit to this pattern inherits the same blind spot.

**Test.** The fixture list becomes the documented-strings table from finding 1,
sourced by URL in a comment above the `it.each`. A test that cites where its
input came from cannot drift back into self-validation.

### 3. `src/runLoop.ts:2229` — harness-gone no longer recovers a pushed submission

**Rule.** A PR scoped to bounding nudge frequency should not delete an unrelated
automatic recovery path. AGENTS.md: keep the work within the issue and make the
smallest change that fully solves it.

**Failure.** The diff removes the entire `harnessGone` block from `runTick`
(`pushedThenDied` now appears zero times in the head). Previously, when an agent
pushed a complete, valid submission and its harness then exited, the coordinator
fetched the branch tip, ran `evaluateEvidence` plus `verifyFinalizationChecks`,
journaled `intent-seen` with `pushedThenDied: true`, and advanced the gate. Now
`observeUnfinished` sees `!pane.alive`, creates a `harness-gone` hold, and the
issue stops until a human runs `coord resume --hold <id>`.

The work is finished, pushed, and verifiable at origin; the only thing missing is
a live pane. For an unattended overnight run this is strictly worse than the
behavior being replaced, and the failure it now produces is indistinguishable
from the stall this PR set out to fix.

**Test.** An agent whose pane is dead and whose branch tip satisfies its order
should still produce `intent-seen` and advance. The existing run-loop fixture
already builds this shape; assert the gate advances rather than that a hold is
created. If the removal is deliberate, the PR body should say why the pushed-tip
path is unsafe, because the plan under review did not propose removing it.

### 4. `src/runLoop.ts:879` — a `vendor-wait` hold can never release itself

**Rule.** "Handle gracefully" in issue #126 means the coordinator survives a
usage window. A condition that resolves on its own should not require human
intervention to clear.

**Failure.** Claude's automatic continue is on by default in interactive
subscription sessions — the exact configuration coord drives in tmux. The
sequence: Claude hits a 5-hour limit at 01:00, coord correctly vetoes and holds
`vendor-wait` with `retryOwner: "vendor"`, Claude's own waiter resumes at 03:45,
the agent finishes the action and writes `complete`. The completion bytes are
preserved, as the PR intends — and then nothing happens, because `releaseHold`
is reachable only from the CLI. At 09:00 a human resumes an issue that finished
its work six hours earlier. Every subsequent action in that issue is serialized
behind a person.

This is the single most common quota case on the most common configuration.

**Fix sketch** (a test cannot express the intended behavior until it exists). For
`reason === "vendor-wait"` only, release the hold when the agent's completion
marker appears, or when lifecycle `lastEventAt` advances past `hold.observedAt`.
Both are evidence the vendor's own retry succeeded; neither infers capacity from
elapsed time, so this stays inside the "no automatic resume" line the PR draws.
If the intent is to defer this to #140, `docs/coord-driver.md` should state that
a Claude native wait halts the issue until an owner resumes, so operators do not
discover it at 09:00.

### 5. `src/runLoop.ts:1187` — unknown deferral reasons collapse into one bucket

**Rule.** #126 exists because the coordinator could not say *why* an agent stopped
responding. A deduplication added to bound the journal must not erase distinct
causes.

**Failure.** `code = Object.hasOwn(DEFERRAL_RATIONALE, code) ? code : "unknown"`
rewrites every unrecognized reason to the literal `"unknown"` *before* the
`safety.deferrals.includes(code)` check. Three genuinely different unrecognized
blockers on one action therefore produce one journal row: the first one's `human`
and `detail`, labelled `unknown`. The second and third are never recorded in any
form. Unrecognized codes are precisely the ones an operator needs the detail for
— a recognized code already has a rationale string.

**Test.** Journal two deferrals for the same action with different unrecognized
codes and assert two `nudge-deferred` events with distinct `detail`. Keying the
dedupe on the raw code and using `"unknown"` only for the rationale lookup fixes
it; cap `deferrals` at a small bound if unbounded growth is the concern.

### 6. `src/runLoop.ts:2229` — `"harness-gone"` is now an unreachable cursor status

**Rule.** A status filter should name states the code can still reach.

**Failure.** All three `replaceCursor(..., { status: "harness-gone" })` call sites
are removed by this diff; the head sets that status nowhere. The `includes`
filter at line 2229 still lists it, so a reader reasonably concludes the state is
live and that `observeUnfinished` re-examines harness-gone agents. It cannot.
Combined with finding 3, this is the residue of a removed subsystem.

**Test.** Not test-expressible. Either drop `"harness-gone"` from the list, or
restore setting it alongside the hold so `coord status` can still distinguish a
dead harness from a held-but-live one.

### 7. `src/state.ts:987` — the identity dedupe now scans the whole journal per append

**Rule.** A guard added for a rare event should not change the cost of a common
one.

**Failure.** The identity check previously ran only for `decision-derived`, which
is rare. It now runs for any event whose details carry `eventId`, and each run is
a full `readJournal(paths)` parse plus a linear scan. `nudge-deferred`,
`hold-created` and `paused` all carry one. On a long-running issue the journal is
the largest runtime file, and every hold or first-of-its-kind deferral re-parses
it. This is bounded work per event but unbounded in journal length, which is the
growth direction the issue complains about.

**Test.** Not the right tool; this is a cost observation. Bounding the scan to the
journal tail, or matching on the last-N events, keeps the crash-safety property
that motivated the generalization.

## Verdict

**Request changes.** Findings 1 and 2 are blocking and coupled: the veto is the
load-bearing behavior of this PR, it does not fire on most real Claude output,
and the tests are structurally unable to show that. Fix them together — fixtures
first, so the six failures are visible before the pattern changes.

Finding 3 is blocking as a scope and regression matter: an automatic recovery
that worked was deleted, and the plan under review did not propose deleting it.
Restore it or justify the removal in the PR body.

Finding 4 is the one I would most want a decision on rather than a specific
patch. As it stands the most common quota scenario on the default Claude
configuration converts into an indefinite halt, which is a defensible scope line
for #140 but should be a stated choice in `docs/coord-driver.md`, not a
discovery.

Findings 5 through 7 are non-blocking; 5 is worth taking in this PR because it
directly undercuts the issue's own diagnosability goal.

The reservation and budget core is sound and I would not want it reworked. The
problems are concentrated in the vendor-output boundary and in what the diff
removed along the way.

# Issue 254 plan review

Bound plans reviewed (read from the action's Bound input files):

- muse `8ea5f65dd9cf9321ab3a1a9467bea19d7db0afa4`
- claude `46d506425be4ec2fb9ff6207fd7276c8e7c86e20`
- antigravity `61adde90c2fd4cf2f0a7b7b87176b9b35ccd456b`
- codex `f88e18d0584622bc231dad87277aa19ed58cc943`

All four plans propose the same two production changes, and both are correct
against baseline `7a8fc0272c80e364681d08437111f4534cd7a181`:

1. `src/agentLifecycle.ts:567`: `containment: sessionChanged ? null : entry.containment`.
   A same-session or id-less `session-end` keeps `entry.sessionId`
   (`sessionId = incomingSession ?? entry.sessionId`). A `session-end` from
   another session already returns early at line 518. Only a replacement
   `session-start`/`status` clears containment.
2. `src/issueReport.ts`: gate `uncertain` (line 94) on `!cursors.completed`.
   For completed issues, pass `undefined` to `containmentCoverage` at the
   per-agent site (line 233). That uses the existing "no live comparison"
   mode while keeping the in-run corroboration checks: matching session,
   binding and policy revision, `denial.at <= probe.at`, and a known vendor
   version. `needsAction` keeps its precedence.

I checked the shared assumptions:

- Every status surface (`src/cli.ts:1092`, `src/cli.ts:1796`,
  `src/runLoop.ts:3415/3449/3452`) goes through `renderIssueReport`.
- The issue's `renderAgentStatusLines` does not exist; every plan notes this.
- `src/runLoop.ts:1084` (startup) and `src/runLoop.ts:2105` (`R1.join`
  journal) run only for live issues. All plans correctly leave them, and
  `ingestContainmentProbe` in `src/shellGuard.ts`, unchanged.
- No plan creates a product or test file, adds a dependency, or changes the
  schema. Each new test joins `test/agentLifecycle.test.ts` or
  `test/issueReport.test.ts`.
- Each plan replaces the now-obsolete assertion at
  `test/agentLifecycle.test.ts:85` instead of deleting coverage.

## Findings

### F1 (codex plan, Tests item 2 and Reuse and Scope): changing the report roster to `codex`/`claude` can make the completed-header assertion pass without testing anything

- **Plan claim.** The plan adds "one compact parameterized report test for
  `codex` and `claude`", "adapting the report fixture roster to
  `codex`/`claude` where needed", with temporary shim and settings bytes
  under a temp clone root. It asserts that the completed report "begins with
  `[OK] Issue 1: complete`".
- **Rule.** A regression test must fail on the baseline and pass after the
  change because of the behavior under test. Both `uncertain`
  (`src/issueReport.ts:94`) and the per-agent loop
  (`src/issueReport.ts:230`) iterate `cursors.activeRoster`, not
  `start.agents`.
- **Failure as written.** The shared `complete()` fixture
  (`test/issueReport.test.ts:41-110`) hard-codes `activeRoster: ["cursor"]`.
  Suppose the implementer adapts only `start().agents` to the temp-root
  `codex`/`claude` entries, which is the part the plan describes.
  - On the baseline, `uncertain` evaluates `lifecycle.agents.cursor`, which
    is missing or has unknown health, so the header is `[WARN]`.
  - After the fix, `!cursors.completed` makes it `[OK]` whatever the
    evidence says. The header assertion therefore flips for reasons
    unrelated to the codex/claude containment evidence and the changed
    policy bytes.
  - Meanwhile the per-agent loop skips `codex`/`claude`, so
    `containment hook=active` never appears and that assertion fails even
    with a correct fix.

  The result is a red test against a correct implementation, or a test
  "fixed" by weakening its per-agent assertion. If the implementer instead
  edits the shared `start()` fixture, the existing `"Agent cursor: ..."`
  assertions at `test/issueReport.test.ts:222-233` break.
- **Smallest correction.** Override `start().agents` and
  `complete().activeRoster` locally to the same single agent. Better, drop
  the vendor parameterization: `renderIssueReport` is vendor-agnostic, and
  `containmentPolicy`'s per-vendor path dispatch is unchanged by this issue.

### F2 (codex plan, Tests items 2-3): the proposed test volume goes beyond "the fewest focused tests"

- **Plan claim.** Beyond the two regressions, the tests include:
  - real-disk policy fixtures, repeated per vendor and again after deleting
    the settings file;
  - a health/absent-entry table for both completed and unfinished issues;
  - a failed-publication `[ACTION]` precedence case;
  - a denial/probe binding-mismatch case.
- **Rule.** The action and AGENTS.md "Implementation discipline" call for the
  fewest focused tests that fail before the change and pass after it.
- **Failure as written.**
  - Most added cases are pure regression guards on code this issue does not
    change. `needsAction` precedence at line 100 and the
    `denial.binding === probe.binding` corroboration inside
    `containmentCoverage` stay unchanged, and the mismatched-binding
    behavior is already pinned at `test/agentLifecycle.test.ts:79`. They pass
    on the baseline, so they cannot show the fix.
  - The real-disk fixture adds `mkdtemp`/teardown and imports
    `agentLifecycleHookPath` and `GIT_WRAPPER_RELATIVE_PATH` into a test file
    that is currently pure.
  - The fixture proves nothing the missing-root fixture misses: `/c` already
    makes `containmentPolicy` return `null`, which differs from any recorded
    `probe.binding` and exercises the same `probe.binding !== binding` branch.
- **Severity.** Non-blocking. I checked that the temp-root policy paths
  (`<clone>/.codex/hooks.json`, `<clone>/.claude/settings.local.json`,
  `<clone>/.coord/bin/git`) are clone-relative, so the fixture would not
  touch real user settings.
- **Smallest correction.** Keep one completed/live pair, and at most one
  degraded-health completed assertion, using the existing `/c` root.

### F3 (muse plan, File List `src/issueReport.ts`): `coverageFor` has a branch the top-level cue can never reach

- **Plan claim.** The plan adds a module-local `coverageFor(entry, root, id, completed)`,
  used by both the top-level cue and the per-agent lines, and also gates the
  cue with `!cursors.completed`.
- **Rule.** Justify every new abstraction and avoid speculative flexibility
  (AGENTS.md "Implementation discipline").
- **Failure as written.** Once the cue is gated on `!cursors.completed`,
  `coverageFor` runs at the cue only with `completed === false`. The
  `completed ? undefined` branch is reachable only from the per-agent site.
  The helper therefore saves one ternary at one call site while adding a
  four-argument function whose `completed` parameter is constant at the
  other. Nothing breaks, but the diff grows with no behavioral gain.
- **Severity.** Non-blocking.
- **Smallest correction.** Inline the ternary at `src/issueReport.ts:233` and
  leave line 98 as-is behind the `!cursors.completed` gate. This is what the
  claude and antigravity plans do.

No blocking defects in the claude or antigravity plans. Both stay inside the
four named files, reuse the existing fixtures (`entry`, `digest`, `later`,
`start`, `complete`, `initialAgentLifecycle`), and add only regressions that
fail on the baseline, plus one unfinished-issue control. One portability
note on antigravity's development command: it omits `--config`
(`pnpm vitest run test/...`). Vitest's default config discovery resolves
`vitest.config.ts` here, so the command works as written.

## Conclusion

All four plans fix both mechanisms correctly with the same minimal production
diff and no new files, schema changes or dependencies.

- **muse and antigravity:** acceptable as written. Muse's helper (F3) is a
  non-blocking simplification.
- **claude:** acceptable as written. This is my own plan; I found no defects
  after re-checking it against the baseline.
- **codex:** production plan correct. Its report test must override
  `activeRoster` together with `start().agents` or drop the vendor
  parameterization (F1); otherwise its per-agent assertion fails against a
  correct fix, and its header assertion passes for an unrelated reason. Trimming the extra regression-guard cases (F2) is
  recommended but not blocking.

Preferred basis for implementation: the claude or antigravity plan. They have
the smallest diff, and their tests fail on the baseline and isolate the change.

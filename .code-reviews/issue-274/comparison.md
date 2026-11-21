# Issue 274 implementation comparison

Bound implementation pins compared:

- antigravity `76c894beac6c031d3b19ba299f38031df6323de9`
- claude `c8e84f7dec019326ec15a8bc78e1e06cbe9b5e92`
- codex `ff24cca4b8e2c496c0f7633004b264509b5d015d`

## Comparison

### Method

I read the three pinned worktrees and compared them with plain `diff -u`
between them (`src/cli.ts`, `docs/coord-driver.md`, `test/cli.test.ts`). All
three share the frozen baseline `66346c2983e0cc56fc1e2d14dce5a25c9b1cd03d`, so
the differences between them are exactly where the implementations diverge.

I also checked baseline facts that the tests rely on:

- `TmuxController.sessionName("manual")` returns `coord-manual-<group>`
  (`src/tmux.ts:849`), so antigravity's `name.startsWith("coord-manual-")`
  stub really does simulate an open manual session.
- `readStartStateHeader` is only needed for legacy-format reads
  (`readAnalyticsRuntime`). The operational paths use `readStartState`, so
  codex's and antigravity's choice of that reader is fine.

I ran no product tests for this comparison. For my own pin, the pre-commit hook
(fast and system suites) and the pre-push hook both passed when I published
`c8e84f7d`. I have no verification results for the antigravity and codex pins
and claim none.

### Scope and file map

All three pins change exactly the approved files: `docs/coord-driver.md`,
`src/cli.ts` and `test/cli.test.ts`. None adds a file, dependency, schema
field or config mutation, and none touches `onboard`/`install` parsing. Each
keeps the full configured list for `resolveSafeCoordRoot`,
`resolveSafeCompletesRoot` and the leftover-session `detachIssue`, and
narrows only the issue `roster`. Each also adds `"agents"` only to the
numeric and `start` `allowedFlags`.

### Behaviour: all three are equivalent on the selected plan's contract

| Contract (codex plan) | antigravity | claude | codex |
|---|---|---|---|
| CLI order, trimmed, exact-case ids | yes | yes | yes |
| Unknown / repeated / empty argument / empty field → exit 2 | yes | yes | yes |
| Multi-agent solo refused; one named non-first agent allowed | yes | yes | yes |
| All refusals before `assertNoManualSession` and any effect | yes (dispatch) | yes (dispatch) | yes (inside `startIssue`, before the prompt, which moved there) |
| Resume: same ordered list resumes; different list or order refused | yes | yes | yes |
| Resume compares `originalRoster` regardless of current/default profile | yes | yes | yes |
| Bare `coord N` resumes unchanged | yes | yes | yes |

I traced each refusal path in each pin and found no ordering or
side-effect defect.

- In codex, `assertNoManualSession` moved into `startIssue` at
  `src/cli.ts:1190`, after selection and the solo check. The `start`
  dispatch no longer calls it. That is one call per fresh start, the same
  count and order as the baseline, and `coord start N` on an existing
  runtime still reaches the prompt before the "Runtime state already
  exists" error, exactly as on the baseline.
- In antigravity and claude, the selection is validated in the dispatch and
  `startIssue` receives resolved records.
- All three look up `existingIssueRuntime` before the manual-session
  prompt. It only reads state.

### Findings

No finding meets the bar of a rule plus a concrete failure in any pin. The
differences below are about quality and maintainability, not correctness.

1. **codex — `src/cli.ts:524`: the unknown-id diagnostic gives less help.**
   The message is `Agent '<id>' is not configured for this workspace.`. It
   names neither the config file nor the valid ids. antigravity
   (`src/cli.ts:517`, `... is not configured in <configPath> (configured: …)`)
   and claude (`src/cli.ts:525`, `... configured agents: …`) list both. The
   issue only requires an error, so this is not a defect. It does mean a
   typo costs the owner an extra lookup in `config.json`.

2. **codex — `test/cli.test.ts:397`: an existing test's premise is
   repurposed.** "does not update or replace the version snapshot on attach,
   resume, run, or numeric continuation" used to start the default
   full-roster issue. It now starts `--agents cursor,claude`, drops
   `claude`, and switches the default profile to solo before the recovery
   loop. It then also asserts the mismatch refusals. The original claims
   (no maintenance, `start.json` unchanged) still hold, and the plan
   explicitly called for "Extend the existing numeric continuation
   coverage". The cost is that one test now verifies two concerns, and the
   default-roster version of the snapshot check is gone. Default-roster
   numeric continuation is still exercised elsewhere in the file.

3. **antigravity — `docs/coord-driver.md:256` and `:275`: operator prose
   leaks an internal name, and the daily example is ambiguous.**
   `coord 42 --agents …` is appended to the "daily command" block right
   after `coord 42`, so the block reads as two commands to run in sequence.
   The prose names the internal state field `originalRoster`. Both are
   wording only.

4. **claude — `test/cli.test.ts:224`: continuation after `coord drop` is not
   covered.** My continuation case changes the default profile to solo but
   never drops an agent. So nothing asserts that replaying the original list
   after a drop compares against `originalRoster` rather than `activeRoster`.
   The code does compare `originalRoster` (`src/cli.ts:556`), but a
   regression to `activeRoster` would pass my suite. Both antigravity and
   codex cover this: they drop `claude`, replay `cursor,claude`, and expect
   a resume with `activeRoster` `["cursor"]`. Smallest test: in the
   continuation case, run `drop claude --issue 1` before the replay loop and
   assert `readCursorsState(paths).activeRoster` equals `["cursor"]`
   afterwards.

### Reuse and test focus

- **Reuse:** all three reuse `resolvedAgents`, the `roster` pipeline in
  `startIssue`, `existingIssueRuntime`, `readStartState(Header)`, and the
  `setup` / `successfulStartGit` / `fakeLoop` fixtures. antigravity and
  claude reuse the `src/install.ts` duplicate message
  `--agents lists '<id>' more than once.`. codex uses the same text.
- **Size:**
  - codex's `src/cli.ts` change is the smallest: one 12-line selector, with
    the solo and resume checks inline.
  - claude adds three small named helpers (`selectedAgents`,
    `assertSoloSelection`, `assertResumeSelection`) and one help-notes
    sentence.
  - antigravity adds two helpers and uses a `Map` lookup.
  - None of the three is speculative.
- **Tests:**
  - **codex** has the fewest cases. Its error table runs one entry point
    per row and proves no-prompt by asserting `sessionExists` is never
    called. That is the strongest guard, since it shows the manual-session
    probe is not even reached.
  - **claude** runs every error row through both entry points, with
    `sessionExists: true` and an assertion that `confirm` is never called.
    It puts the block next to the related maintenance tests.
  - **antigravity** is the most thorough. It runs both entry points, adds a
    trailing-comma row, and covers drop plus a profile change. It appends
    its block at the end of the file. All its assertions target roster
    consumers the change narrows, so the breadth is justified, if larger
    than necessary.

### Recommendation

All three pins implement the selected plan correctly and stay within scope.

- **codex** is the smallest change and follows the plan most literally.
- **claude** gives the clearest diagnostics and help text, but lacks the
  drop-continuation test (finding 4).
- **antigravity** has equivalent code, the broadest tests, and two doc
  wording nits (finding 3).

Any of them is acceptable for publication. I would rank codex first for
minimality and plan fidelity, with claude and antigravity close behind.
Adopting the configured-id list from finding 1 would improve codex's
diagnostic, but it is not required.

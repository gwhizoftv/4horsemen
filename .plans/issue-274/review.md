# Issue 274 plan review

Reviewed plans (bound inputs):

- codex `8d35e7358c6950d37273bc0ff44c1d78db76fae9` — `.plans/issue-274/plan.md`
- claude `13a88fdf0ae7ed34ddfbfbe266dd078ec20b46e5` — `.plans/issue-274/plan.md`
- antigravity `8b884baed15fc16f9fd34674772cd3a4362a2059` — `.plans/issue-274/plan.md`

All three plans agree on the core design, and it is sound:

- `--agents` goes on `coord <issue>` and `coord start <issue>` only.
- The selection keeps the command-line order. Unknown and repeated ids are
  errors.
- The full configured list stays the input to `resolveSafeCoordRoot`,
  `resolveSafeCompletesRoot` and the leftover-session `detachIssue`. Only the
  issue `roster` narrows.
- The selection is recorded through the existing `originalRoster`.
- On resume, a list that matches `originalRoster` is accepted and a
  different one is refused.
- No new files, schema fields or dependencies. All tests go in the existing
  `test/cli.test.ts` with the `setup` / `successfulStartGit` / `fakeLoop`
  fixtures.

The plans stay within the issue and reuse existing code. The findings below
are the places where following a plan as written gives a wrong result.

I checked the repository facts cited below against the baseline checkout:
`src/cli.ts` (the `runCli` catch, `assertNoManualSession`, the numeric and
`start` dispatch), `vitest.config.ts`, `vitest.system.config.ts`,
`src/state.ts` `startStateHeaderSchema`, `src/install.ts` `validateAgentIds`,
and the help-language test in `test/cli.test.ts`. The only command I ran
was the one F4 is about:
`pnpm exec vitest run --config vitest.config.ts test/cli.test.ts`, which
printed "No test files found, exiting with code 1" and exited 1. I ran no
product suite.

## Findings

### F1 — claude: wrong exit code in the error contract and tests

- **Plan claim:** "Behaviour" says the errors give exit 1. Tests 3 and 4 say
  "expects exit 1" and "returns 1".
- **Rule:** the error code the tests assert must be the one `runCli`
  actually returns. Every error thrown inside `runCli`'s `try` goes to the
  catch at the end of `src/cli.ts`, which writes `coord: <message>` and
  returns `2`.
- **Failure if followed:** a correct implementation throws from
  `selectAgents` or the resume check, `runCli` returns 2, and tests 3 and 4
  fail. To make them pass, an implementer would have to add a one-off
  `return 1` path that no other CLI error uses.
- **Correction:** assert exit `2`, as the codex and antigravity plans do.

### F2 — claude: selection is validated after `assertNoManualSession`, which can close a manual session

- **Plan claim:** validation runs "on the first lines of `startIssue`, before
  ... every other side effect", and the error cases leave "nothing written".
- **Rule:** an invalid `--agents` value must be rejected before any owner
  prompt or workspace effect. `assertNoManualSession` (`src/cli.ts`) is not
  read-only. When a manual tmux session exists, it asks "Close its agents and
  return their clones to <base>?", and on yes it runs `detachManual`. Both
  the numeric branch and the `start` branch call it *before* `startIssue`.
  On the numeric resume path, the plan's resume comparison also comes after
  this call, because `existingIssueRuntime` is evaluated after it today.
- **Failure if followed:** with manual mode open, an owner types
  `coord 274 --agents claude,gemnii` (a typo) in a terminal and answers yes.
  The manual terminals close and the clones go back to `main`. Only then
  does `selectAgents` fail with "not configured". A mismatched resume list
  reaches the same prompt before it is refused.
- **Correction:** validate the list (and, on the numeric path, look up
  `existingIssueRuntime` and compare rosters) before `assertNoManualSession`.
  That is what both peer plans specify. Add a `sessionExists: async () => true`
  case to the error-table test that asserts `confirm` is never called.

### F3 — claude: under solo, extra named agents are dropped silently

- **Plan claim:** `roster = profile === "solo" ? selected.slice(0, 1) : selected`,
  and "`--profile solo` still takes the first agent of the roster".
- **Rule:** every explicitly named agent must either take part in the run or
  cause a refusal. The owner's list is the choice the issue asks to honour.
- **Failure if followed:** `coord 274 --profile solo --agents claude,codex`
  exits 0 and runs only `claude`. Nothing says that `codex` was discarded.
  The same happens when `config.profile` is `"solo"` and the owner never
  typed `--profile`, which makes it more likely to go unnoticed.
- **Correction:** refuse a multi-agent selection under solo, naming the
  count and the two fixes, as codex (Reuse item 2) and antigravity
  (`resolveStart` bullet) both specify. This also lets the resume check drop
  its "apply the stored profile's solo slice" step and compare directly
  against `originalRoster`.

### F4 — claude and antigravity: the focused test commands run no tests

- **Plan claims:**
  - claude Tests: `pnpm exec vitest run --config vitest.config.ts test/cli.test.ts -t "agents selection"`
    and `... --config vitest.config.ts test/cli.test.ts test/onboard.test.ts test/install.test.ts`
  - antigravity Tests: "Focused during implementation: `pnpm test:fast test/cli.test.ts`",
    and `test:fast` is `vitest run --config vitest.config.ts`.
- **Rule:** a plan's verification commands must actually run the tests they
  name. `vitest.config.ts` lists `test/cli.test.ts`, `test/onboard.test.ts`
  and `test/install.test.ts` in `exclude`. They run only under
  `vitest.system.config.ts` (`pnpm test:system`).
- **Failure if followed:** each command filters to excluded files, so Vitest
  reports "No test files found" and exits non-zero. Either the developer
  loop is broken, or someone reads the absence of failures as a pass, and
  the new cases never run before commit.
- **Correction:** use `pnpm exec vitest run --config vitest.system.config.ts test/cli.test.ts`,
  as the codex plan does. Add `test/onboard.test.ts test/install.test.ts`
  for claude's `parseAgentList` extraction.

### F5 — antigravity: the solo check runs before the resume comparison and uses the current profile

- **Plan claim:** `resolveStart` throws when
  `selectedAgents !== null && profile === "solo" && selectedAgents.length > 1`.
  The profile there is `parsed.flags.get("profile") ?? config.profile`. The
  numeric handler then says "If equal [to `originalRoster`], proceed to ...
  `runIssue(existing)`" so that rerunning the same command resumes.
- **Rule:** on resume, an `--agents` list equal to the stored
  `originalRoster` must resume. The current flag or config profile cannot
  re-validate a roster that was already frozen. The codex plan states this
  rule explicitly: "Use the saved roster for this comparison even after ... a
  change to the configured default profile".
- **Failure if followed:** the workspace `config.profile` is `"solo"`. The
  owner starts `coord 274 --profile consensus --agents claude,codex`, quits,
  and later resumes with `coord 274 --agents claude,codex`, leaving out
  `--profile`. `resolveStart` throws the solo error before
  `existingIssueRuntime` is consulted, so the exact-match resume the plan
  promises is refused. The same happens if `config.profile` is changed to
  solo between start and resume.
- **Correction:** apply the solo multi-agent check only on the fresh-start
  path. For example, move it into `startIssue`, or skip it in the numeric
  handler when `existing !== null`. Keep the resume comparison against
  `readStartStateHeader(existing).originalRoster` alone. Add this case to
  antigravity's resume test 3.

### F6 — codex (minor, non-blocking): the selection call site and messages are not pinned down

- **Plan claim:** Reuse item 1 says to "Share one small CLI-local selection
  function between the two entry points" and to "Validate before
  manual-session cleanup". It does not name the function, say how the
  selection reaches `startIssue` (a parameter or a `StartResolution` field),
  or give the error texts.
- **Rule:** a plan should be precise enough that two implementers produce
  the same observable contract, including the messages the tests assert.
- **Failure if followed:** the tests require "a diagnostic specific to the
  error", but the plan does not say what the diagnostic is, so the
  implementation picks the wording and the tests are written to match it
  afterwards. If the selection is carried on `StartResolution`, the two
  hand-built literals in `existingContext` and `nextContext` also need the
  new field or `pnpm typecheck` fails. The plan does not mention either
  literal. The antigravity plan does.
- **Correction:** none required to approve. The behaviour rules are complete
  and correct. Taking antigravity's helper signature, its messages, and the
  two literal updates would remove the ambiguity.

### Scope and test-focus notes (no failure)

- **New files:** none of the plans adds a product file. The documentation
  target differs: claude changes `README.md`; codex and antigravity change
  `docs/coord-driver.md` "Starting and running", the operator guide that
  README already links for start/run commands. Either is in scope.
- **Unrequested refactor:** claude's `parseAgentList` extraction also edits
  the `onboard` and `install` branches. It is behaviour-preserving, but the
  issue does not ask for it. The claude plan's Scope bullet also says
  onboard/install "do not gain a duplicate check". `src/install.ts`
  `validateAgentIds` already rejects duplicates with
  `--agents lists '<id>' more than once.`, which antigravity correctly reuses
  as the message.
- **Test breadth:** antigravity's test 1 asserts many artifacts per case
  (lifecycle, mailboxes, cursors, maintenance calls, config bytes) and adds a
  help-output test. That is broader than needed, but it stays in one
  existing test file and every assertion targets a roster consumer the change
  narrows. The "no standalone `product`" help invariant it cites
  (`test/cli.test.ts`, command help test) applies only to `resume`,
  `restart-action` and `wipe-issue` help, so it constrains wording only if
  those texts are touched.

## Conclusion

All three plans meet the issue's two error rules and keep the change inside
`src/cli.ts`, one existing test file and one doc file.

- **codex:** correct as written. Its contract is the most precise about
  ordering: validation before manual-session cleanup, and resume compared
  against the saved roster regardless of the current profile. Its only gap
  is the unpinned call site and error wording (F6).
- **antigravity:** the most mechanically complete. It needs two corrections:
  the focused test command (F4) and keeping the solo check off the resume
  path (F5).
- **claude:** not ready as written. It asserts the wrong exit code (F1),
  validates after a prompt that can close a manual session (F2), drops
  named agents silently under solo (F3), and its focused test commands run
  nothing (F4).

Recommendation: implement with antigravity's structure and messages,
corrected by F4 and F5. That result matches codex's behaviour rules. Do not
proceed with the claude plan unless F1–F4 are fixed.

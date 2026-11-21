# Issue 274 plan — choose the run's agents with `--agents`

Issue #274: today the only way to run a subset of the configured agents is to
edit `config.json`. Add `--agents <a,b,c>` to the commands that start an issue
(`coord <issue>` and `coord start <issue>`). The list selects agents from
`config.json`; an id that is not configured is an error, and a repeated id is
an error.

Behaviour:

- No `--agents`: unchanged (all configured agents, in config order).
- `--agents codex,claude`: the issue roster is exactly those agents, in the
  order given, and each must be in the config. The order matters because
  `--profile solo` still takes the first agent of the roster, and
  `activateCheckAdditions` reads `roster[0]`.
- Errors (exit 1, nothing written: no runtime directory, no completion mailbox,
  no branch preparation, no vendor update):
  - unknown id → `--agents names <id>, which is not configured in <configPath>; configured agents: <ids>.`
  - repeated id → `--agents names <id> more than once.`
  - empty list (`--agents ","`) → the existing `--agents requires at least one agent id.`
- Resume (`coord <issue> --agents …` when the issue runtime already exists): the
  flag cannot change a running roster. If the requested roster (after applying
  the stored profile's solo slice) equals the stored `originalRoster`, the run
  resumes normally. Otherwise it fails with
  `Issue <n> already started with agents <ids>; --agents only applies to a new start. Omit --agents to resume.`
  `coord start` already refuses an existing runtime, so it needs no change.

## Exact File List to be changed or deleted

- `src/cli.ts`
  - Add `parseAgentList(value: string): string[]`, which splits on `,`, trims each
    entry, drops empty entries, and throws `--agents requires at least one agent id.`
    when the list is empty. It is lifted verbatim from the identical inline
    parsing in the `onboard` and `install` branches, which then call it, so they
    behave exactly as before.
  - Add `selectAgents(agents: CoordinatorConfig["agents"], value: string | undefined, configPath: string)`
    next to `resolvedAgents`. With `undefined` it returns `agents` unchanged.
    Otherwise it parses the value with `parseAgentList`, rejects repeated ids,
    rejects ids missing from `agents`, and returns the configured entries in
    command-line order.
  - `startIssue(issue, resolution)` gains a third parameter,
    `agentSelection: string | undefined`. Its first lines become
    `const agents = resolvedAgents(resolution); const selected = selectAgents(agents, agentSelection, configPath); const roster = profile === "solo" ? selected.slice(0, 1) : selected;`.
    Validation therefore runs before `resolveSafeCompletesRoot(... create: true)` and before every other side effect.
    `agents`, the full configured list, stays the input to `resolveSafeCoordRoot` /
    `resolveSafeCompletesRoot` containment and to the leftover-session
    `detachIssue` call, so the safety checks still cover every configured clone.
    All launch, preflight, branch, version and state paths keep using `roster`,
    as they do today.
  - In the numeric `coord <issue>` branch, add `"agents"` to `allowedFlags` and
    pass `parsed.flags.get("agents")` to `startIssue`. When `existing !== null`
    and the flag is present, compare it against `readStartState(existing)`
    (`profile`, `originalRoster`) as described above before calling `runIssue`.
  - In the `start` branch, add `"agents"` to `allowedFlags` and pass the flag to
    `startIssue`.
  - In the help text, add `[--agents <a,b,c>]` to the `coord <issue>` line and
    to both `coord start` lines, and add one sentence to the notes paragraph:
    "On coord <issue>/start, --agents picks a subset of the configured agents in
    the given order; an unconfigured or repeated id is an error."
- `test/cli.test.ts`: the new cases listed under Tests.
- `README.md`: in "### 3. Run a GitHub issue", one short paragraph with the
  example `coord 42 --agents claude,codex,antigravity`. It says the agents must
  already be in the workspace config, that repeats are rejected, and that
  `--profile solo` runs the first one.

## Exact file list to be created

- `.plans/issue-274/plan.md` (this coordination artifact). The implementation
  creates no product files.

## Reuse and Scope

Reused:

- `resolvedAgents(resolution)` (`src/cli.ts`): still the source of absolute
  agent roots. `selectAgents` filters its output, so it does not re-resolve
  roots.
- The existing `onboard`/`install` `--agents` split/trim/filter logic and its
  error message `--agents requires at least one agent id.` become
  `parseAgentList`. Sharing it keeps the three `--agents` flags consistent.
- `allowedFlags` and `parseArgs`: `parseArgs` already rejects a repeated
  `--agents` option and a missing value.
- `readStartState` and the `startStateSchema` fields `profile` and
  `originalRoster` (`src/state.ts`): used read-only for the resume check. No
  schema change.
- The roster plumbing in `startIssue` (`prepareAgentIssueBranches`,
  `updateAgentVersions`, `createIssueRuntime`, `initializeOperationalState`
  with `originalRoster`/`agents`, `initializeAgentLifecycle`, `startEffects`):
  unchanged, because it already takes `roster`. The selected subset flows
  through the same path solo uses today.
- Test fixtures in `test/cli.test.ts`: `setup()` (a three-agent config: codex,
  claude, cursor), `successfulStartGit`, `fakeLoop`, `issueRuntimePaths`,
  `readStartState`.

Scope:

- No new files, types, dependencies or config schema fields. Selection is a
  per-run CLI choice, recorded through the existing `originalRoster`.
- `automationDigestMaterial` is not touched. The digest still covers the
  config bytes and the issue snapshot, and the chosen roster is durable in
  `start.json`.
- Not extended to `coord manual`, `attach`, `detach`, `reset-clones` or
  `wipe-issue`. The issue asks only about runs, and those commands manage
  every configured clone on purpose.
- `onboard`/`install` keep their current semantics. They do not gain a
  duplicate check, because their `--agents` defines the config rather than
  selecting from it.

## Tests

Every new case joins `test/cli.test.ts`, in a new `describe("start --agents selection")` block
that uses `setup()`, `successfulStartGit` and `fakeLoop`. Before the change each one fails,
because `--agents` is rejected with `Unknown option --agents.`

1. `it.each(["start", "numeric"])("starts only the selected agents in the given order (%s)")`
   runs `[start] 1 --agents cursor,codex --config … --coord-runtime …`. It
   expects exit 0, `readStartState(paths).originalRoster` equal to
   `["cursor", "codex"]`, `start.agents` ids equal to the same list, and no
   `coord-agent-maintenance` call for `claude`. The last check proves the
   unselected agent is neither updated nor launched.
2. `"--profile solo runs the first selected agent"` runs
   `start 1 --agents claude,codex --profile solo` and expects `originalRoster`
   `["claude"]`, where the config's first agent would have been `codex`.
3. `it.each([["codex,gemini", "--agents names gemini, which is not configured"], ["codex,claude,codex", "--agents names codex more than once"], [",", "--agents requires at least one agent id"]])`
   runs `start 1 --agents <value> …` and expects exit 1, stderr containing the
   message, `existsSync(issueRuntimePaths(runtime, 1).issueRoot) === false`,
   and no `coord-agent-maintenance` call. That shows the refusal happens before
   any side effect.
4. `"resume refuses a different --agents roster and accepts the same one"`
   starts with `start 1 --agents codex,claude`. Then `1 --agents codex`
   returns 1, with stderr containing
   `already started with agents codex, claude` and `start.json` unchanged.
   Then `1 --agents codex,claude` (using `fakeLoop`) returns 0.

The existing onboard/install tests (`test/onboard.test.ts`,
`test/install.test.ts`, and `test/cli.test.ts` around the `--agents claude --profile solo` onboard case)
cover the refactor onto `parseAgentList` unchanged; no edits are planned there.

During development I will run focused tests with
`pnpm exec vitest run --config vitest.config.ts test/cli.test.ts -t "agents selection"` and
`pnpm exec vitest run --config vitest.config.ts test/cli.test.ts test/onboard.test.ts test/install.test.ts`.
The commit hook runs `pnpm check:fast` (lint, typecheck, fast and system tests)
and I will not duplicate it by hand. The coordinator owns the final
`pnpm check` at the approved pin.

## Alternatives Rejected

- **Store the selection in `config.json` or add a config profile per roster.**
  That is the manual edit the issue wants to remove. It would also change the
  automation digest input and persist a per-run choice.
- **Accept unknown ids by synthesizing agent entries.** The issue makes an
  unknown id an error, and an agent needs a configured clone root and launcher
  anyway.
- **Silently de-duplicate repeated ids.** The issue makes a repeat an error,
  and it is usually a typo for a different agent.
- **Sort the selection into config order.** It would make `--profile solo`
  ignore the owner's stated first choice. Honouring the given order matches
  onboard's "an explicit --agents list is used exactly".
- **Ignore `--agents` on resume, as `--profile` is ignored today.** An owner
  who reruns `coord 274 --agents claude,codex` would believe the roster was
  limited while a four-agent run resumed. Refusing only on mismatch keeps
  rerunning the same command line working. Changing the roster of a live run
  remains `coord drop`'s job.
- **Put the selection on `StartResolution` inside `resolveStart`.** That type
  is also built by hand in `existingContext` and `nextContext`, and is shared
  by attach/detach/auth/manual, none of which accept the flag. A `startIssue`
  parameter keeps the change local to the two start paths.
- **Restrict `resolveSafeCoordRoot` containment to the selected agents.**
  Unselected clones still live in the workspace, so the runtime must stay
  outside all of them.

## Risks and Mitigations

- **Risk: a side effect happens before validation fails** (for example the
  completes root is created, or vendors update). Mitigation: `selectAgents`
  runs on the first lines of `startIssue`, before `resolveSafeCompletesRoot(... create: true)`.
  Test 3 asserts that no runtime directory exists and no maintenance call ran.
- **Risk: the `parseAgentList` extraction changes onboard/install parsing.**
  Mitigation: it is a verbatim move with the same message, and the existing
  onboard/install tests run under `check:fast`.
- **Risk: the `roster[0]` consumers (`activateCheckAdditions`) now see a
  different first agent.** Mitigation: they already see whichever agent the
  profile selects. Any configured clone carries the same tracked product
  baseline after `prepareAgentIssueBranches`, which runs on the roster first.
- **Risk: the resume comparison disagrees with the stored roster for solo.**
  Mitigation: it applies the stored `profile`'s solo slice before comparing,
  exactly as `startIssue` did. Test 4 covers the mismatch and match paths.
- **Risk: the help text and README drift from the behaviour.** Mitigation: one
  usage edit per affected line and one README paragraph, written from the
  error messages above.

## Conclusion

Add `--agents <a,b,c>` to `coord <issue>` and `coord start <issue>`. It is
validated against `config.json` before any side effect: unknown and repeated
ids are errors, and the list is kept in the given order. The selected roster
then flows through the existing `roster` plumbing in `startIssue`, and the
issue's `originalRoster` records it. A resume refuses a roster that differs
from the stored one. The change touches only `src/cli.ts`, `test/cli.test.ts`
and `README.md`, with one small shared parser reused by onboard and install.
It adds no new files, schema fields or dependencies.

# Issue 261 plan — guided build/test check onboarding, native projects, agent-added checks

## Summary of the design

Six changes, each tied to a numbered item of the issue:

1. **Discovery (items 1–2).** A new pure module discovers runnable check plans
   from repository files only, with no project code executed and no GitHub
   access. It reads tracked files and parses metadata. Each plan carries the
   source file that justifies it and an ordered list of argv commands. Test
   files and CI workflows are listed as context, never as selections. The
   existing ecosystem proposal (Node/Cargo/Go/Make/Flutter/Python) becomes one
   of the discovery sources rather than a parallel path.
2. **Selection and timing (items 3, 6, noninteractive rules).** `coord onboard`
   resolves settings in this order: explicit `--declare` fields, then saved
   settings already in the workspace config, then the terminal prompt (or, when
   not interactive, an unambiguous detected plan). Owners choose timing: before
   each agent commit, before opening a pull request, or both. The prompt shows
   commands and timing before saving and executes nothing.
3. **Storage (item 4).** Settings are written to the project's existing
   workspace config (the same file `buildWorkspaceConfig` already writes,
   including the nested `workspaces/<project>/` layout). Commits map to
   verify precommit and pull requests map to the finalization checks. Onboarding
   prints the config's absolute path. Empty lists become valid in the
   declaration, the workspace config and saved issue state.
4. **Agent-proposed checks (item 5).** Implementation and revision artifacts
   gain an optional `checkProposal`. Coordination validates it against the
   pinned commit, so it is reviewed with that implementation by the existing
   review, compare and consensus steps. At finalization, coordination records an
   additive check amendment for the pin that won consensus, runs the effective
   commands (frozen issue checks plus the additions) in the existing fresh
   verification worktree, and binds the results to an effective-policy digest.
   After a pass, coordination persists the commands to the workspace config as
   adopted checks. A later issue activates an adopted check only when its entry
   points exist at that issue's baseline.
5. **Reporting.** “Automated checks skipped: none configured.” is reported by
   hooks, by start and finalization logs, and in the pull request body. A
   selection with only build steps is reported as a build result. Adoption and
   its results are reported in the coordinator log and the PR body.
6. **Frozen agent-commit checks (item 6).** Ordinary onboarding changes apply to
   new issues, so `coord start` freezes verify into the issue's start state,
   and the hook uses that frozen copy for an active issue in local mode.

## Exact File List to be changed or deleted

- `src/state.ts`
  - Drop `.min(1)` from `checks` in `coordinatorConfigSchema`,
    `workspaceDeclarationSchema` and `startStateSchema`. Coordinator-mode
    candidate checks keep `.min(1)`, because that advanced mode is meaningless
    without them.
  - Add `adoptedCheckSchema`, a strict object: `commands`
    (checkCommandSchema[], min 1), `entryPoints` (repositoryPathSchema[],
    min 1), `purpose`, `issue`, `commitSha`, `adoptedAt`.
  - Add `adoptedChecks: z.array(adoptedCheckSchema).default([])` to the config
    schema only. The declaration schema does not get it, because agents and
    declaration files never author it.
  - Add optional `verify` (verifyConfigSchema) to `startStateSchema`. It is
    optional so that older start documents still parse.
  - Add the `checkAmendments` cursor field (default `[]`), with entries
    `{ consensusPin, agent, submissionSha, proposal, effectiveChecks,
    policyDigest, recordedAt, adopted: boolean }`.
  - Add optional `checkProposal` and `policyDigest` to `acceptedSubmissionSchema`.
  - Add journal types `check-amendment-recorded` and `checks-adopted`.
- `src/protocol.ts`
  - Add `checkProposalSchema`, strict: `commands` (strict `{ name, argv }`,
    1–8 entries, unique names), `paths` (repositoryPathSchema, 1–20, unique),
    `purpose` (the existing nonblank reason schema), `commitSha`
    (gitShaSchema).
  - Add `checkProposal: checkProposalSchema.optional()` to
    `implementationReadyArtifactSchema` and `revisionReadyArtifactSchema`.
  - Strict parsing rejects unknown keys, so a `remove`/`replace` field fails.
- `src/evidence.ts`
  - In the `implementation-pinned` and `revision-pinned` branches, validate any
    `checkProposal`:
    - `commitSha` equals the submission's own product pin.
    - Every path exists as a blob at that pin, read through the existing mirror
      blob read.
    - No proposed name equals an existing frozen check name. A collision is
      rejected with: “check proposals may only add checks; replacing or
      removing existing check <name> is not done through this path”.
    - No proposed argv duplicates an existing check.
  - Pass the parsed proposal out on the satisfied observation.
- `src/steps.ts`
  - Add `checkProposal?` to `EvidenceObservation` and to the `accept-submission`
    `MachineDecision`.
- `src/machine.ts`
  - Copy `checkProposal` from the observation into the `accept-submission`
    decision, beside `checkResults`.
- `src/runLoop.ts`
  - Store `checkProposal` on accepted submissions, in the place that already
    stores `checkResults`.
  - `verifyFinalizationChecks`:
    1. Find the latest accepted implementation or revision submission whose
       product pin equals the bound consensus pin.
    2. If it carries a proposal, record (idempotently, keyed by consensus pin) a
       `checkAmendments` entry and journal `check-amendment-recorded`, both
       before running anything. The effective checks are the frozen issue
       checks followed by the proposed commands.
    3. Run `selectVerification` and `runGateVerification` over the effective
       checks with the amendment's `policyDigest`.
    4. Store `policyDigest` on the accepted finalization submission.
    5. When effective checks are empty, journal skipReason `none configured`
       and log “Automated checks skipped: none configured.”
  - `publishAcceptedFinalization` refuses to publish, with an actionable
    failure, when the accepted finalization's `policyDigest` differs from the
    current effective digest. Otherwise it:
    - persists any unadopted amendment to the workspace config's
      `adoptedChecks` with an atomic read-modify-write that dedupes by commands
      and entry points;
    - marks the amendment `adopted`;
    - journals `checks-adopted` and logs the adoption and results.
  - A persistence failure is logged as `[ACTION]` with the config path and does
    not block publication.
  - On restart, an unadopted amendment is retried.
  - The start and finalization logs use `describeCheckOutcome` for result
    wording.
- `src/verificationRunner.ts`
  - Add an optional `policyDigest` input that overrides the frozen digest in
    receipt key material. A receipt written under the frozen policy therefore
    never satisfies an amended run.
- `src/hookPolicy.ts`
  - `resolveHookBinding` returns `{ bound: true, kind: "frozen" }` with the
    start state's verify for an active, local-mode issue on this clone's issue
    branch. The coordinator-mode result becomes `kind: "coordinated"`.
  - `runVerifyPhase` prints “Automated checks skipped: none configured.” when
    the product classification selects an empty list.
- `src/setupWorkspace.ts`
  - `buildWorkspaceConfig` takes resolved `checkSettings` (`verify`, `checks`)
    and `adoptedChecks` instead of computing checks itself, and no longer
    throws on empty checks.
  - Update the comment that calls `proposeToolchainPolicy` “the ONLY place
    ecosystem detection is allowed” so that it also names the new discovery
    module.
  - Export `proposeToolchainPolicy` for reuse.
- `src/install.ts`
  - Export `readDeclaration`.
  - `install` accepts optional `checkSettings`. Without them, it resolves
    settings noninteractively through the new module (declared, then saved,
    then an unambiguous detected plan, then announced empty).
  - Saved settings are read with the new tolerant reader, so a malformed saved
    `verify`/`checks` produces an actionable error instead of silently
    regenerating.
  - Carry `adoptedChecks` forward from the previous config.
  - `logProjectPolicy` prints the settings source (declared/saved/selected/
    detected/none configured), the commands, the timing and the config's
    absolute path, and replaces the generic `--declare` hint with the actual
    absolute path of the example file in the install root.
  - `onboard` passes `checkSettings` through.
  - `savedGitHubAccount` also returns the resolved config path, so the CLI can
    read saved check settings without resolving the runtime twice.
- `src/cli.ts`
  - Add `ask?: (question) => Promise<string | null>` to `CliDependencies`, with
    a readline default modelled on `defaultChoose`.
  - In `onboard`, before calling `onboard()`, run the interactive selection when
    a terminal is available (same test as `chooseOnboardAccount`). Otherwise
    leave resolution to `install`.
  - In `start`:
    - Compute the effective checks as config checks plus the adopted checks
      whose entry points all exist at the baseline, checked with
      `git cat-file -e <baseline>:<path>` in the first prepared agent clone.
    - Skip, with a logged warning, an adopted check whose name collides with a
      configured check.
    - Freeze verify into start state.
    - Compute the verification digest from the effective checks.
    - Log “Automated checks skipped: none configured.” when the effective
      checks are empty.
  - `hook-verify` prints the frozen binding as “issue N — checks saved at issue
    start”.
- `src/githubIssue.ts`
  - `formatFinalizationPullRequest` accepts optional `checkSummary` lines (the
    outcome wording and the adoption report) and appends them.
- `src/orderScaffold.ts`
  - In the implementation and revision steps, add one paragraph describing the
    optional `checkProposal` field (shape, when to use it, and that it may only
    add checks). The JSON scaffold itself stays unchanged, so agents are never
    prompted to fabricate a proposal.
- `src/action.ts`
  - Add one sentence to the verification responsibilities: reviewers evaluate
    any `checkProposal` with the implementation that carries it. The wording
    avoids the banned agent-facing terms.
- `README.md` and `docs/coord-driver.md`
  - Document guided check selection, timing, the no-checks wording, adopted
    checks and their activation rule, and `--declare` as the advanced path with
    a valid example.
- `docs/repo-map.md`
  - Add the new module to the Workspace and install group.
- Test files, detailed under Tests:
  - `test/onboard.test.ts`
  - `test/verify-config.test.ts`
  - `test/evidence.test.ts`
  - `test/runLoop.test.ts`
  - `test/cli.test.ts`
  - `test/verificationRunner.test.ts`
  - `test/githubIssue.test.ts`
  - `test/orderScaffold.test.ts`

Nothing is deleted.

## Exact file list to be created

- `src/checkSetup.ts`: discovery, plan resolution, the prompt flow, the
  tokenizer, the timing mapping and outcome wording. It exports:
  - `discoverChecks(productRoot)` returns `{ evidence: {path,label}[],
    plans: CheckPlan[] }`. A `CheckPlan` is `{ label, source, commands:
    CheckCommand[], unresolved: UnresolvedParameter[] }`. Sources, all read
    from tracked files with `git ls-files` plus file reads:
    - **Project scripts:** a tracked check or test shell script under the
      scripts directory becomes the plan “sh <path>”.
    - **CMake:** the presets file is parsed as JSON. Each non-hidden test
      preset whose configure preset has a matching non-hidden build preset
      produces one plan:
      1. configure, with `cmake --preset <c>`
      2. build, with `cmake --build --preset <b>`
      3. test, with `ctest --preset <t> --output-on-failure --no-tests=error`

      A configure/build chain without a test preset is a build-only plan. A
      CMakeLists file without presets is listed as evidence only, because no
      build directory is guessed.
    - **Xcode:** a root-level workspace is preferred over a root-level project.
      Each shared scheme whose TestAction contains a testable reference
      produces `xcodebuild test -workspace|-project <p> -scheme <s>
      -configuration <c> -destination <d>`. The configuration is taken from the
      scheme's TestAction. The destination is always unresolved, so no device
      is guessed. Shared schemes without testable references are skipped.
    - **SwiftPM:** a package manifest produces build then test.
    - **Existing ecosystem proposal:** used when it has checks; its source is
      the manifest it came from.
    - **Context only:** test directories (test, tests, Tests) are listed with a
      language label taken from the file extension, and CI workflow files with
      the label “CI workflow (supporting evidence, not run)”.
  - `parseCommandLine(text)` is a quote-aware tokenizer. Single quotes, double
    quotes and backslash escapes are supported, so arguments containing spaces
    survive intact. Unquoted shell operators (`|` `&` `;` `<` `>` `$` and
    backtick) are refused with “put pipelines or redirection in a script”. No
    shell is ever invoked.
  - `settingsFor(commands, timing)` maps timing to settings:
    - commit: verify precommit gets the commands, `checks` is empty.
    - pr: `verify` is empty, `checks` gets the commands.
    - both: both get the commands.
    - none: every list is empty.

    `prepush` is always empty.
  - `resolveCheckSettings({ declared, saved, discovery, interactive?:
    { choose, ask, print } })` applies the precedence and returns `{ verify,
    checks, source }`:
    - Saved settings in a terminal: shown, then “Keep these settings” or
      “Change them”.
    - The menu offers each plan as “Use <commands joined by → >”, then “Enter
      another build or test command” (repeated lines; an empty line finishes),
      then “Continue without automated checks for now”.
    - Unresolved parameters are asked for as free text.
    - The timing question is skipped for “none”.
    - Noninteractive runs with several plans, or with unresolved parameters,
      throw. The error lists the choices, a valid `--declare` example, and the
      absolute path of the example file in the install root.
    - A first-time project with no plan returns empty settings and the source
      “none configured”.
  - `readSavedCheckSettings(configPath)` returns null when the file is missing.
    It parses only the `verify`, `checks` and `adoptedChecks` fields, so
    unrelated schema drift elsewhere still regenerates. Invalid JSON or a
    malformed field throws an error naming the path and the remedy.
  - `describeCheckOutcome(commands, results)` returns:
    - “Automated checks skipped: none configured.” for an empty list;
    - “Build result: passed|failed” when every name is configure or build;
    - otherwise “Build and test result: …”, with each name and argv.

  Justification: discovery, selection, tokenizing and wording are one new
  concern. `src/setupWorkspace.ts` is already 932 lines of clone wiring, and
  this logic must be unit-testable without a workspace.
- `test/checkSetup.test.ts`: the repository convention is one test file per
  module (repo map, “Tests live in test/, one file per module”), and this module
  has no existing file to extend.

## Reuse and Scope

Reused, not rewritten:
- Discovery and config: `proposeToolchainPolicy` / `proposeProjectPolicy` (src/setupWorkspace.ts) as discovery sources; `buildWorkspaceConfig`, `writeWorkspaceConfig`, `selectWorkspaceLocation` (src/workspace.ts) and `atomicWriteJson` for every config write; `readDeclaration`, `readPreviousConfig`, `savedGitHubAccount` in src/install.ts.
- Schemas: `checkCommandSchema`, `verifyConfigSchema`, `repositoryPathSchema` and the amendment reason schema.
- Prompts: `defaultChoose` and the `choose` dependency in src/cli.ts, with the same terminal/VITEST guard as `chooseOnboardAccount`.
- Running checks: `runVerification`, which already uses fresh mirror worktrees, ordered stop-at-first-failure and the tracked-file cleanliness checks. `runGateVerification`, `selectVerification` and `verifyFinalization` stay unchanged in behavior.
- Hooks: `resolveHookBinding` / `runVerifyPhase`.
- Doctor: `unresolvableCommands`, which already reports missing tools during onboarding.
- Evidence reads: mirror blob reads in src/evidence.ts.
- Journal and persistence: `appendJournal` and `mutate` for cursor persistence.
- Tests: the temporary-tree helpers in test/verify-config.test.ts ("installer proposals"), test/support/workspaceFixture.ts, the onboard harness in test/onboard.test.ts, and the finalization fixtures in test/runLoop.test.ts (the "keeps failed final checks" setup).

Scope boundaries, per the issue:
- No test-framework scaffolding.
- No GitHub required-check or merge enforcement.
- No CI YAML interpretation.
- No sandbox.
- No confidence scoring.
- No new agent approval step: a proposal is reviewed with its implementation.
- Replacing or removing checks through a proposal is refused.
- Adopted checks extend only the coordinator-run checks before a pull request. Agent-commit hook lists change only through onboarding.
- Coordinator-mode policy authoring is unchanged.
- No version bump.

## Tests

The tests are the fewest that cover each acceptance item. Each case fails
before the change and passes after it.

`test/checkSetup.test.ts` (new):
1. **Source labels and CMake order.** A tree with a check script, a C++ test
   source in tests, and a presets file yields evidence rows with labels and the
   plans in deterministic order. The CMake commands run configure → build →
   test, with `--output-on-failure --no-tests=error`. A marker-writing script
   proves that discovery executes nothing.
2. **Competing build systems.** Two CMake test chains plus a script give three
   plans. Noninteractive resolution throws, listing them, the `--declare`
   example and the absolute path of the example file.
3. **Xcode.** A workspace with one tested shared scheme and one untested
   shared scheme yields one plan with an unresolved destination.
   Noninteractive resolution refuses and names the destination. Interactive
   answers produce exact argv, with “platform=macOS,arch=arm64” kept as one
   element.
4. **Quoted arguments.** `parseCommandLine` keeps quoted arguments containing
   spaces and refuses pipes, `;` and `$(`.
5. **Timing.** commit/pr/both/none map to the expected verify/checks; the
   timing question is skipped for none.
6. **Intentional no-checks versus build-only.** `describeCheckOutcome` gives
   the no-checks wording for an empty list, a build result for
   configure/build, and build-and-test otherwise.
7. **Malformed saved settings.** `readSavedCheckSettings` returns null when
   the file is missing, throws naming the path when saved checks are
   malformed, and ignores unrelated drift.

`test/onboard.test.ts` (extend):
8. **Interactive first onboarding.** Injected choose/ask select the CMake
   plan and “both”. The config has identical ordered precommit and checks,
   output shows the commands, the timing and the absolute config path, and no
   command ran.
9. **Re-onboarding and reinstall.** Re-onboarding shows saved settings and
   “Keep” preserves them after detection changes; “Change” reselects.
   Uninstall without wipe followed by onboarding keeps settings and
   `adoptedChecks`.
10. **Noninteractive.** A first-time project with nothing recognized writes
    empty lists and prints the no-checks line, and doctor passes. An ambiguous
    tree exits nonzero and writes no config.

`test/verify-config.test.ts` (extend):
11. **Empty lists accepted.** Empty checks are accepted by the declaration,
    the config and the start state.
12. **Hook wording.** An empty precommit list prints the no-checks line.
13. **Frozen settings in hooks.** An active local-mode issue's hook uses the
    frozen verify from start state even after the config's verify changes.

`test/evidence.test.ts` (extend):
14. **Proposal validation.** An implementation with a valid proposal is
    satisfied and carries it. These are rejected: a name collision (an attempt
    to replace or remove a check), a mismatched commitSha, a path missing at
    the pin, and an unknown `remove` key. Revision artifacts are validated
    the same way.

`test/runLoop.test.ts` (extend, using the existing finalization fixtures):
15. **Adoption during a no-checks issue.** In a no-checks issue whose
    consensus implementation carries a proposal:
    - finalization records the amendment, runs the added command in a fresh
      worktree at the final pin, and publishes;
    - the PR body reports the adoption and the result;
    - start state and the GitHub issue snapshot are byte-identical;
    - the workspace config gains `adoptedChecks`.
16. **Failure and restart.** A failing added command rejects finalization
    with its log. A restart after the amendment is recorded reuses it with
    the same digest. An accepted finalization with a stale `policyDigest`
    refuses to publish.
17. **No checks.** Finalization with no checks and no proposal reports the
    no-checks wording in the journal and the PR body.

`test/cli.test.ts` (extend):
18. **Start.** Start succeeds with empty checks. An adopted check is excluded
    when its entry point is absent at the baseline and included when it is
    present. Verify is frozen into start state.

`test/verificationRunner.test.ts` (extend):
19. **Policy binding.** A receipt written under the frozen digest is not
    reused when the `policyDigest` override differs.

`test/githubIssue.test.ts` (extend):
20. **PR body.** The check summary lines are appended.

`test/orderScaffold.test.ts` (extend):
21. **Agent instructions.** Implementation and revision instructions mention
    the optional `checkProposal`. The existing agent-language test still
    passes over the rendered actions.

Commands, run while developing and by the hooks:
- `pnpm test:fast` (focused files) while developing.
- `pnpm check:fast` runs as the precommit hook; it is not duplicated manually.
- The coordinator owns `pnpm check` at the approved pin.

## Alternatives Rejected

- **Interpret CI workflow YAML as the local plan.** The issue excludes it, and
  it is non-deterministic across runners. Workflows appear only as evidence.
- **Guess a CMake build directory or an Xcode destination.** The issue forbids
  guessing. Missing presets or a missing destination lead to evidence plus a
  question, or an explicit configuration error.
- **Run discovered commands through `sh -c`.** That breaks argv fidelity and
  allows injection. The tokenizer and argv vectors are used instead, and
  scripts remain the escape hatch.
- **A separate settings file or timing field.** The issue requires reusing the
  existing config. Timing can be derived from which lists are populated.
- **A separate agent ballot for proposals.** The issue forbids a new approval
  step. The proposal travels inside the implementation or revision artifact
  that reviewers already judge.
- **Let agents edit runtime config.** The issue forbids it. Only coordination
  writes `adoptedChecks`, and only after its own verification passes.
- **Activate adopted checks immediately for every issue.** An unmerged entry
  point would make other issues' checks fail. Activation is gated on the
  entry points being present at that issue's baseline.
- **Put discovery inside `src/setupWorkspace.ts`.** It would grow an already
  large clone-wiring module and couple unit tests to workspace setup.

## Risks and Mitigations

- **Behavior change on reinstall.** Saved settings now win over fresh
  detection. Onboarding prints the source and the commands, and “Change them”
  re-runs detection. `--declare` still overrides.
- **Empty lists weaken the fail-closed hooks.** Empty lists are written only
  by an explicit owner choice, or announced loudly for a first-time
  noninteractive project. An absent verify still fails closed for configs
  that never chose.
- **Config write races** between onboarding and adoption persistence. Both
  use atomic read-modify-write. Onboarding re-reads and preserves
  `adoptedChecks`. A lost write leaves the amendment marked unadopted, and it
  is retried on the next tick.
- **Arbitrary agent-proposed commands.** Peers review them with the code, and
  they run only in the fresh verification worktree at the reviewed pin. They
  cannot replace existing checks and cannot alter hooks.
- **A stale result satisfies an amended policy.** The policy digest is bound
  into receipt keys and stored on the accepted finalization, and publication
  refuses on a mismatch.
- **Xcode or CMake preset edge cases** (includes, conditions). Only top-level
  presets are parsed. Anything unresolved becomes a question, or a
  noninteractive error pointing to an explicit command or script.
- **Schema loosening affects old state.** Fields are optional or defaulted, so
  existing start, cursor and config documents still parse. This is covered by
  test 11 and the existing state tests.

## Conclusion

The new `src/checkSetup.ts` adds file-only discovery, a precedence-ordered
resolver (declared, saved, prompted or unambiguous, announced empty) and argv
tokenizing. Onboarding saves the choice into the existing workspace config with
commit/PR timing. Empty lists become valid everywhere, and the outcome wording
is reported plainly. Agent-proposed checks reuse the existing artifacts, review
and fresh-worktree runner, bound to an effective-policy digest; they persist for
future issues and activate only once their entry points exist at an issue's
baseline. The changes stay within the listed modules, docs and existing test
files, plus one new module and its test file.

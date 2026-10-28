# Issue 256 implementation plan

Source: https://github.com/gwhizoftv/4horsemen/issues/256. Baseline: `d646aedcc21a43dde942c86c65b64aba649c1964`. This plan addresses premature Git completion and false watchdog stalls using the existing action renderer, hook bridge, and activity watcher.

## Exact File List to be changed or deleted

Change these nine existing files; delete none:

| File | Intended change |
| --- | --- |
| `src/action.ts` | Strengthen `renderGitAction` completion instructions: commit the required artifact, ensure that exact commit tree contains it, wait for a successful push to the named branch, and only then write that commit's SHA to `complete`. A failed or still-running push is not completion. Preserve response-mode instructions and the ready handshake. |
| `src/hookPolicy.ts` | Add the local required-artifact pre-push check, with current-action binding and inspection of the actual outgoing commit, index, and required artifact's working-tree state. Keep it independent of whether verification mode is local or coordinator-owned. |
| `src/cli.ts` | Invoke the artifact check from the existing `hook-verify --phase prepush` bridge before running the selected verification commands. Share the already-read stdin ref lines. Report a nonzero error naming the action, required path, offending state, and commit/push-before-complete remedy. |
| `src/runLoop.ts` | Extend `watchOwedWork` with bounded clone file/index and runtime terminal-log observations; combine these with existing transcript, tool, and pane evidence. Treat a live vendor busy indicator as activity even when its text is unchanged. |
| `src/tmux.ts` | Expose a narrow busy-indicator predicate using the existing status/chrome parsers, including Antigravity thinking status. Reuse it where appropriate without changing explicit owner-reminder or ready-driven delivery authority. |
| `test/action.test.ts` | Extend Git completion instruction assertions and preserve response/ready behavior. |
| `test/hookSync.test.ts` | Extend the installed-hook tests with active Git-action artifact failures and valid publication flows. |
| `test/runLoop.test.ts` | Extend the existing watchdog tests with file/index/log activity and unchanged busy-indicator cases, followed by genuinely quiet recovery. |
| `test/tmux.test.ts` | Extend existing vendor status fixtures with positive busy and negative prose/idle cases. |

## Exact file list to be created

No new product, test, configuration, dependency, or fixture files. The only new file for this planning action is `.plans/issue-256/plan.md`, the coordinator-required artifact. Implementation belongs in the existing modules and test suites above.

## Reuse and Scope

### Completion instructions and local guard

Reuse `readAction`/`parseAction` and `PublicGitAction` from `src/action.ts`, `issueRuntimePaths`/`agentRuntimePaths` and path containment helpers from `src/paths.ts`, and the existing workspace/config, clone identity, start-state, and cursor readers used by `resolveHookBinding`. Reuse the current Git helpers and outgoing-change information instead of introducing another command or altering shell hooks.

The pre-push guard must establish an active run for the exact clone and agent, bind `action.md` to the cursor's current action ID, and inspect each matching outgoing issue-branch update using Git's stdin local SHA. It must not substitute `HEAD` for the pushed tree or reuse the coordinator-verification-only eligibility test as the action eligibility test. Unrelated/manual branches, absent inactive actions, and response actions retain existing behavior. Malformed or mismatched action data in an otherwise established active Git action must produce a diagnostic rather than silently pass the check. Branch deletion and unrelated refs are not completion submissions; existing ownership rules continue to apply.

For a Git artifact publication, require a regular file/blob at the exact required path in the outgoing commit, a matching committed index entry, and no unstaged changes, staged changes, deletion, unmerged state, or untracked replacement of that path. Use literal, path-scoped Git plumbing and the repository's normal content/filter semantics, not whole-clone cleanliness. Inspection failures must be errors, not success. This catches a committed older artifact with newer unstaged or staged contents as well as an artifact omitted from the pushed tree. It also checks a non-HEAD outgoing SHA correctly.

Preserve the existing two-commit product/signal workflow: for `R4.implement` and `R6.revise` only, an intermediate push with product changes may proceed when the required signal does not yet exist in the working tree, index, or outgoing tree. This exception does not permit an existing untracked/dirty signal, does not apply to a required plan/review/comparison, and never authorizes writing `complete`. A committed `plan-amendment-request` occupies the same required path and passes the same path-only check while unrelated product edits remain unstaged. No artifact JSON interpretation is needed to support amendment requests.

Keep `evaluateEvidence` in `src/evidence.ts` as the authority for remote reachability, artifact schema, citations, and acceptance. Its existing missing-path tests already cover remote rejection. A pre-push hook cannot prove that a subsequent network push succeeded or intercept every arbitrary filesystem write to `complete`; the explicit action ordering and the existing mirror validation supply those boundaries. This change does not claim universal interception of completion writes.

### Watchdog activity

Reuse `watchOwedWork`, `transcriptStamp`/`locateTranscript`, `paneActivityDigest`, `OBSERVATION_INTERVAL_MS`, `updateActionWatch`, and the existing persisted `watch` fingerprint/quiet timestamps. No lifecycle schema or workflow transition changes are needed. Reuse `agentRuntimePaths(...).terminalLogs` for vendor-independent raw terminal output and the configured agent root for clone observations.

At the existing once-per-minute observation, gather deterministic path/metadata stamps for tracked and nonignored untracked files and the actual Git index. Include path existence, size, and modification/change time so repeated edits to an already-dirty file and file creation/deletion are activity. Resolve the index through Git rather than assuming `.git` is a directory. Use bounded, read-only Git enumeration and filesystem metadata reads; do not refresh the index, recursively scan dependency/build trees, follow directory symlinks, or invoke status/diff as a workaround for agent containment rules. Git output truncation, timeout, or incomplete enumeration must be recognized as unavailable, not a complete quiet sample. Do not feed the diagnostic process runner's truncated output into file enumeration as if it were complete.

Also observe regular `run-*.log` files in this agent's terminal directory by path/size/modification metadata. Include rotation/new-file changes; exclude render logs, lifecycle/journal writes, action/ready files, and `.coord` bookkeeping so the watchdog does not manufacture its own activity. Preserve existing Claude/Codex session-transcript observations. Missing optional transcript/log sources are normal absence; unreadable or incomplete observations get a bounded diagnostic and defer that quiet decision rather than crash the tick or assert inactivity.

Extend the fingerprint with these observations. Quiet still requires unchanged observations and zero pending tools, and additionally requires no recognized live busy indicator. An unchanged busy line resets the quiet baseline on every observation. After activity ends, require a complete observed quiet interval before the existing single resend and eventual single `[WAIT]` report. Preserve the action/digest binding and authority checks after asynchronous observation; a restart uses the persisted fingerprint, and a changed action gets its own baseline.

Reuse `inFlightStatusLine`, `codexTurnChrome`, `museTurnChrome`, ANSI normalization, and measured terminal fixtures. Recognize vendor status chrome near the active pane tail; ordinary quoted, fenced, or bulleted prose mentioning thinking/working must not count. Do not equate every prompt-readiness refusal (trust dialogs, missing composers, owner drafts) with active work. The new predicate only supplies watchdog evidence; it does not grant or revoke explicit owner-reminder authority.

## Tests

Add focused regression cases to the existing suites, using parameterization for equivalent states:

1. `test/action.test.ts`: Git action text explicitly requires the required artifact in the submitted tree and successful push before `complete`, including review/comparison actions. Response ballots remain commit-free and both modes retain the ready handshake.
2. `test/hookSync.test.ts`: use `installed`, `activeRun` (locally reused/extended), `stageWork`, and the existing `makeProduct`/`git`/`tryGit` helpers. Actual pre-push hooks reject missing, untracked, staged-only, unstaged-modified, staged-modified, deleted, and wrong-outgoing-SHA artifacts before remote publication. Commit the exact artifact and verify that the push succeeds. Cover local and coordinator verification modes. Include the absent-signal intermediate product push, a dirty-signal refusal, a committed amendment request with unrelated unstaged product edits, and manual/response/non-current-action isolation. Assert an actionable path-specific error and unchanged remote ref on refusal, not just a nonzero exit.
3. `test/runLoop.test.ts`: reuse `safetyFixture`, its injected clock, existing lifecycle helpers, and temporary roots. With a static pane and no tool callbacks, parameterize tracked-file rewrites (including a second edit while already dirty), untracked creation/deletion, index changes, and terminal-log append/rotation. Each observed change must suppress both resend and `stalled`; after changes cease, the established one-resend/one-WAIT behavior must return. Exercise an unchanged Antigravity thinking/busy line, then idle; preserve existing Codex transcript-growth and pending-tool tests. Cover ignored/bookkeeping-only changes, missing optional files, observation failures, and restart/action-baseline behavior within the existing fixture setup. Use clock advancement/explicit timestamps rather than real 60-second sleeps.
4. `test/tmux.test.ts`: extend existing thinking/timer/chrome and prose fixtures to show that the watchdog busy predicate recognizes static live status but rejects idle panes, owner drafts, and prose quoting those words. Preserve ready-driven and explicit owner-send tests.

Development commands, verified against the package scripts and the Vitest configurations:

```sh
pnpm exec vitest run --config vitest.config.ts test/action.test.ts test/runLoop.test.ts test/tmux.test.ts
pnpm exec vitest run --config vitest.system.config.ts test/hookSync.test.ts
```

The hook fixtures' existing `ensureBuilt` rebuilds the CLI when source files change. For product submission, the installed hooks own their declared checks: this repository declares `pnpm check:fast` at precommit and `pnpm test:e2e` at prepush in local mode. Do not duplicate the mandatory suite immediately before committing. If the implementation action establishes coordinator verification mode, cite its recorded candidate/final results and run only the focused investigation and hook-owned checks appropriate to that action. The coordinator owns final verification; the full repository command is `pnpm check` (build, fast/system checks, e2e). This plan-only submission requires heading/scope/evidence validation and no product suite.

## Alternatives Rejected

- Instructions alone cannot catch an artifact left unstaged; use the existing pre-push bridge as well.
- A blanket clean-working-tree requirement or mandatory signal on every implementation push would block valid product/signal sequencing and amendment requests with preserved product edits.
- A new completion CLI, arbitrary shell-write interception, or edits to the product shell-hook tree would expand scope and still would not replace remote evidence validation.
- Increasing the watchdog timeout or disabling it for Antigravity would delay recovery of genuinely lost actions. Check positive activity within the existing interval instead.
- A new filesystem watcher service, lifecycle schema, dependency, or recursive all-files scan is unnecessary. Extend the existing per-action metadata fingerprint and existing vendor parsers.

## Risks and Mitigations

- **Incorrect push/action binding:** validate clone/agent/current action identity and every relevant outgoing ref; test an older pushed SHA and both verification modes. Keep remote acceptance checks intact.
- **Breaking legitimate intermediate work:** limit the absent-signal exception to product-bearing implementation/revision pushes and inspect only the required artifact for cleanliness. Test amendment requests and staged/unstaged signal failures explicitly.
- **Watchdog observation cost or false quiet:** bound enumeration/time/output and file metadata work; skip ignored generated trees, reject symlink traversal, and treat incomplete observations as unavailable. Do not add synchronous unbounded scans to each run-loop tick.
- **False ongoing activity:** ignore coordinator bookkeeping and unrelated runtime files; require vendor-specific chrome rather than arbitrary prose. Static old file timestamps do not count as new activity merely because they remain present.
- **Activity races and restarts:** retain persisted action/digest-scoped fingerprints, use authority checks after asynchronous work, and verify that an activity-to-idle transition waits a full quiet interval without spending extra resend credit.

## Conclusion

Implement the changes in the nine listed existing files. The resulting workflow gives agents explicit push-before-complete instructions and immediate path-specific pre-push errors, while the watchdog uses filesystem/log activity and stable vendor busy indicators to avoid interrupting active work. Existing remote evidence validation, response ballots, amendment requests, and bounded quiet-action recovery remain authoritative.

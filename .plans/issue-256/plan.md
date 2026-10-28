# Plan — issue 256: Guard against premature Git-mode complete markers and silent-tool watchdog stalls

Issue: `Guard against premature Git-mode complete markers and silent-tool watchdog stalls` (GitHub #256). Two defects from run #238: (1) Git-mode agents write `complete` before `git push` succeeds or with the required artifact untracked/unstaged, so mirror validation in `evaluateEvidence` (`src/evidence.ts:272-274`, `required artifact ${requiredPath} is missing`) burns a nudge cycle; (2) the stall watchdog in `watchOwedWork` (`src/runLoop.ts`, `OBSERVATION_INTERVAL_MS = 60_000` at `src/runLoop.ts:943`) can declare `stalled` for agents without granular `tool-start`/`tool-activity` hooks even while they are actively working. Baseline for this issue: `d646aedcc21a43dde942c86c65b64aba649c1964`.

## Exact File List to be changed or deleted

Changed (no deletions):

- `src/action.ts` — strengthen the Git-mode completion block rendered by `renderGitAction` (currently `src/action.ts:215-218`: “Push the commit containing the artifact … Then write that exact 40-character lowercase commit SHA …”). New wording must state explicitly, in order: commit the required artifact at `requiredPath`; `git push` to `order.branch` must succeed before `complete` is written; the pushed commit tree must contain `requiredPath`; never write `complete` while the artifact is untracked or unstaged. Keep the existing re-read/`readyInstructions` (`src/action.ts:183-192`) text unchanged.
- `src/hookPolicy.ts` — add a required-artifact guard next to `resolveHookBinding` (`src/hookPolicy.ts:145`) / `runVerifyPhase` (`src/hookPolicy.ts:207`): resolve the current action for this clone/issue/agent, read its `requiredPath`, and return an immediate local error when (a) pre-push: the outgoing `local_sha` tree does not contain `requiredPath` (check with `git cat-file`/`ls-tree` via `git` from `src/gitExec.ts:33`), or the artifact is untracked/uncommitted in the working tree; (b) pre-commit: `requiredPath` is untracked or not in the staged index. Fail closed only with a clear `HOOK BLOCKED`-style message naming `requiredPath` and the fix (stage/commit/push first); when no current Git-mode action can be resolved for the clone, the guard is a no-op so scratch-branch and non-issue pushes are unaffected.
- `src/cli.ts` — in the `hook-verify` command (currently `src/cli.ts:1599-1625`), run the new guard after `resolveHookBinding` and before/alongside `runVerifyPhase`; on guard failure print the immediate local error to stderr and return `1` without running declared verify commands. Response-mode actions and unbound clones skip the guard.
- `src/runLoop.ts` — extend `watchOwedWork` (`src/runLoop.ts:2058-2095`) so hook silence alone is even harder to mistake for a stall: add two inputs to the existing activity fingerprint (`sha256(JSON.stringify([transcriptStamp, toolActivity.sequence, paneActivityDigest]))` at `src/runLoop.ts:2076-2077`): (a) a worktree/index stamp for the agent clone (clone root from `start.agents`, index file under `gitDir` from `src/gitExec.ts:92` plus `git status --porcelain` output hash via `git` from `src/gitExec.ts:33`); any change resets `quietSince`, exactly like a transcript change; on git/stat error use a changing `unavailable:${now}`-style stamp so the observation is checked but never quiet, mirroring the existing pane-failure branch (`src/runLoop.ts:2070-2074`); (b) a vendor busy signal: when `harnessPromptReadiness(text, agent)` (already imported at `src/runLoop.ts:117`, defined `src/tmux.ts:282`) reports not-ready for a turn-chrome/busy reason (e.g. `antigravity-turn-chrome`, `cursor-turn-chrome`, `codex-turn-chrome`, `claude-usage-wait`), treat the pane as active even if `paneActivityDigest` (`src/tmux.ts:269`) is unchanged, because that digest deliberately ignores the footer/status line below the composer. Non-busy not-ready reasons (trust dialog, no prompt) do not count as activity. Keep `OBSERVATION_INTERVAL_MS`, the one-resend-then-one-`[WAIT]` shape, `toolActivity.pending === 0`, and the `stalled` journal event (`src/runLoop.ts:2090-2092`) unchanged.
- `test/action.test.ts` — extend the `agent actions` / `verification instructions` describes (from `test/action.test.ts:35`): assert the rendered Git action states push-before-`complete` and pushed-tree-contains-`requiredPath`, and that response-mode rendering is unchanged.
- `test/cli.test.ts` — extend the existing `hook-verify` coverage (e.g. `test/cli.test.ts:2335`): pre-push with the required artifact missing from the outgoing tree fails immediately with the artifact named; pre-push with the artifact present passes the guard; pre-commit with the artifact untracked fails; no current Git-mode action (scratch/unbound) is a no-op.
- `test/runLoop.test.ts` — extend `ready-driven delivery and stall watchdog` (`test/runLoop.test.ts:4485`): (a) static pane, no transcript, no hooks, but the clone worktree/index changes each minute — no resend and no `stalled` event (fails before, passes after); (b) static pane above the composer with only a vendor busy/turn-chrome indicator — no resend while busy; (c) regression keepers: fully static agent still gets exactly one resend then one `[WAIT]` (existing tests at `test/runLoop.test.ts:2834`, `4604` must stay green), and the growing-rollout case (`issue 415: never resends while the Codex rollout grows…`) still passes.

No other product files change. In particular `src/evidence.ts` stays as the coordinator-side backstop (its `required artifact … is missing` rejection at `src/evidence.ts:274` remains correct for a `complete` that still arrives early), `src/tmux.ts` is not modified (busy detection reuses `harnessPromptReadiness`), and `githooks/` is not modified as a way to satisfy checks — the guard lives in the `coord hook-verify` path the hooks already call (`githooks/pre-push` → `coord_verify prepush`).

## Exact file list to be created

None. No new source, test, fixture, or doc files. Every behavior lands in the existing modules and test files listed above; a new helper file is not justified when `src/hookPolicy.ts` already owns hook binding/verification and `src/runLoop.ts` already owns the watchdog fingerprint.

## Reuse and Scope

Reuse, do not reinvent:

- `renderGitAction`, `readyInstructions`, `parseAction`/`readAction`, `parseCompletion` in `src/action.ts` (lines 183-225, 277-347, 412) — wording change only in the Git completion block; front matter, `requiredPath` validation via `repositoryPathSchema`, and completion parsing stay untouched.
- `evaluateEvidence` in `src/evidence.ts:245-274` — unchanged coordinator backstop; the plan prevents the failure locally instead of weakening mirror validation.
- `resolveHookBinding`, `runVerifyPhase`, `HookBinding` in `src/hookPolicy.ts:133-230` — the guard reuses the same issue/agent/branch resolution so it can never disagree with coordinated-check binding about which clone/issue it serves; `agentRuntimePaths`/`issueRuntimePaths` in `src/paths.ts:280,345` locate the current `action.md` to obtain `requiredPath` through `readAction`.
- `git`, `gitOrThrow`, `gitDir`, `localConfigGet` in `src/gitExec.ts:33,52,65,92` — all git inspection goes through these; no new process-spawning code.
- `watchOwedWork`, `transcriptStamp`, `updateActionWatch`, `OBSERVATION_INTERVAL_MS` in `src/runLoop.ts:943,2038-2095` and the lifecycle fields in `src/agentLifecycle.ts` (`toolActivity` at `src/agentLifecycle.ts:122,157-158,522-527`; `watch` at `src/agentLifecycle.ts:80,372-393`) — the watchdog keeps its durable one-resend/one-`[WAIT]` bookkeeping; only the fingerprint inputs grow.
- `paneActivityDigest` and `harnessPromptReadiness` in `src/tmux.ts:269-330` — busy/turn-chrome knowledge stays in one place; the nudge path and the watchdog read the same vendor chrome tables.
- Existing test fixtures: `safetyFixture` and journal assertions in `test/runLoop.test.ts` (watchdog describe at line 4485), the rendered-action assertions in `test/action.test.ts`, and the `hook-verify` harness in `test/cli.test.ts`. New cases join these files; no new test file is created.

Scope limits: no change to response/ballot actions, no change to the 60-second interval or resend budget, no new config keys, no new dependencies, no version bump (per repo rules the pre-1.0 `0.0.N` advance is checked only on the PR into `main`, so ordinary issue-branch commits do not plan one), and no unrelated cleanup in `runLoop.ts`/`tmux.ts`.

## Tests

Fewest focused tests, each failing before the change and passing after, joining the existing files named above:

1. `test/action.test.ts`: rendered Git action contains the push-before-`complete` ordering and the pushed-tree-contains-artifact requirement; response action rendering unchanged (no push language).
2. `test/cli.test.ts` (`hook-verify`): outgoing tree missing `requiredPath` → exit `1`, error names the artifact, declared verify commands not run; artifact present in outgoing tree → guard passes; pre-commit with artifact untracked → exit `1`; unbound/scratch clone → guard no-op (exit follows existing verify result).
3. `test/runLoop.test.ts` (`ready-driven delivery and stall watchdog`): worktree/index activity each minute with static pane/transcript and no hooks → sends stay `1`, no `[WAIT]`, no `stalled` journal event; busy turn-chrome pane with static digest region → no resend while busy, resend resumes after busy clears and a quiet minute passes; existing quiet-agent, long-tool-call (`toolActivity.pending`), and growing-rollout tests remain the regression keepers.

Commands (name real ones from `package.json`; the commit/push hooks own the mandatory `pnpm check:fast`, so do not manually duplicate it immediately before committing):

- Focused while developing: `pnpm vitest run --config vitest.config.ts test/action.test.ts test/runLoop.test.ts test/cli.test.ts`
- Docs/action-language gate where applicable: `pnpm check:docs`
- Full acceptance is coordinator-owned at the approved pin (`pnpm check` = build + `check:fast` + e2e); report only the focused checks actually run and cite coordinator results for the rest. Missing verification results are not a pass.

## Alternatives Rejected

- Wording-only fix in `src/action.ts` with no local guard: rejected — #238 shows agents still write `complete` early; the issue explicitly requires an immediate local error where coord intercepts completion/pre-push, not just better prose.
- Coordinator-side-only fix (soften `src/evidence.ts` or auto-nudge with a nicer message): rejected — it keeps burning a nudge cycle per occurrence and weakens the mirror backstop that catches genuinely missing artifacts.
- New `src/requiredArtifact.ts` module or new test files: rejected — `src/hookPolicy.ts` + `test/cli.test.ts` already own this surface; new files would need justification the issue does not provide.
- Watchdog fix via pane scraping alone (widen `paneActivityDigest` to include the footer): rejected — the footer contains the owner draft/composer, whose changes must not count as agent activity; reusing `harnessPromptReadiness` busy reasons targets exactly the vendor chrome that means “working”.
- Watchdog fix via recursive worktree mtime walk: rejected — unbounded cost on large clones; index stamp + `git status --porcelain` hash is bounded, uses existing `git` helpers, and runs at most once per minute per owed agent.
- Raising the 60-second quiet window: rejected — it delays true-stall detection for every agent to paper over missing activity signals; the defect is signal coverage, not the interval.

## Risks and Mitigations

- Guard false positive blocks a legitimate push (e.g. amendment-request JSON at `requiredPath`, or an action whose artifact was already accepted): mitigate by resolving `requiredPath` only from the current action for that exact clone/issue/agent via `resolveHookBinding`-consistent resolution, no-op when none resolves, and covering the amendment/accepted shapes in `test/cli.test.ts`.
- Guard disagrees with `resolveHookBinding` about branch/agent: mitigate by reusing its resolution path and `localConfigGet(consensus.agentId)` conventions rather than re-parsing branch names.
- Worktree stamp too coarse (timestamp granularity) misses rapid edits: mitigate by hashing `git status --porcelain` content, not only mtimes; content changes register even within one timestamp tick.
- Busy-reason reuse misfires (trust dialog counted as work, stalling true-stall detection): mitigate by counting only turn-chrome/busy reasons as activity, never trust/no-prompt reasons, with the busy-then-quiet test proving a resend still happens after busy clears.
- Extra `git status` per watchdog minute adds load on big repos: bounded to agents that currently owe an ordered action and to the existing 60-second observation interval; errors degrade to “never quiet”, the same safe direction as the existing pane-failure branch.
- Action-wording change breaks `check:docs`/agent-language tests: run `pnpm check:docs` and the `test/action.test.ts` assertions above before submitting; keep response-mode text byte-stable.

## Conclusion

Implement exactly the seven changed files above and create none: explicit push-before-`complete` wording in `src/action.ts`, an immediate required-artifact guard in the `hook-verify` path (`src/hookPolicy.ts`, `src/cli.ts`), and a watchdog fingerprint in `src/runLoop.ts` that also sees worktree/index changes and vendor busy chrome. This is the smallest change that fixes both #256 defects at the point of failure, reuses the existing binding/git/lifecycle/tmux machinery, keeps `src/evidence.ts` as the backstop, and is proven by focused failing-before/passing-after tests in the three existing test files.

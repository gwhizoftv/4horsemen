# Issue 161 plan — make the interactive coord CLI readable and operable

Issue #161 lists twelve operator complaints about the foreground `coord N`
terminal and `coord status`. This plan answers each numbered item with the
smallest change that removes the complaint. It adds no new workflow state,
no new owner authority, and no new files under `src/`. One rule applies to
every rewritten message: lead with what is happening in plain words, then say
what the operator can do, with any internal code in trailing parentheses.

Glossary used in all new text (also printed by the verbose help, item 11):

- **action**: one `action.md` that coord writes for an agent, such as "write a plan".
- **turn**: one prompt-to-reply cycle in an agent's terminal.
- **hold**: coord stopped sending work to one agent and is waiting for you.
- **commit** replaces "pin" in every operator-facing line.

## Exact File List to be changed or deleted

- `src/interactive.ts`: items 4a, 4b, 4e, 4f, 5, 6, 7, 8 and 11 (keys, menus, help text).
- `src/ownerControls.ts`: item 6. Moves the `restart-action` state mutation into the shared `restartOwnerAction` so the CLI and the `n` key use the same code.
- `src/cli.ts`: items 4d, 6, 9 and 12, plus wiring for the new interactive commands and the updated usage text.
- `src/issueReport.ts`: items 1, 4a–4e, 9 and 10 (status text and hold descriptions).
- `src/runLoop.ts`: items 1, 2 and 3 (log lines, deferral sentences, start-up hook check, missing-Stop warning).
- `src/workspace.ts`: item 12 (two error messages that say "product").
- `test/interactive.test.ts`: new and updated key-handling cases.
- `test/issueReport.test.ts`: updated status-text expectations.
- `test/cli.test.ts`: covers the coord-root default and the `--repository` alias, and updates the `Policy:` assertion.
- `test/runLoop.test.ts`: covers the new log lines and warnings, and updates the `startsWith("Issue 1: paused")` assertion at line 364.

Nothing is deleted.

## Exact file list to be created

None. Every change extends an existing module or test file listed above. No
new file, dependency, or abstraction module is needed.

## Reuse and Scope

Reused as-is:

- `startInteractiveSession`, `showMenu`, `say`, `dispatch`, and the `confirm` menu flow in `src/interactive.ts`. The new `n` menu and the nudge-loop release confirmation use the existing `Menu`/`confirm: true` path.
- The `restart-action` mutation body in `src/cli.ts` (around lines 1419–1447). Its logic moves verbatim into `restartOwnerAction(paths, agent | null)` in `src/ownerControls.ts`. That function reuses `clearAgentLocalWork`, `invalidateUnpublishedBatches`, `replaceCursor`, `appendJournal`, and `mutateCursorsState`. The CLI command then calls it, then `runTick()` as before. The interactive `n` key calls it without a tick, like the existing `d` key.
- `setOwnerPause(paths, false, { hold, resetBudget })` and `releaseHold` in `src/state.ts`. The interactive release passes `resetBudget: hold.reason === "nudge-loop"` only after an explicit `[y/N]` confirmation. `releaseHold`'s invariants stay as they are.
- `renderIssueReport`, `holdRecoveryCommand`, and `describeWorkflowStep` (`src/steps.ts`). The "Active step / Active roster / Queued guidance" lines that `cli.ts` appends move into `renderIssueReport`, so the `----` frame encloses the whole report everywhere.
- The `DEFERRAL_RATIONALE` table and `deferralRationale` in `src/runLoop.ts`. The entries are rewritten, not replaced.
- `inspectAgentLifecycleHooks` (`src/agentHookSync.ts`) with `config.coordination.cliEntry`, which `initializeEffects` already reads alongside `installRoot`. These give the start-up hook check (item 3).
- `readAgentLifecycle` entry fields `lastEventAt` and `action.orderedAt` give the missing-Stop check (item 3).
- `resolveStart`/`existingIssueRuntime` in `src/cli.ts`. They already default the repository to `io.cwd` for `coord N`; `existingContext` reuses that default (item 4d).
- The `parseArgs` duplicate-option check gives the `--repository` alias (item 12).
- Test fixtures: the `fixture()` in `test/interactive.test.ts`, `start()`/`complete()` in `test/issueReport.test.ts`, `setup()`/`resolvableStartGit`/`fakeLoop` and the onboarded-product setup at `test/cli.test.ts:1642`, and the `fixture()` with `messages` in `test/runLoop.test.ts`.

Per item:

1. **Status needs a good/needs-you marker and plain words.** The first report line becomes `Issue N: <phase> — OK` when nothing needs the operator. It becomes `Issue N: <phase> — NEEDS YOU: <short reason>` when a hold, owner question, or failed publication exists, and `— PAUSED BY YOU` for a manual pause only. `Policy: <id>` becomes `Pull request: coord opens it, you merge it (policy coord-open-unmerged)`; `owner-only` is described the same way, and `coord-merged` reads "coord opens and merges it". The `no-idle-sentinel` and `unknown` deferral sentences are rewritten. Example: "<agent>'s hooks say it is still in a turn and its terminal does not show COORD-IDLE, so coord is not typing into it. If the agent is visibly idle, press n to send its action again." The `unknown` case reads: "coord has not heard from this agent's hooks yet. Normal right after start; if it lasts, run coord doctor." Deferral log lines put the code last: `… (code no-idle-sentinel)`. The R1.join containment `WARNING` is reworded the same way and keeps its current trigger.
2. **Say what coord is doing.** New `this.log` lines in `runLoop.ts`, each printed once per transition:
   - `<agent> finished <step description> (commit abc1234); coord accepted it.`, printed where the acceptance is journaled (`verify-result` ok).
   - `<agent>'s submission was sent back: <first outstanding item>.`, printed in `reissue`.
   - `Running checks on <agent>'s commit abc1234 (<n> command(s))…` and `Checks on abc1234 passed|failed.`, printed around `runVerification` in `runGateVerification`. This line is skipped when there are no commands.
   - `Pushing evidence branch <branch> to GitHub…`, printed before `mirror.publishBranch` in `publishBallotBatch`.
   - `Pushing <branch> and opening the pull request…`, printed before `publishBranch` in `publishAcceptedFinalization`.
3. **Check hooks at start; warn when a Stop hook never arrives.**
   - In `initializeEffects`, for each agent with `delivery` `nudge` or `both`, coord calls `inspectAgentLifecycleHooks`. A `missing` or `modified` result logs: `WARNING: <agent>'s coord hooks are <kind> (<path>). coord cannot tell when <agent> finishes a turn. Re-run coord install (or coord onboard), then restart <agent>.` The check is skipped silently when `config.coordination` is absent. That is the same condition under which `installRoot` is null today.
   - Trust and per-issue binding are not readable from files. COORD_ISSUE comes from the tmux environment. Those stay covered by the existing R1.join containment warning (reworded in item 1) and the existing `staleWorking` message.
   - The runner also keeps an in-memory per-agent count of consecutive accepted actions during which `lastEventAt` never advanced past `action.orderedAt`. At **N = 2** it logs once per agent per runner: `WARNING: no Stop/turn hook from <agent> reached issue N during its last 2 actions; coord is relying on COORD-IDLE in its pane, so delivery will be slower. Check <agent>'s hooks (coord doctor) and that they run with COORD_ISSUE=N.` Any hook event resets the count. No durable state is added.
4. **Hold output.**
   - Holds render through one shared `describeHold(issue, cursors, hold)` in `issueReport.ts`. The run loop's `hold()` log and its vendor-failure log (runLoop.ts ~1015 and ~1300) use it as well, so they print the same text as status.
   - Each of the six hold reasons gets one plain sentence. Example for `nudge-loop`: "coord sent codex the same action 4 times without it finishing (nudge-loop)."
   - **4a.** "Cause" and "reset" print only when vendor evidence exists. An example: `Cause: usage limit (codex, confirmed); provider says it resets at <time>, a recheck time, not a guarantee`. `cause unknown, reset unknown` is dropped. "Reset" in the recovery text always means "allow coord to send again".
   - **4b.** The nudge-loop sentence above explains the term. The fix line reads: `To fix: look at codex's terminal, then press r here (or run <holdRecoveryCommand>) to allow 4 more sends.`
   - **4c.** `Implementation pin` becomes `Implementation commit`, and `Final pin (PR head)` becomes `Final commit (PR head)`.
   - **4d.** `existingContext` resolves the onboarded repository from `io.cwd` when neither `--product`/`--repository` nor `--coord-root` is given, as `coord N` already does. The printed recovery command then works as shown from the repository folder. The error for a non-onboarded cwd names both options.
   - **4e.** `retry owner: owner` becomes `Who acts next: you`; for `vendor` it becomes `Who acts next: <vendor> retries by itself`.
   - **4f.** The verbose help and the controls line say `/steer <text>`: "send one line of guidance to every active agent; it is added to each agent's next action".
5. **Out-of-sync / advance.** No separate "advance" command: coord advances only on accepted artifacts, and skipping that check would break the gate invariants. The `n` key below covers the stuck case. Re-sending the action makes an idle agent publish, and acceptance then advances the turn.
6. **Re-nudge key `n`.** `n` opens a menu: `[1] all agents with unfinished actions`, then one entry per active agent whose cursor has an `actionId`. Every entry needs `[y/N]` confirmation. Selecting one calls `restartOwnerAction`. A fresh `action.md` is issued and the running loop delivers it through its normal safety gates; uncommitted work in the agent clone is untouched. The existing refusal "Release active holds explicitly before restarting work." still applies and is shown as `coord: …`. For a held agent, the operator uses `r` first. `r` on a nudge-loop hold now resets the send budget after confirmation, so the session no longer prints "Nudge-loop release requires --reset-nudge-budget." The menu title drops "(budget reset remains CLI-only)".
7. **Unknown key.** A printable key that is not a command echoes `unknown command '<key>'` followed by the verbose help. Control bytes stay ignored, and the paste guards are unchanged.
8. **Bare Enter.** In `keys` mode, `\r`/`\n` prints an empty line and redraws the prompt.
9. **Frame the status.** `renderIssueReport` output starts and ends with a `----` line. This covers `s`, `coord status`, and the run loop's paused/final reports.
10. **Agent states.** The agent line becomes `Agent codex: action sent, not started yet; mid-turn; hooks healthy …`. Delivery labels: `ordered` is "action.md written, not sent yet", `injected` is "action sent, not started yet", `accepted` is "agent started this action", and `none` is "no action". Execution labels: `unknown` is "no hook report yet", `queued` is "queued", `working` is "mid-turn", `idle` is "idle", and `failed` is "turn failed". Health labels are `healthy`/`degraded`/`unknown`, shown as "hooks healthy", "hooks lagging" and "hooks unknown". `containment hook=… shim=…` becomes `git guard hook=… shim=…`; the probe parenthetical is unchanged.
11. **Verbose help.** `?`/`h` print one full sentence per control (`s`, `p`/Space, `a`, `d`, `n`, `r`, `/steer`, `q`, Enter) plus the glossary above. The one-line `Controls:` banner printed at start stays, with `n` added. The `Foreground TTY runs accept …` paragraph in `cli.ts` usage gains `n`.
12. **"product" becomes "repository".**
    - `parseArgs` treats `--repository` as the same option as `--product`. It stores the value under `product`, so every `allowedFlags` and `requireFlag` call is untouched, and giving both is rejected as a duplicate.
    - Usage text says `--repository <path>` and `onboard <repository>`, and uses "repository" in the prose. One line notes that `--product` is still accepted as the older name.
    - The two `workspace.ts` messages become `… is not a Git worktree; run coord from an onboarded repository or pass --repository <path>.` and `… or pass --repository <path> for an onboarded repository.`
    - The `cli.ts` messages that say `--product` (lines ~372–375, 434, 445, 472, 478, 607) say `--repository`.
    - The flag value semantics, config keys, and the `productRoot` identifiers in code are unchanged.

Out of scope: the routing of Codex hook events to the wrong issue (memory: issue
176). README/docs rewrites, which are not requested (only `--help` is). Any
change to nudge budgets, deferral logic, or gate invariants.

## Tests

Each case below fails before the change and passes after it. All join existing files.

- `test/interactive.test.ts`:
  - New case "echoes Enter and unknown keys with help". Sending `\r` prints `\n` and redraws `coord [? help] > `. Sending `x` prints `unknown command 'x'` and text from the verbose help (for example `n  `/"send its current action again"). None of the commands are called.
  - New case "n re-sends a selected agent's action only after confirmation". The fixture's `commands` gains `unfinished: () => ["codex"]` and `renudge: vi.fn()`. `n`, then `2`, Enter does not call it; then `y` calls `renudge("codex")`. `n`, `1`, Enter, `y` calls `renudge(null)`.
  - New case "nudge-loop release asks first and resets the budget". `holds` returns a `nudge-loop` hold. `r`, `1`, Enter does not call `releaseHold`; `y` calls `releaseHold("hold-1")`.
  - The existing first case keeps passing. Its `unobservable` hold still releases without confirmation.
- `test/issueReport.test.ts`:
  - Update "reports unknown holds …". Expect a leading `----\n` and a trailing `----\n`, plus `NEEDS YOU`, `Who acts next: you`, `to allow 4 more sends`, and `coord resume --issue 1 --agent cursor --reset-nudge-budget`. Expect no `cause unknown`.
  - Update "names the pin …": `Final commit (PR head)`, `Pull request: coord opens it, you merge it`, and a first line containing `— OK`.
  - Update "shows delivery …": `Agent cursor: no action; queued; hooks healthy, pending=2, background-active`.
- `test/cli.test.ts`:
  - Update line 672: `Policy: owner-only` becomes `you merge it (policy owner-only)`.
  - Extend "resolves analytics through an onboarded product" (line 1642). `status --issue N` with `cwd` at the onboarded repository and no `--product`/`--coord-root` exits 0 and prints `Issue N:`. `--repository <path>` behaves like `--product`. `--repository a --product b` exits 2 with `duplicate option`.
  - The existing hold test (line 675) keeps proving `restart-action` refuses under holds through the extracted `restartOwnerAction`.
- `test/runLoop.test.ts`:
  - Extend an existing acceptance test. `f.messages` contains `finished` and `coord accepted it` for the accepted agent.
  - Add one case. A clone whose lifecycle hook file is absent makes `initializeEffects` log `WARNING: claude's coord hooks are missing`.
  - Add one case. Two consecutive accepted actions with no lifecycle event after `orderedAt` log `no Stop/turn hook from claude` exactly once.
  - Update line 364's `startsWith("Issue 1: paused")` to match the framed report (`includes("Issue 1: paused")`).

Commands I will run while developing:
`pnpm vitest run --config vitest.config.ts test/interactive.test.ts test/issueReport.test.ts test/cli.test.ts test/runLoop.test.ts`,
then `pnpm lint` and `pnpm typecheck`. The pre-commit hook owns `pnpm check:fast`.
The coordinator owns the final `pnpm check` at the approved commit.

## Alternatives Rejected

- **An interactive "advance turn" command (item 5).** It would accept work coord never validated and bypass gate invariants. Re-sending the action (`n`) makes the agent produce the artifact the gate needs.
- **`n` as a forced raw tmux send that bypasses idle and pane checks.** That risks typing into an agent mid-turn or into the owner's own typing. Re-issuing through `restartOwnerAction` keeps every existing delivery safety gate and reuses tested code.
- **Renaming the `--product` flag outright (item 12).** That breaks existing scripts, docs, and tests. A parse-time alias gives operators the clearer word with one code path.
- **Persisting the missing-Stop counter in cursors or lifecycle state.** That needs a schema change for an advisory warning. The in-memory per-runner count is enough, and a restart re-arms it.
- **Coloured or Unicode status markers.** Logs are often piped or captured. The words `OK` / `NEEDS YOU` / `PAUSED BY YOU` and ASCII `----` frames survive any terminal.
- **A new `src/glossary.ts` or message-catalog module.** The labels are only used by `issueReport.ts`, `interactive.ts` and `runLoop.ts`, which already import `issueReport.ts`. Small maps in `issueReport.ts` avoid a new file.

## Risks and Mitigations

- **Tests or tools that parse status text.** Only the assertions listed above match the changed strings (checked with `grep` across `test/`). The journal and machine-readable state are unchanged, so analytics are unaffected.
- **`n` used on an agent that is genuinely mid-turn.** The restart only rewrites runtime files. Delivery still waits for the existing idle proof, and the confirmation prompt names the agent. The menu lists only agents with an unfinished action.
- **Interactive nudge-loop release resets the send budget.** It requires an explicit `y`, it is the same mutation as the documented CLI flag, and the `hold-released` journal event still records `resetNudgeBudget: true`.
- **Defaulting `--coord-root` from cwd could pick the wrong workspace.** It uses the same `resolveStart` + `existingIssueRuntime` path as `coord N`, including its config-match and "belongs to a different workspace" refusals.
- **The start-up hook check runs per resume.** It is a read-only file comparison. Warnings print once per `initializeEffects` and never block.
- **Log noise.** Each new line fires on a one-time transition: acceptance, reissue, verification start/end, publish start. Deferral lines keep their existing `log` vs `verbose` split.

## Conclusion

The plan touches six source files and four existing test files, and creates no
new files. It rewrites operator-facing text into plain sentences with an
OK / NEEDS YOU marker and `----` frames. It logs acceptances, checks, and
pushes, and warns at start about missing hooks and after two actions without a
Stop hook. It adds `n` (re-send an action through the existing
`restart-action` mutation), Enter liveness, unknown-key help, verbose help, and
confirmed nudge-loop release under `r`. It defaults `--coord-root` from the
repository folder and introduces `--repository` as the operator-facing name.
Workflow state, gates, and delivery safety stay as they are.

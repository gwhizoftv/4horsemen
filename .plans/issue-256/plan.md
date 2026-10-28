# Plan — issue 256: premature Git-mode `complete` markers and silent-tool watchdog stalls

Issue #256 asks for two guards:

1. Git-mode agents sometimes write `complete` before the push succeeds, or name
   a SHA whose tree lacks the required artifact. The mirror check in
   `src/evidence.ts:274` (`required artifact ... is missing`) then costs a
   nudge cycle.
2. The stall watchdog (`CoordinatorRunLoop.watchOwedWork`,
   `src/runLoop.ts:2057`) builds its quiet fingerprint from three inputs:
   transcript growth, the tool-hook sequence and a pane digest. Transcript
   growth (`transcriptStamp`) is only read for `claude` and `codex`. An agent
   without tool hooks and without a readable transcript (Antigravity, Cursor)
   whose pane stays static for a minute is treated as quiet. It then gets a
   resend and a `stalled` `[WAIT]`, even while it is editing files in its
   clone.

The fix has three parts:

- clearer Git-action completion text;
- a non-blocking pre-push diagnostic inside the existing `coord hook-verify --phase prepush` path;
- a clone-activity stamp added to the existing watchdog fingerprint.

## Exact File List to be changed or deleted

- `src/action.ts`
  - In `renderGitAction`, replace the paragraph that starts "Push the commit containing the artifact to ...". The new text says:
    - commit the artifact at `requiredPath` and run `git push` to the branch;
    - only after the push succeeds, write the pushed commit's SHA to `completePath`;
    - that commit's tree must contain `requiredPath`;
    - an untracked, unstaged or uncommitted artifact, or a push that failed, is rejected and costs a resend.
  - The response-action template is unchanged.
- `src/hookPolicy.ts`
  - Extract the branch, agent and clone resolution that is currently inline in `resolveHookBinding` (lines 150–171) into a private helper, `issueBranchContext`. It returns `{ issue, agent, paths, start, cursors }` or a `reason`. `resolveHookBinding` keeps its current reasons byte for byte; they are asserted in `test/hookSync.test.ts`.
  - Add an exported `requiredArtifactWarning({ clone, configPath, refs }): string | null`. It applies only to a single-ref push of the agent's own `issue-<n>/<agent>` branch, on an active issue whose `start.json` runs this clone. It works regardless of verification mode.
    - It reads `agentRuntimePaths(paths, agent).action` with the existing `readAction`.
    - For a `git` action whose front-matter `agent` matches, it checks the pushed local SHA:
      - **artifact missing from the commit:** if `git cat-file -e <localSha>:<requiredPath>` fails, it returns a warning. The warning names the commit, the required path and the actionId, and says not to write `complete` with this SHA.
      - **worktree differs:** otherwise, if the worktree file is missing, or `git hash-object -- <requiredPath>` differs from `git rev-parse <localSha>:<requiredPath>`, it returns a warning that the working-tree artifact has changes the pushed commit does not contain.
    - It returns `null` in every other case, including any thrown error, a deleted ref (zero local SHA), a response action and manual branches.
    - It uses only `cat-file`, `rev-parse` and `hash-object` through the existing `git()` helper. It never calls `status`, `diff` or `show`, which the containment shim refuses in agent clones.
- `src/cli.ts`
  - In the `hook-verify` branch, when `phase === "prepush"`, call `requiredArtifactWarning` with the already-buffered `refs`. If it returns text, write it to `io.stderr` as `coord prepush: WARNING: ...`.
  - The exit code and the existing verification flow are unchanged.
- `src/runLoop.ts`
  - Add a private async `cloneActivityStamp(start, agent): Promise<string>`.
    - It resolves the clone root from `start.agents`. It returns `"none"` when the root or `<root>/.git` does not exist; the run-loop fixtures use `/clones/<agent>`, so they spawn no git.
    - Otherwise it runs `git ls-files -z --modified --others --exclude-standard` through `this.processRunner`. It sets a timeout, and this command does not rewrite the index.
    - It stats each listed path, sorted and capped at 256 (`mtimeMs:size`, or `gone`), plus `<root>/.git/index`.
    - It returns a sha256 of that list, or `"none"` on any error.
  - In `watchOwedWork`, add that stamp to the existing `fingerprint` tuple next to `transcriptStamp`. Any edit, new untracked file, `git add` or commit in the clone then breaks the quiet window. The quiet rule itself is unchanged: same fingerprint and no pending tool.
  - Update the method's doc comment to name clone activity.
- `test/action.test.ts`: one new case (see Tests).
- `test/hookSync.test.ts`: one new case in `describe("coordinator verification binding")` (see Tests).
- `test/runLoop.test.ts`: one new case in `describe("ready-driven delivery and stall watchdog")` (see Tests).

## Exact file list to be created

- `.plans/issue-256/plan.md`: this coordination artifact only.

No product source or test file is created. Every behaviour change goes into an existing module, and every test joins an existing test file.

## Reuse and Scope

Reused, not reinvented:

- **Action rendering and parsing:**
  - `renderGitAction` and `renderAction` (`src/action.ts`) for the instruction text.
  - `readAction` and `parseAction` (`src/action.ts`) to read the current action in the hook.
- **Runtime paths and state:**
  - `agentRuntimePaths` and `issueRuntimePaths` (`src/paths.ts`).
  - `workspaceLocationFromConfig` (`src/workspace.ts`).
  - `readStartState` and `readCursorsState`, as `resolveHookBinding` already uses them.
- **Hook binding:** `resolveHookBinding`'s existing branch, agent and clone resolution in `src/hookPolicy.ts`. It is extracted into one private helper, `issueBranchContext`, so the binding and the artifact warning apply identical ownership rules and cannot drift apart.
- **Git calls:**
  - In the hook, the `git()` helper from `src/gitExec.ts`, which keeps the hermetic git environment.
  - In the watchdog, the run loop's injected `processRunner` (`runArgv`, which also applies `hermeticGitEnv` for `git`).
- **Hook entry point:** the existing `coord hook-verify --phase prepush` entry in `src/cli.ts` and its single buffered `refs` read. No hook shell under `githooks/` changes.
- **Watchdog:**
  - The fingerprint and quiet logic in `watchOwedWork`.
  - The `transcriptStamp` pattern: fail closed to `"none"`.
  - `sha256` from `src/hash.ts`.
- **Test fixtures:**
  - `order()` in `test/action.test.ts`.
  - `installed`, `activeRun`, `stageWork` and `tryGit` in `test/hookSync.test.ts`.
  - `safetyFixture` (`f.ui.quiet`, `f.working()`, `f.advance`, `f.makeLoop`) in `test/runLoop.test.ts`, following the existing "issue 415: never resends while the Codex rollout grows" case.

Scope limits:

- `src/evidence.ts` acceptance is unchanged; the coordinator stays the authority.
- `src/tmux.ts` is unchanged, because `paneActivityDigest` already sees spinner and elapsed-time repaint.
- `githooks/` is unchanged.
- The warning does not block pushes.
- There is no new config, dependency or file.

## Tests

Each case fails at baseline `d646aedcc21a43dde942c86c65b64aba649c1964` and passes after the change.

1. **`test/action.test.ts`**, new case in `describe("verification instructions")`: "Git actions require a successful push of a commit containing requiredPath before complete".
   - For a Git `order("/runtime")`, the rendered action contains:
     - the push-before-complete sentence;
     - the sentence that the pushed commit's tree must contain the required path;
     - the warning that untracked or uncommitted artifacts are rejected.
   - For a response action, the rendered text contains none of these.
   - Fails today because the sentences are absent.
2. **`test/hookSync.test.ts`**, new case in `describe("coordinator verification binding")`: "warns at pre-push, without blocking, when the pushed commit lacks the current action's required artifact or the worktree copy is uncommitted".
   - Uses `installed(...)` and `activeRun(clone, configPath)`.
   - Writes a Git `action.md` for `claude` with `requiredPath: .signals/issue-1/x.json` at `agentRuntimePaths(paths, "claude").action`.
   - Then three pushes:
     - **(a)** Commit product work without the artifact and push. `exitCode` is 0, and stderr contains `coord prepush: WARNING` and `.signals/issue-1/x.json`.
     - **(b)** Commit the artifact, then change the worktree copy and push. Exit is 0, and stderr contains the uncommitted-changes warning.
     - **(c)** Commit the change and push. Exit is 0, and stderr has no `coord prepush: WARNING`.
   - Fails today because no warning is printed.
3. **`test/runLoop.test.ts`**, new case in `describe("ready-driven delivery and stall watchdog")`: "never resends while a hookless agent edits its clone, even with a static pane".
   - Uses `safetyFixture("antigravity")` with `f.ui.quiet = true`. It rewrites `start.json` so the agent's `root` is a temporary `git init` repository with one committed file.
   - It modifies that file at the same irregular 50–66 s gaps as the Codex rollout case, for 18 minutes. It expects:
     - `f.ui.sends` to be 1;
     - no `[WAIT]` message;
     - no `stalled` journal event.
   - Then it stops editing and advances two more minutes. It expects exactly one resend (`f.ui.sends` 2), which proves the quiet window still works.
   - Fails today because the pane and hook stamps are static, so it resends after the first quiet minute.

Existing watchdog cases keep their behaviour, and are expected to pass unchanged:

- the quiet-resend case at `test/runLoop.test.ts:2812`;
- the blank-capture case;
- the long-tool case.

Their clone roots do not exist, so the stamp is a constant `"none"`.

Development checks:

- `pnpm vitest run test/action.test.ts test/hookSync.test.ts test/runLoop.test.ts` while developing.
- The pre-commit hook owns `pnpm check:fast`.
- The coordinator owns the final `pnpm check` at the approved pin.

## Alternatives Rejected

- **Block the push (exit 1) when the artifact is missing.** Rejected.
  - R4.implement and R6.revise legitimately push product commits before the `implementation-ready` signal (their `requiredPath`) exists.
  - Plan-amendment requests commit a different signal path.
  - Blocking would stall correct workflows; a warning gives the immediate local signal without that risk.
  - The coordinator's mirror validation remains the authority.
- **Validate at `complete` write time.** Rejected: `complete` is a plain file the agent writes with its own tools. Coord has no interception point before the run loop reads it, and the run loop already validates.
- **Watch clone activity with a recursive mtime scan or `fs.watch`.** Rejected.
  - A recursive scan walks `node_modules` and is unbounded.
  - Watchers are stateful across a run loop that is rebuilt every tick; the tests construct a new coordinator per tick.
  - `git ls-files --modified --others` is bounded by the changed set and respects `.gitignore`.
- **Use `git status --porcelain` for clone activity.** Rejected, because `git status` opportunistically rewrites `.git/index`. The coordinator's own probe would then change the index stamp every minute, so the watchdog would never see quiet.
- **Parse vendor busy text in the pane.** Rejected:
  - Spinners and elapsed timers already change `paneActivityDigest`.
  - A static busy string left over from a crashed turn would keep the agent non-quiet forever and suppress the one resend that recovers lost prompts.
  - The `src/tmux.ts` vendor patterns are keystroke-safety checks, not idle detection.
- **Extend `transcriptStamp` to Antigravity and Cursor.** Rejected for this issue: there is no verified transcript location for those vendors in `locateTranscript`, and guessing paths would be speculative.

## Risks and Mitigations

- **The coordinator's own git probe looks like agent activity.**
  - `ls-files` does not write the index, and the stamp reads only `.git/index` metadata.
  - Test 3 checks the reverse case: once edits stop, exactly one resend happens.
- **Watchdog cost.**
  - The probe runs at most once per `OBSERVATION_INTERVAL_MS` per owing agent, which is the existing gate checked before any capture.
  - It has a timeout and caps the path list at 256.
  - Errors return `"none"`, so a failure leaves today's behaviour in place and never adds a resend.
- **Existing runner-call assertions change.** Fixtures whose clone roots do not exist spawn no git, because `<root>/.git` is checked first, so call lists in the other `test/runLoop.test.ts` suites are unaffected.
- **The containment shim refuses the hook's git calls.** The hook uses only `cat-file`, `rev-parse` and `hash-object`, not the refused `status`, `diff` or `show`.
- **Hook-binding behaviour regresses.**
  - The `issueBranchContext` extraction must keep every `resolveHookBinding` reason string identical.
  - The existing "falls back to the local lists, saying why" test covers those strings.
  - `requiredArtifactWarning` catches every error and returns `null`, so a broken runtime never changes the hook's exit code.
- **The wording change breaks consumers.** The action body is advisory prose; `parseAction` reads only front matter. The shim greps only `INCOMPLETE_MATERIALIZATION_NOTE`, which stays untouched.

## Conclusion

The issue can be solved inside four existing modules (`src/action.ts`, `src/hookPolicy.ts`, `src/cli.ts`, `src/runLoop.ts`), with one focused case added to each of three existing test files.

- **Git-action text:** it now states push-then-complete and the requirement that the artifact be in the pushed tree.
- **Pre-push:** the existing hook entry gives an immediate, non-blocking local warning when the pushed commit lacks the current action's artifact, or when the worktree copy is uncommitted.
- **Watchdog:** a cheap, fail-closed clone-activity stamp joins the fingerprint, so hookless agents that are editing their clone are not resent or marked `stalled`.

The plan creates no new files, dependencies or config, makes no hook-shell edits, and does not change coordinator acceptance.

## Comparison

Recommend **Codex `4a41284dacb1380fa4687ef0ed7479b38f85a815`**. It fixes the publication ordering and local artifact guard, observes clone activity without hooks, and preserves eventual stall reporting when terminal chrome freezes. No blocking finding was identified in that pin. The other candidates require corrections described below:

- Muse: `4d1f81306a72f6629cfc05fdb86d5c969ec7a18e`.
- Claude: `f768700b2183852d0606e0877675314ff04c1acc`.

These are the exact product pins from the action. I read their exported worktrees directly; findings refer to paths and line numbers within the named candidate, not to later signal commits.

### Findings

1. **Muse `src/runLoop.ts:2136`; Claude `src/runLoop.ts:2135` — P2: terminal redraws prevent stall detection.** Activity evidence must distinguish agent work from idle UI repaint and owner input already excluded by `paneActivityDigest`. Both implementations include the size/mtime of raw `run-*.log` files in the watchdog fingerprint (`terminalLogStamp` at Muse line 2092 and Claude line 2089). Those pipe-pane logs include footer redraws and composer edits. Therefore an agent that has stopped doing work can reset its quiet baseline indefinitely while the normalized pane, transcript, clone and tool sequence remain unchanged. A focused probe appended only `ESC[2Kfooter redraw\r` once per minute to the raw log with an unchanged idle pane: neither peer resent or reported WAIT across eight minutes. Codex, which does not count raw terminal bytes as work, resent once and reported WAIT once. Extend the existing watchdog tests with this distinction; growth alone is not sufficient evidence.

2. **Muse `src/runLoop.ts:2138`; Claude `src/runLoop.ts:2138` — P2: unchanged busy chrome suppresses recovery forever.** A static busy indicator may defer recovery while a tool is active, but must not permanently remove stall reporting when every other source is unchanged. Both candidates require `!busy` to establish quiet, and reset `quietSince` every minute while busy remains true. A frozen `Thinking…` line consequently produces neither resend nor WAIT for any duration. The focused probe confirmed zero resends and zero WAIT messages through eight minutes. Codex retains the unchanged baseline, reports WAIT once after five minutes, and does not type into a possibly running turn.

   This is also reachable through ordinary text: Muse `src/tmux.ts:294` treats `Documentation says press esc to cancel.` as busy; Claude `src/tmux.ts:283` treats a fenced `Thinking…` example as busy. Both treat a multiline owner draft whose second line is `Thinking…` as busy. Direct calls to the exported parsers reproduced those results. Test frozen chrome beyond the grace period, plus fenced examples and multiline drafts; preserve the separate prompt-readiness checks that protect delivery.

3. **Muse `src/hookPolicy.ts:254`; Claude `src/hookPolicy.ts:242` — P2: staged required-artifact changes can pass pre-push.** The current required artifact must be committed, with index and working file agreeing with the committed artifact, including its mode. Both guards compare the index blob only with the outgoing tree blob and omit the current HEAD comparison and mode comparison. Commit artifact A, commit B, then stage A and push the older A SHA to a new own issue branch: both guards accept despite the staged reversion. Separately, `git update-index --chmod=+x <requiredPath>` also passes while the executable-bit change is uncommitted. Isolated Git fixtures reproduced both cases for both peers; their ordinary unstaged-content checks correctly rejected a control case. Codex rejected both staged cases. Add these cases to the existing real-hook artifact tests.

4. **Muse `src/hookPolicy.ts:208` — P2: only the first issue ref determines artifact enforcement.** Every outgoing update of the agent's active issue branch must receive the guard, independently of other pushed refs. Muse resolves runtime state only for `issueUpdates[0]`, returns success if that runtime cannot be read, and later skips branches different from the first. A push containing an inactive `issue-99/claude` update before an active `issue-1/claude` update therefore passes with a dirty required artifact in issue 1. The focused two-ref fixture reproduced acceptance by Muse, versus rejection by Claude and Codex. Test that an unrelated first update cannot exempt a later active update.

5. **Muse `src/runLoop.ts:2067` — P2: the clone probe can block the coordinator without a deadline.** Periodic observation must be bounded and must not synchronously stall all agents while probing one clone. The new probe calls the installer-oriented `git()` helper, whose `src/gitExec.ts:37` uses `spawnSync` without a timeout. The 1,024-path limit is checked only after Git returns. A slow or hung `git ls-files --modified --others` therefore blocks the event loop and every agent's processing, rather than producing an unavailable sample. This is a source-inspection finding; I did not hang a live coordinator to demonstrate it. Use the existing async process runner with a deadline and test its timeout result. Claude and Codex already use that runner for this probe.

### Scope, reuse, and coverage

All three candidates stay within the same approved nine product files: `src/action.ts`, `src/cli.ts`, `src/hookPolicy.ts`, `src/runLoop.ts`, `src/tmux.ts`, and the four corresponding existing action, hookSync, runLoop and tmux test files. Their additional plan/review/join paths are coordination evidence. None adds product files, dependencies, version changes, a new lifecycle schema, or product-hook edits.

All three clearly require a successful push containing the artifact before writing complete. Each wires its artifact guard into pre-push rather than blocking the commit needed to create the artifact, and supports the product-before-signal implementation workflow. They reuse runtime/action parsing, Git helpers, lifecycle watch persistence, vendor parsers and existing test fixtures. Claude extracts a shared issue-branch context helper for binding and artifact checks; that is a relevant local reuse refactor, not unrelated scope growth. Muse adds a terminal-log helper and uses the synchronous installer Git helper; the findings above explain why those choices are unsuitable here.

Claude has useful parameterized coverage for repeated dirty edits, untracked paths, index changes and incomplete enumeration. Its terminal-log tests, however, assert that arbitrary raw log growth suppresses recovery, and its static-busy test asserts continued suppression through ten minutes. Muse's focused clone-edit and artifact tests cover normal paths but miss the multi-ref, staged-reversion, frozen-busy and noisy-log failures. Both extend existing files rather than adding a new test framework.

Codex adds focused coverage for artifact tree/index/working-file states in local and coordinator modes, an older outgoing SHA matching a staged reversion, product-before-signal pushes and amendments, repeated file activity across watchdog restarts, failed/truncated enumeration, and frozen busy chrome followed by idle recovery. It reuses containment/path helpers and checks action identity/digest, literal paths, regular-file modes, HEAD, index and working bytes. Its clone observation uses bounded async enumeration, rejects incomplete output, and refreshes lifecycle state after awaiting observation. It also avoids treating coordinator bookkeeping or raw log redraws as agent progress.

Codex deliberately defers stall decisions when the probe is incomplete, including its 4,096-path/32-KiB limits, and emits a warning. That is a visible conservative limitation, not proof of agent activity. Its five-minute frozen-busy threshold produces a WAIT report, not automatic input into a running turn. Final coordinator checks remain required.

### Verification evidence

The runtime `journal.jsonl` records successful advisory hook observations for all three candidates:

| Candidate | `pnpm run check:fast` | `pnpm run test:e2e` |
| --- | --- | --- |
| Muse | sequence 123, exit 0 | sequence 124, exit 0, outgoing range ends at `4d1f81306a72f6629cfc05fdb86d5c969ec7a18e` |
| Claude | sequence 130, exit 0 | sequence 131, exit 0, outgoing range ends at `f768700b2183852d0606e0877675314ff04c1acc` |
| Codex | sequence 138, exit 0 | sequence 140, exit 0, outgoing range includes product pin `4a41284dacb1380fa4687ef0ed7479b38f85a815` and ends at its evidence commit `c43fda3d0e823849497ba17373b0f8496904c516` |

These are hook records, not coordinator candidate/final-suite results. I ran Codex's development checks and witnessed its commit/push checks during implementation; I did not rerun peers' full suites for comparison.

For this review I ran `node /private/tmp/issue-256-compare-probe.mjs` successfully against TypeScript-transpiled copies of all three exported source trees. The probe used disposable Git repositories for the publication checks and the actual watchdog methods with a simulated minute clock, stable clone/transcript observations, and captured delivery/log calls. It also called the actual exported busy parsers. It did not type into live terminals or modify the bound worktrees. All expected-result assertions passed; temporary fixture trees were removed.

| Focused reproduction | Muse | Claude | Codex |
| --- | --- | --- | --- |
| Clean committed artifact | Accepted | Accepted | Accepted |
| Ordinary unstaged content change | Rejected | Rejected | Rejected |
| Staged reversion matching older outgoing SHA | Accepted | Accepted | Rejected |
| Staged mode-only change | Accepted | Accepted | Rejected |
| Inactive first ref, active dirty-artifact second ref | Accepted | Rejected | Rejected |
| Frozen busy pane, eight simulated minutes | No resend or WAIT | No resend or WAIT | No resend; one WAIT |
| Idle pane with only raw footer-log redraws | No resend or WAIT | No resend or WAIT | One resend; one WAIT |

### Verdict

Select Codex `4a41284dacb1380fa4687ef0ed7479b38f85a815`. Claude is the closer alternative because it bounds Git observation and validates each outgoing ref, but it shares the artifact and watchdog failures above. Muse also needs per-ref enforcement and a bounded async probe. Neither peer's passing existing suites covers those reproduced failures.

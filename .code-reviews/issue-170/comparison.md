# Comparison of the issue 170 implementations

Bound implementation pins:
- claude `4cd51349bccc088fde3d100daceecd9ce1d8280c`
- cursor `5f79510f6b6082f76e83113d8619a82a6c65bd34`
- codex `176db1508f7edd49167663347fa6d365e31284a7`

All three were read from the exported worktrees. I compared the source directly and ran no product suites. Line numbers refer to each pin's worktree. The claude pin is mine and is reviewed with the same rules.

## Comparison

### Shared ground

All three implement the selected plan's shape:
- a frozen `verification` policy in `start.json`
- hook binding read from the committed or single pushed ref, with no `githooks/` edits
- a candidate gate whose failures return `status: "rejected"`, so the agent receives a reissued action with the command and its log
- a shared runner with receipts under `<coordRoot>/verification/`, keyed on the declared argv
- an expensive-command limiter
- diagnostic-only retries
- receipt-based skipping at finalization
- a `test:system` tier

All three reuse #162's classifier, `verificationMeasurement`, `materializeWorktree` and `ProcessRunner`, and extend the existing `runLoop`, `hookSync`, `verify-config`, `state`, `action` and `analytics` suites.

None of them changes the tracked `AGENTS.md`, which carries the skip-worktree bit in agent clones. Each updates only `templates/product/AGENTS.protocol.md`.

All three stay within the approved file map; codex also edits `test/cli.test.ts`, which is approved.

### cursor `5f79510f6b6082f76e83113d8619a82a6c65bd34`

**K1. `src/verificationReceipts.ts:168-169` and `:206-216`: lock reclaim and release.**
- *Rule:* single-flight and the expensive limit must never admit two live owners. A lock may be reclaimed only when its owner is proven gone, and a release may remove only the releaser's own lock.
- *Failure:*
  - `isStale` treats any lock older than six hours as stale, even when its pid is alive on this host. A second runner deletes it and starts the same key or slot.
  - When the first owner finishes, `releaseLock` unconditionally unlinks the path (line 213). That deletes the second owner's lock, so a third runner can start too: three live executions under `maxConcurrentExpensive: 1`.
- *Test:* write a lock with `process.pid`, this hostname and a `startedAt` older than 6 h. `acquireLock` must return `null`. Then acquire A, swap in B's record, and release A: B's file must remain.

**K2. `src/verificationRunner.ts:302-306`: receipt written without checking tracked inputs.**
- *Rule:* a receipt certifies the inputs the command actually ran against (issue §4: never reuse results from a dirty checkout).
- *Failure:* an uncached preparation step such as `install`, or a postinstall script, rewrites a tracked file. The cached `lint` then passes against the modified tree, and the receipt is stored under the original pin's identity. A later clean pin with the same tree reuses a pass that never happened on those bytes.
- *Test:* a first uncached command writes to `src/a.ts` in the worktree. The cached command after it must not produce a `readReceipt(...).ok` receipt.

**K3. `src/changeClassification.ts:162` with `src/state.ts:344-368`: dedupe by name.**
- *Rule:* every command a matching risk rule requires must run (codex review finding 3).
- *Failure:* the schema allows a cheap candidate `test` (`["make","quick"]`) and a final `test` (`["make","test"]`). A rule adding `test` is dropped by the name dedupe, so the expensive command never runs before review.
- *Test:* refine the schema to reject a same-name candidate/final pair with a different argv, and assert that `coordinatorConfigSchema.safeParse` fails.

**K4. `src/state.ts:323-326`: names must be unique even without `verification`.**
- *Rule:* absent `verification` preserves existing behavior.
- *Failure:* a workspace config that declared two checks with the same name, valid at baseline, now fails `readConfig`. That blocks `coord start` and every hook through `resolveWorkspaceConfig`, even in local mode.
- *Test:* a config without `verification` whose `checks` repeat a name still parses.

**K5. `src/verificationRunner.ts:143-147`: key material.**
- *Rule:* the key comes from the real platform, and receipts do not copy secrets.
- *Failure:*
  - `COORD_PLATFORM`, `COORD_ARCH` or `COORD_NODE` in the coordinator's environment silently replace the real platform in the key, so a Linux receipt can be reused on macOS.
  - Declared env **values** such as tokens are written verbatim into receipt files.
- *Fix sketch:* use `process.*` only, and store `sha256(value)`.

**Scope and tests.** Within scope. The 421-line runner test file is the largest. The duplicate final-check rows recorded for reused components (attempt 0, duration 0) are harmless.

### codex `176db1508f7edd49167663347fa6d365e31284a7`

**X1. `src/verificationReceipts.ts:120-128` and `:161`: interrupted locks.**
- *Rule:* after a restart, a submission still in `verifying` is re-evaluated automatically (issue §6: "including after restart"). Recovering must not need manual runtime surgery.
- *Failure:*
  - The owner quits `coord` (`q`), or the process is killed, while a candidate or expensive suite runs. On `coord run`, `tryVerificationLock` finds the dead same-host pid and **throws** "Interrupted verification lock".
  - That throw comes out of the tick on every poll. The issue makes no progress until the owner finds and deletes that exact lock file (the procedure documented at `docs/coord-driver.md:786-791`).
  - A dead expensive-slot owner does the same through `tryExpensiveSlot`, blocking every expensive command workspace-wide.
- *Test:* a lock owned by an exited pid on this host. `runVerification` must either run the command or wait on a still-live child, not throw.

**X2. `src/verificationRunner.ts:121-124` and `:171`: tracked-input changes become gate failures.**
- *Rule:* a rejection must name a real failing command with its log.
- *Failure:*
  - When a preceding command mutates a tracked file, the next command is reported as `exitCode: 1` with no `logPath`, without ever running.
  - The agent receives "failed with exit 1 (log: execution inputs changed before command)", blaming a command that never ran.
  - A product whose build legitimately regenerates a checked-in file can never pass the gate.
- *Correction:* treat it as "uncached" (no receipt), as the issue asks, rather than as a failure.

**X3. `config.example.json`: commit-mode caching.**
- *Rule:* the example should demonstrate the issue's reuse across evidence commits and cleanup.
- *Failure:* `lint` and `typecheck` cache with `"inputs": "commit"`, and `test:fast`, `test:system` and `test:e2e` are uncached. Every revision pin and the final cleanup commit has a new commit id, so the shipped example never reuses a candidate result at finalization: `pnpm check`-equivalent work runs twice. This is conservative and allowed by the issue, so the finding is minor.

**X4. `src/verificationRunner.ts:99`: probes counted as runners.**
- *Rule:* analytics count suite executions, not identity probes.
- *Failure:* toolchain probes are journaled as `verification-run` rows (`probe:<name>`), which inflates `recordedRunners` and candidate/final runner counts in `coord analytics`.

**X5. `package.json` `check:fast`: includes `test:system`.**
- This preserves manual coverage (codex review finding 1), but the default pre-commit hook still runs every system suite on each product commit. Issue §5's cheap pre-commit tier is achieved only through `coordinated.precommit: []` in coordinator mode.
- It is a defensible trade-off. The other two keep `check:fast` cheap and add `test:system` to `verify.prepush` instead.

**Strengths.**
- dependency identity hashing
- `HEAD`/status checks before and after each command
- env redaction in logs
- compare-owner release
- rejection of same-name conflicts (`src/state.ts:165-180`)
- full-identity dedupe

These are the most conservative receipt semantics of the three.

### claude `4cd51349bccc088fde3d100daceecd9ce1d8280c` (self-review)

**C1. `src/verificationRunner.ts:88-104`: unbounded join wait.**
- *Rule:* a waiting coordinator must not block the tick forever on another runner.
- *Failure:* `claim` polls while a live owner holds the per-key lock, with no time limit. A hung owner process (alive, never finishing) holds this coordinator's tick indefinitely. `checkpoint()` still lets a pause or authority change interrupt it, but nothing else does.
- *Correction:* a bounded wait, after which the command runs without joining (cursor's 30-minute limit is a reasonable model).

**C2. `src/verificationReceipts.ts:143-147`: reclaim after a coordinator crash.**
- *Rule:* the expensive limit holds for live suites.
- *Failure:* when the coordinator dies mid-suite, its pid is dead, but an orphaned child test process may still be running. The next runner reclaims the slot and starts a second expensive suite beside the orphan, exceeding `maxConcurrentExpensive` until the orphan exits.
- Correctness is unaffected: only a fresh exit-0 run writes a receipt. Codex fails closed here instead, at the cost of X1.

**C3. Coverage of tracked-input changes is partial.**
- The tracked-input check (`trackedInputsClean` before and after) correctly withholds the receipt and is covered by `test/verificationRunner.test.ts`.
- Undeclared untracked dependency state, such as `node_modules` contents, is keyed only through declared probes. Codex's `dependencyIdentity` is stricter.

Otherwise:
- **Example caching:** the cached checks use `tree-excluding-evidence`, and `test/verify-config.test.ts` asserts that no lint, typecheck or vitest include root can read an evidence path.
- **Commands and receipts:** the schema rejects same-name argv conflicts, locks use link-published records and token-compared release, and env values are stored as digests.
- **Test split:** `check:fast` stays cheap, with `test:system` added to the example and proposed `verify.prepush`.

### Overall

| | cursor | codex | claude |
|---|---|---|---|
| Lock safety | age reclaim and unconditional release (K1) | safe, but blocks after a crash (X1) | safe; orphan overlap possible (C2) |
| Receipt input integrity | no tracked-input check (K2) | strongest (dependency identity) | tracked-input check, probes |
| Name/identity conflicts | dropped requirement (K3) | rejected | rejected |
| Backward compatibility | duplicate names now break configs (K4) | preserved | preserved |
| Reuse across evidence commits (example) | yes | no (commit mode, X3) | yes, with a proof test |
| Fast pre-commit tier | kept | lost for local mode (X5) | kept |

Recommendation: **claude `4cd51349bccc088fde3d100daceecd9ce1d8280c`**, with C1 (a bounded join wait) as the revision item and codex's `dependencyIdentity` as an optional strengthening.

- **cursor** has two correctness defects in the core exclusion and receipt paths (K1, K2), one dropped-requirement defect (K3) and a regression for existing configs (K4).
- **codex** is the most conservative on receipts, but X1 turns any interrupted suite into a stalled issue that needs manual file removal, and X2 misreports tracked-input changes as command failures.

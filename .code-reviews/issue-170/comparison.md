# Issue 170 — implementation comparison

Bound pins compared from exported worktrees (not peer fetches):

- claude `4cd51349bccc088fde3d100daceecd9ce1d8280c`
- cursor `5f79510f6b6082f76e83113d8619a82a6c65bd34`
- codex `176db1508f7edd49167663347fa6d365e31284a7`

## Comparison

All three implement the selected plan’s core shape: opt-in `verification` snapshotted at start, TS-side hook binding from HEAD/prepush stdin (no `githooks/` edits), candidate failure as `status: "rejected"` → `reissue-action`, declared-argv receipt keys, shared runner with join/limiter/diagnostic retry, `test:system` split, and the coordinator-mode clause in `templates/product/AGENTS.protocol.md`. None edits `orderScaffold.ts` or `install.ts`. None lands the product `AGENTS.md` clause (skip-worktree staging refusal on every pin).

**Prefer claude `4cd51349bccc088fde3d100daceecd9ce1d8280c`**, then cursor, then codex. Claude is closest to plan fidelity with stronger receipt trust (env digests + post-run dirty-tree gate). Cursor matches most semantics and has the deepest runner/runLoop tests but stores raw env values in receipt material. Codex adds out-of-map surface and regresses the cheap/manual suite split.

### Shared strengths

- Candidate gate rejects with command + log; machine path is reissue, not silent `retry-verification` (claude `src/runLoop.ts:2437`, cursor `:2517`, codex `:2413`).
- Hook binding fail-closes to local lists; multi-ref unbound; no hook-body `--ref`.
- `selectCandidateVerification` covers / rules / unclassified → full gate.
- `mode: "coordinator"` requires `coordinated` + `candidate` in schema refinements.

### Findings

1. **cursor — `src/verificationRunner.ts:147` (schema `src/verificationReceipts.ts:71`).** Rule: receipt keys must not copy secret env values into owner storage; digests (or presence-only) are required. Failure: `env: cache.env.map((name) => ({ name, value: environment[name] ?? null }))` persists plaintext into `<coordRoot>/verification/receipts/`. Smallest test: run a cached command with `TEST_SECRET=x` declared in `cache.env`; assert stored `env[].value` is null or a 64-hex digest, never `"x"`. Claude already digests via `envDigests` (`src/verificationReceipts.ts:63–64`).

2. **cursor — `src/verificationReceipts.ts:169`.** Rule: age alone must not reclaim a lock while its owner may still be running (plan reviews; issue concurrency bound). Failure: `age > LOCK_MAX_AGE_MS` returns stale even when `process.kill(pid, 0)` succeeds on another host’s slow suite, allowing overlapping expensive runs. Claude deliberately refuses age reclaim (`src/verificationReceipts.ts:140–148`). Smallest test: plant a same-host live-pid lock with `startedAt` seven hours ago; expect `acquireLock` to return null while the pid lives.

3. **cursor / codex — `src/changeClassification.ts:166` (cursor; codex analogous).** Rule: `expanded` means the selection fell through to the full final gate, not that any risk rule fired. Failure: a `githooks/` change that only adds `test:e2e` sets `expanded: added.size > 0` → true, so journals/`candidate-check` misreport full-gate expansion. Claude sets `expanded` only on full-gate paths. Smallest test: covered+rule path → `expanded === false` and commands = candidate ∪ rule adds; unclassified path → `expanded === true` and commands = `start.checks`.

4. **codex — `package.json:17` and `config.example.json:77–84`.** Rule: `check:fast` stays the cheap precommit profile; `verify.prepush` must retain `test:system` so manual branches do not lose the moved suites (selected plan). Failure: `check:fast` runs `test:system` on every commit, and example `verify.prepush` is only `test:e2e`, so unbound/manual pushes drop system coverage relative to the Claude/cursor examples. Smallest test: example prepush names include `test:system`; `scripts["check:fast"]` must not contain `test:system`.

5. **codex — `src/verificationReceipts.ts:126`.** Rule: a same-host lock whose pid is gone is stale and reclaimable so a restart can finish the gate. Failure: `ESRCH` throws `"Interrupted verification lock…"` instead of reclaiming, so a crashed owner permanently blocks that key until manual cleanup. Smallest test: leave a same-host dead-pid lock; expect the next `runVerification` to reclaim and run, not throw.

6. **codex — `test/cli.test.ts` (freeze/digest coverage).** Rule: implementation may change only the approved path map. Failure: codex edits `test/cli.test.ts`, which is not on the approved map for this issue (claude/cursor cover start freeze via `test/state.test.ts` / action paths already listed). Correction: move the assertion into an approved test file or request a plan amendment.

7. **all three — product `AGENTS.md`.** Rule: tracked product AGENTS and the install template both carry the coordinator-mode cite clause (selected plan). Failure: only `templates/product/AGENTS.protocol.md` gained the clause; product `AGENTS.md` is unchanged on every pin (skip-worktree staging refusal). Smallest correction: owner lands the tracked clause; escalate rather than clear skip-worktree. Illustrative test already exists in spirit via shipped-examples language checks once the tracked file updates.

8. **claude — `src/verificationReceipts.ts:143–148` (trade-off, not a plan regression).** Rule: concurrent runners must not hang forever on an abandoned foreign-host lock. Failure: without age reclaim, a foreign hostname lock that never clears blocks joiners until operator intervention. Claude’s choice correctly avoids Cursor finding #2; pair it with an owner-recovery path or a fenced lease in revision if hang risk matters. Not a reason to prefer Cursor’s age reclaim as written.

### Scope, reuse, and tests

| | claude `4cd51349…` | cursor `5f79510f…` | codex `176db150…` |
|--|--|--|--|
| Within approved map | Yes (+ post-run `trackedInputsClean`) | Yes | No (`test/cli.test.ts`; cache `commit`/dependency extras) |
| Reuse | Classifier, mirror, `ProcessRunner`, journal, `reissue-action` | Same | Same, plus heavier lock registry |
| New files | receipts, runner, system vitest, one runner test | Same | Same |
| Test depth | Adequate candidate/hook/runner | Strongest runner + reissue decide coverage | Adequate; suite split wrong |

Claude’s `trackedInputsClean` before/after receipt write (`src/verificationRunner.ts:184`, `:238`) is the best trust addition among the three and stays inside the runner module.

### Verdict

Select **claude `4cd51349bccc088fde3d100daceecd9ce1d8280c`**. Adopt cursor’s deeper runner/reissue tests and keep Claude’s env digests, post-run clean check, and no-age lock reclaim. Do not select cursor until finding #1 (env plaintext) is fixed. Do not select codex until findings #4–#6 are fixed. Product `AGENTS.md` (finding #7) is an owner follow-up on every pin.

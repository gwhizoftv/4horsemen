# Issue 170 — implementation comparison

Bound pins compared from exported worktrees (not peer fetches):

- claude `1fe1bfe6a4e39975a5a4150a7e58aa14e37ceb6f`
- cursor `f0fd12fb598086d13516ecdca5c90156e14a2a85`

## Comparison

Both pins implement the selected plan’s core shape: opt-in `verification` snapshotted at start, TS-side hook binding from HEAD/prepush stdin (no `githooks/` edits), candidate failure as `status: "rejected"` → `reissue-action`, declared-argv receipt keys, shared runner with join/limiter/diagnostic retry, `test:system` split, and the coordinator-mode clause in `templates/product/AGENTS.protocol.md`. Neither edits `orderScaffold.ts` or `install.ts`. Neither lands the product `AGENTS.md` clause (skip-worktree staging refusal).

**Prefer claude `1fe1bfe6a4e39975a5a4150a7e58aa14e37ceb6f`**. Claude keeps stronger receipt trust (env digests + post-run dirty-tree gate), refuses age-only lock reclaim, and on a live join timeout returns `waiting` so the tick yields and re-evaluates later without a second unlocked runner. Cursor’s pin now also avoids unlocked parallel runs (it polls until the lock is acquired), but still stores plaintext env in receipts, still reclaims by age alone, and still mis-flags `expanded` when only a rule add fires.

### Shared strengths

- Candidate gate rejects with command + log; machine path is reissue, not silent `retry-verification` (claude `src/runLoop.ts:2443`, cursor `:2517`).
- Hook binding fail-closes to local lists; multi-ref unbound; no hook-body `--ref`.
- `selectCandidateVerification` covers / rules / unclassified → full gate.
- `mode: "coordinator"` requires `coordinated` + `candidate` in schema refinements.
- Neither runs the same receipt key unlocked beside a live owner (claude wait→retry; cursor wait-until-lock).

### Findings

1. **cursor — `src/verificationRunner.ts:145` (schema `src/verificationReceipts.ts:71`).** Rule: receipt keys must not copy secret env values into owner storage; digests (or presence-only) are required. Failure: `env: cache.env.map((name) => ({ name, value: environment[name] ?? null }))` persists plaintext into `<coordRoot>/verification/receipts/`. Smallest test: run a cached command with `TEST_SECRET=x` declared in `cache.env`; assert stored `env[].value` is null or a 64-hex digest, never `"x"`. Claude digests via `envDigests` (`src/verificationReceipts.ts:79`).

2. **cursor — `src/verificationReceipts.ts:169`.** Rule: age alone must not reclaim a lock while its owner may still be running. Failure: `age > LOCK_MAX_AGE_MS` returns stale even when `process.kill(pid, 0)` succeeds, allowing overlapping expensive runs after six hours. Claude reclaims only on proven dead same-host pid (`src/verificationReceipts.ts` lock helpers). Smallest test: plant a same-host live-pid lock with `startedAt` seven hours ago; expect `acquireLock` to return null while the pid lives.

3. **cursor — `src/changeClassification.ts:166`.** Rule: `expanded` means the selection fell through to the full final gate, not that any risk rule fired. Failure: a `githooks/` change that only adds `test:e2e` sets `expanded: added.size > 0` → true, so journals/`candidate-check` misreport full-gate expansion. Claude sets `expanded: false` on the rule-add path (`src/changeClassification.ts:140`). Smallest test: covered+rule path → `expanded === false` and commands = candidate ∪ rule adds; unclassified path → `expanded === true` and commands = `start.checks`.

4. **cursor — `src/verificationRunner.ts:226` (trade-off).** Rule: a hung live owner must not stall the coordinator tick indefinitely. Failure: after removing the join-wait unlock path, the waiter polls until `acquireLock` succeeds; a live owner that never finishes holds the tick open until the six-hour age reclaim (finding #2) or process death. Claude’s `joinWaitMs` returns `{ status: "waiting" }` and `waitingObservation` maps to `retry-verification` (`src/runLoop.ts:720–724`, `:2443`). Prefer Claude’s bounded wait; do not restore Cursor’s old unlocked fallback.

5. **claude — `src/verificationRunner.ts:91–95`.** Rule: comments that describe lock/join behavior must match the code reviewers rely on. Failure: the `claim` JSDoc still says a timed-out waiter “runs the command itself without the lock,” but the implementation returns `"timed-out"` and the caller returns `status: "waiting"` (`:191`). Smallest correction: rewrite the comment to match the waiting/retry contract already covered by `test/verificationRunner.test.ts` (“stops waiting… without running the same key unlocked”).

6. **both — product `AGENTS.md`.** Rule: tracked product AGENTS and the install template both carry the coordinator-mode cite clause (selected plan). Failure: only `templates/product/AGENTS.protocol.md` gained the clause on both pins. Smallest correction: owner lands the tracked clause; escalate rather than clear skip-worktree.

### Scope, reuse, and tests

| | claude `1fe1bfe6…` | cursor `f0fd12fb…` |
|--|--|--|
| Within approved map | Yes (+ post-run `trackedInputsClean`) | Yes |
| Reuse | Classifier, mirror, `ProcessRunner`, journal, `reissue-action` | Same |
| New files | receipts, runner, system vitest, one runner test | Same |
| Join under live owner | wait → `waiting` → retry tick | poll until lock (age reclaim) |
| Test depth | Adequate candidate/hook/runner + join-wait | Strong runner + reissue decide coverage |

Claude’s `trackedInputsClean` before/after receipt write remains the better trust addition and stays inside the runner module.

### Verdict

Select **claude `1fe1bfe6a4e39975a5a4150a7e58aa14e37ceb6f`**. Keep Claude’s env digests, post-run clean check, no-age lock reclaim, and bounded join wait. Cursor’s pin fixed the unlocked parallel-run hole but still needs findings #1–#3 before it could lead. Product `AGENTS.md` (finding #6) is an owner follow-up on both pins.

# Issue 146 — implementation comparison

Bound implementation pins:

- cursor `70a73f4cdb8bd595898c16eda169869294921edb`
- codex `7ecd02f2b22225a22c0e63eca2d03acf71946f6b`
- claude `c798f46594cf1192311ce3de044f6b555c2768ee`

## Comparison

All three pins deliver the issue’s core contract: same-branch dirty WIP no longer blocks prepare; `run()` finishes only on `completed || abandoned` (holds and manual pause wait); plain `coord resume` still clears only the manual pause; scoped release uses `--hold` or unambiguous `--agent`; `--run` is opt-in for a stopped coordinator; `StateConflictError` during `initializeEffects` retries rather than exiting. None invent new modules. Differences are in validation, TOCTOU guards, and test depth.

### Shared strengths

- **prepare:** dirty preflight blocks only when `HEAD !== issueBranchFor(...)` (cursor `src/prepareAgentBranch.ts:242`, codex `:210`, claude `:213`). Off-branch dirt still refuses before mutation; same-branch plan/implement files are kept.
- **liveness:** `finished = completed || abandoned` (cursor `src/runLoop.ts:2735`, codex `:2730`, claude `:2742`). Held ticks stay observation-only.
- **#126 resume:** no `--hold`/`--agent` → `setPaused` only (cursor `src/cli.ts:1634-1635`, codex `:1623`, claude `:1625`).
- **`--run`:** state-only by default; `--run` starts the loop after exclusion (cursor `:1655-1657`, codex `:1632`, claude `:1634-1637`).

### Findings

1. **cursor `70a73f4cdb8bd595898c16eda169869294921edb` — `src/cli.ts:1616-1632`.** `--agent` resolves by hold agent id only and never checks `activeRoster`. **Rule:** scoped `--agent` recovery must name an active roster agent (selected plan / codex `:1615`, claude `agentHoldId` at `:178`). **Failure:** after a drop, a stale hold for a non-active agent can still be released with `--agent <dropped>`, acknowledging retired work under the short selector. **Test:** seed a hold whose agent is absent from `activeRoster`; `coord resume --agent …` must exit non-zero and leave holds unchanged (codex CLI coverage already asserts this).

2. **cursor `70a73f4cdb8bd595898c16eda169869294921edb` — missing `test/runLoop.test.ts` coverage for init conflict / hold-release continue.** Implementation retries `StateConflictError` from `initializeEffects` (`src/runLoop.ts:2768-2771`) but has no test that mutates state during init or that the same runner initializes after a hold release. **Rule:** wait-don’t-exit and init-retry must be regression-locked. **Failure:** a later change that rethrows init conflicts or exits on hold would pass cursor’s suite while breaking the issue. **Test:** port codex `test/runLoop.test.ts` cases that abort after several sleeps while held, then release and show init; and the inject-`StateConflictError`-during-ensureSession retry case.

3. **claude `c798f46594cf1192311ce3de044f6b555c2768ee` and cursor `70a73f4cdb8bd595898c16eda169869294921edb` — prepare mid-loop branch identity.** Codex rechecks `onBranch !== snapshot.head` before acting (`src/prepareAgentBranch.ts:238-239`). Claude/cursor omit that refuse. **Rule:** between batch preflight and per-clone work, a clone that changed branches must not be checked out silently. **Failure:** a clean clone that switches branch after the snapshot can be force-checked onto the issue branch without the explicit “changed branches during preparation” refusal. **Test:** after snapshot, move HEAD of one clean clone; expect throw and no checkout (codex path).

4. **claude `c798f46594cf1192311ce3de044f6b555c2768ee` — `src/issueReport.ts:21-22`.** `--agent` shortcut in recovery text does not require `activeRoster.includes(hold.agent)` (codex `holdRecoveryCommand` at `src/issueReport.ts:14-15` does). **Rule:** recovery instructions must not advertise a selector the CLI will reject. **Failure:** status can print `--agent <dropped>` while Claude’s CLI `agentHoldId` refuses non-active agents, sending the owner to a dead command. **Fix sketch:** gate the shortcut on active roster the same way codex does (or align CLI to accept the hold by agent regardless — prefer roster gate).

### Scope and reuse

| Pin | Within issue | Reuse | Extra surface | Tests |
|-----|--------------|-------|---------------|-------|
| codex `7ecd02f2…` | yes | snapshot + existing release/run helpers; healthy-overlay fast path on already-on-branch | branch recheck; fullest CLI/runLoop tests | strongest |
| claude `c798f465…` | yes | same; adds `observeOnly` pre-init tick gate | helpful belt-and-suspenders; roster-aware `agentHoldId` | solid; thinner hold→continue matrix than codex |
| cursor `70a73f4c…` | yes | same core; `formatHoldRecovery` + waitSignature resource refresh | good wait reporting; weaker agent validation/tests | adequate for dirty + basic liveness only |

### Verdict

Prefer **codex `7ecd02f2b22225a22c0e63eca2d03acf71946f6b`**: it matches the selected plan end-to-end (liveness, scoped `--agent` with active-roster check, explicit `--run`, same-branch dirty preserve, branch-identity recheck, and the init-conflict / waiting tests). **claude `c798f46594cf1192311ce3de044f6b555c2768ee`** is a close second (roster-safe CLI, `observeOnly`); take its report/`--agent` roster alignment and consider keeping `observeOnly`. **cursor `70a73f4cdb8bd595898c16eda169869294921edb`** is functionally close on the happy path but should not win as written until `--agent` checks `activeRoster` and the init/hold-continue tests land.

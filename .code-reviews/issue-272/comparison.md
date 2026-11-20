# Implementation comparison — issue 272

## Comparison

Bound implementation pins compared:

- antigravity `db04b1f4c95aa9f5a269e040866909cb2de94fb1`
- claude `f7a4704f1e423ff2d2e4c304149e26407e90655a`
- codex `aa59721fdbc69d7be1be908188ee2d9b7fe836d0`

All three change exactly the nine approved product paths, against the selected codex plan.

**Method.** I read each exported worktree and diffed each changed file against the frozen baseline `f63828c1b459580c242974eb3ce496b18ff430f0`. I ran no product suites for this comparison. Where this document cites my own suite runs, they come from my implementation action. The findings below come from reading the code.

### Size and shape (lines added / removed versus baseline)

| Path | antigravity | claude | codex |
| --- | --- | --- | --- |
| verificationEnvironment (new) | 340 | 129 | 46 |
| verificationRunner | +294 / −16 | +143 / −20 | +76 / −23 |
| runLoop | +296 / −21 | +112 / −13 | +53 / −15 |
| state | +24 | +36 | +12 |
| hookPolicy | +23 / −31 | +19 / −12 | +13 / −9 |
| verificationReceipts | +4 / −2 | +7 / −2 | +1 / −1 |
| issueReport | +26 / −1 | +10 / −1 | +7 |
| test: runLoop | +237 | +130 | +84 |
| test: verificationRunner | +245 | +127 | +47 |

### Shared design

All three implementations take the same overall approach:

- **Product Node.** The resolver finds the product's Node in the checkout and puts it first on PATH for probes, commands and hook checks.
- **Receipts.** The receipt key moves to version 2, so pre-fix receipts never match.
- **Failure summary.** It shows a stream-tagged excerpt of up to 8 lines and about 2 KB, plus the full log.
- **Baseline run.** The failed command and the commands before it rerun at the frozen baseline. That run uses the candidate's environment, skips receipts and is journaled as `baseline-check`.
- **Missing executable.** A spawn ENOENT for the declared executable becomes comparable evidence.
- **Shared failure.** A shared failure is persisted as a record bound to:
  - the issue session, action, agent, submission, consensus and final pins;
  - the baseline;
  - the policy.

  The issue then pauses through `setPaused`, and `coord resume` re-verifies the recorded submission fresh before publication.
- **Correction.** A passing, differing or generic-only baseline sends the candidate for correction.

Codex is the most compact. Antigravity re-derives the most.

### Findings

**F1. codex — `src/runLoop.ts:2929` and antigravity — `src/runLoop.ts:2948`: checks added by this issue are compared with the baseline.**

- **Rule.** A check that this issue added through `checkProposal` does not exist at the frozen baseline, so the baseline cannot show that its failure is shared.
- **Failure.** Say the candidate proposes `{ name: "new", argv: ["pnpm", "run", "test:new"] }` but has a typo in the script name.
  - Both pins print `ERR_PNPM_NO_SCRIPT Missing script: test:new`. Codex's signature keyword `missing` (and antigravity's `missing` keyword) makes them match.
  - The issue pauses for the owner over an agent bug, instead of reissuing the action to the agent.
- **Test.** With an adopted amendment whose command fails identically at both pins, assert that `verifyFinalizationChecks` returns `rejected` and that no final-retry record exists.
- **Fix sketch.** Compare only when the failed command's name is in `selected.commands`. Claude does this at `src/runLoop.ts:2960`.

**F2. codex — `src/verificationRunner.ts:92`: indented lines enter the match signature.**

- **Rule.** The matching evidence must be stable across two executions of the same failure. Normalization may strip only presentation noise, and every other line must stay out of the comparison.
- **Failure.**
  - Every raw line that starts with whitespace or `+`/`-` goes into `details`, which feeds the signature. That includes test-runner progress such as ` ✓ test/a.test.ts (12 tests) 31ms`, and durations are not normalized.
  - This repository's own gate is the single command `pnpm run check`, which runs build, then the fast and system suites, then e2e. Its output always contains those lines before any e2e failure.
  - The candidate's lines differ from the baseline's, both in timings and because the issue adds tests.
  - Result: a tool missing only in the e2e step never matches. Acceptance case 3 then routes to the agent, who cannot fix it.
- **Test.** Both pins emit ` ✓ test/a.test.ts (3 tests) 12ms` (candidate) or ` ✓ test/a.test.ts (2 tests) 9ms` (baseline), then the same `sh: protoc: command not found`. Assert that the issue pauses.
- **Fix sketch.** Restrict the signature to specific diagnostic lines, and normalize durations and timestamps (as claude does at `src/verificationRunner.ts:130`).

**F3. antigravity — `src/verificationRunner.ts:476`: missing executables during candidate checks.**

- **Rule.** A coordinator launch fault during a candidate (R4/R6) check is not a rejected agent submission. The runner comment and docs/coord-driver.md both state this, and the plan keeps the coordinator error path for that case.
- **Failure.** `isMissingExecutable` has no phase guard. If an owner machine lacks `pnpm` while a candidate check runs, the candidate is rejected and reissued to the agent, repeatedly, and burns revision rounds. Claude and codex limit this to `finalization`.
- **Test.** Run `runVerification` with `phase: "candidate"` and argv `["coord-missing-tool"]` through `runArgv`. Assert that it rejects with `code: "ENOENT"`.

**F4. codex — `src/hookPolicy.ts:131`: `coord doctor` crashes on an unavailable pin.**

- **Rule.** `coord doctor` must report toolchain problems as findings rather than abort.
- **Failure.**
  - `unresolvableCommands` calls `verificationEnvironment(cwd)` without a guard. When the clone pins a Node that isn't installed, it throws `Project requires Node …`.
  - `checkDeclarations` in `src/doctor.ts` does not catch it, so doctor fails instead of listing the missing pin and executables.
  - Antigravity and claude fall back to the inherited PATH here, and let the hook report the pin.
- **Test.** In a clone with an `.nvmrc` naming an uninstalled version, assert that `unresolvableCommands` returns an array.

**F5. claude — `src/verificationRunner.ts:277`: unpinned products still key receipts on the coordinator's Node.**

- **Rule.** A receipt must name the runtime the check actually used.
- **Failure.** For a product without `.nvmrc`:
  - `node` stays the coordinator's `process.version`, and `toolchain` is null, while the children run whatever `node` comes first on PATH.
  - If the owner moves PATH from Node 20 to 22 and the coordinator's version is unchanged, the old success receipt hits and certifies a run made under 20.
  - Codex probes the inherited `node` for package.json products, and antigravity records `inherited:<version>:<path>`. Both close this.
- **Test.** For an unpinned fixture, run under two different PATH `node` stand-ins. Assert that the second run is not `reused`.
- **Fix sketch.** When no pin is found, set `toolchain` to the first PATH `node`, or probe its version.

**F6. antigravity — `src/runLoop.ts:3587` and `src/verificationEnvironment.ts:326`: duplication and scope.**

- **Rule.** Make the smallest change, and reuse the existing evaluation path.
- **Failure (duplicate retry path).**
  - The retry runs through a second, hand-copied pipeline: approved paths, then `buildOrder`, `evaluateEvidence`, `prepareCheckAmendment` and the finalization checks.
  - Any later fix to the normal completion path, such as a follow-up issue check or a new evidence rule, silently misses retried submissions.
  - Claude and codex substitute the recorded submission SHA into the existing completion read instead.
- **Failure (Node selection by package.json `engines`).** A semver range parser selects Node from package.json `engines` for unpinned products. A product whose PATH Node falls outside its declared range is silently switched to another installed Node, a change all three plan reviews rejected. The range parser is about 100 lines of new, untested surface.

### Within scope, reuse and tests

- **codex.** It is the smallest and closest to the plan:
  - It auto-retires stale retry records inside `mutateCursorsState`.
  - Its tick-level test uses a real signal commit and a real missing executable, and publishes exactly once.
  - Its toolchain test pins the running Node rather than a separate pinned binary, so it shows the prepend but not selection among installed versions.
- **claude.**
  - It excludes amendment-only checks from the baseline comparison and normalizes durations.
  - Its tests cover both phases plus hooks, a planted version-1 receipt, an unavailable pin, a missing executable, all four correction cases, and a restart with a replaced marker before publication.
  - Its tick test stubs mirror evidence reads instead of using a real signal commit.
- **antigravity.**
  - It is broadly correct and well tested, but carries the most new code: a 340-line resolver and a duplicated retry pipeline.
  - It has the candidate-phase behaviour change in F3.

### Ranking

1. **claude, `f7a4704f1e423ff2d2e4c304149e26407e90655a`.** No routing defect; F5 is a narrow receipt-identity gap for unpinned products.
2. **codex, `aa59721fdbc69d7be1be908188ee2d9b7fe836d0`.** Smallest, but F1 and F2 misroute shared and agent failures in realistic gates.
3. **antigravity, `db04b1f4c95aa9f5a269e040866909cb2de94fb1`.** F1, F3 and the F6 scope.

The best revision would combine:

- claude's routing (F1 exclusion and duration normalization);
- codex's inherited-runtime probe for receipts, which closes F5;
- codex's real signal-commit tick test.

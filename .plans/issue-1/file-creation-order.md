# Revised File Creation Order

Incorporates feedback from the issue-1 comment and `.plans/issue-1/planreview.md` (Claude, commit `910e268`).

## Already present

- `src/hash.ts`, `src/pinValidation.ts`, `src/finalization.ts` (byte-for-byte copies)
- `src/main.ts` (scaffold stub, to be replaced later)
- `test/hash.test.ts`, `test/tsconfig.json`

## Step 0 — Green baseline and tooling

Verify the seed compiles and configure the test/check infrastructure needed for incremental work.

0. **Green baseline** — `pnpm install --frozen-lockfile && pnpm check` must pass before any new file.
1. **`package.json`** — add `test:e2e` script (integration canary), confirm `check:fast`/`check` contracts match hook expectations.
2. **`vitest.config.ts`** — configure fast/e2e split so `test:fast` excludes `integration.test.ts` and `test:e2e` runs it.
3. **`tsconfig.json`** / typecheck script — add a second `tsc -p test/tsconfig.json` invocation to the `typecheck` script so test files are type-checked.
4. **Delete `test/stub.test.ts`** — replaced by real tests in the next step.

## Step 1 — Validate seed files

5. **`test/pinValidation.test.ts`** — adaptation of legacy tests for the already-present `src/pinValidation.ts`.
6. **`test/finalization.test.ts`** — adaptation of legacy tests for the already-present `src/finalization.ts`.

## Stage A — Verification core (effects injected, no tmux)

Each source file is paired with its test. Dependencies flow strictly downward.

7. **`src/paths.ts`** + **`test/paths.test.ts`** — runtime root resolution, containment checks, symlink rejection. No internal deps.
8. **`src/protocol.ts`** + **`test/protocol.test.ts`** — Zod schemas for published artifacts. Depends only on Zod.
9. **`src/steps.ts`** — internal step/gate/evidence IDs, profile definitions, step table, defaults (`maxRevisionRounds: 3`). Also exports shared observation/result types consumed by both `evidence.ts` and `machine.ts` (breaking the direct dependency between them).
10. **`src/state.ts`** + **`test/state.test.ts`** — Zod schemas + atomic I/O for `start.json`, `cursors.json`, `journal.jsonl`, pause state. Depends on `paths.ts`, `steps.ts`.
11. **`src/action.ts`** + **`test/action.test.ts`** — action rendering/parsing, `complete` file handling. Depends on `paths.ts`, `steps.ts` (not `state.ts` — keeps internal cursor state out of the agent-facing file).
12. **`src/mirror.ts`** + **`test/mirror.test.ts`** — bare-mirror setup, ref fetching, SHA reachability, blob reads. Depends on `paths.ts`.
13. **`src/evidence.ts`** + **`test/evidence.test.ts`** — `isSatisfied()` predicate registry. Depends on `protocol.ts`, `mirror.ts`, `steps.ts`, `action.ts`. Returns observation types from `steps.ts`.
14. **`src/machine.ts`** + **`test/machine.test.ts`** — pure state-machine reducer. Depends on `steps.ts`, `state.ts` only. Consumes observation types from `steps.ts`; does NOT import `evidence.ts` or `mirror.ts`.

## Stage A checkpoint

15. **`config.example.json`** — remove `defaultCoordRoot`, refine roster/clone-root/branch-template/PR-policy fields per adopted plan.

## Stage B — Effectful orchestration and CLI

16. **`src/tmux.ts`** + **`test/tmux.test.ts`** — session/window creation, launch scripts, liveness, nudge policy. Depends on `paths.ts`, `state.ts`.
17. **`src/runLoop.ts`** + **`test/runLoop.test.ts`** — polling orchestration loop. Calls `evaluateEvidence(...)` then feeds observation into `decide(...)`. Depends on `mirror.ts`, `evidence.ts`, `machine.ts`, `action.ts`, `state.ts`, `tmux.ts`.
18. **`src/cli.ts`** + **`test/cli.test.ts`** — command parsing, stdin/stdout. Depends on `state.ts`, `runLoop.ts`, `paths.ts`.
19. **`src/main.ts`** — replace scaffold stub. Depends on `cli.ts`.
20. **`coord` wrapper** — fix staleness: rebuild when `dist/main.js` is missing or older than newest `src/` file.
21. **`test/integration.test.ts`** — four-agent canary, wired to `test:e2e`.

## Documentation (order flexible)

22. **`docs/coord-driver.md`** — expanded operator documentation.
23. **`README.md`** — expanded quick start with CLI and runtime-root contract.

## Key architectural corrections from review

- **`machine.ts` does not import `evidence.ts`.** The run loop is the bridge: it calls `evaluateEvidence()`, gets an observation, and passes it to `decide()`. Shared result/observation types live in `steps.ts`.
- **`action.ts` depends on `paths.ts`/`steps.ts`, not `state.ts`.** This enforces the separation that prevents internal cursor state from leaking into the agent-facing `action.md`.
- **Stage A is "verification core with injected effects," not "pure/no I/O."** `paths.ts`, `state.ts`, `action.ts`, and `mirror.ts` all perform I/O, but effects are injected and faked in tests. Only `steps.ts` and `machine.ts` are truly pure.

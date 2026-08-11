# Revised File Creation Order (v3)

Incorporates feedback from the issue-1 comment, `.plans/issue-1/planreview.md`
(Claude, commit `910e268`), and follow-up review identifying the pre-push
deadlock, wrapper ordering, paths.test.ts divergence, and steps.ts coverage gap.

## Already present

- `src/hash.ts`, `src/pinValidation.ts`, `src/finalization.ts` (byte-for-byte copies)
- `src/main.ts` (scaffold stub, to be replaced later)
- `test/hash.test.ts`, `test/tsconfig.json`

## Step 0 — Green baseline and tooling

Verify the seed compiles and lints, configure test/check infrastructure, and fix
the `coord` wrapper staleness bug. Step 0 does NOT validate the seed's untested
files (`pinValidation.ts`, `finalization.ts`) — that happens at steps 5–6.

0. **Green baseline** — `nvm use 26 && pnpm install --frozen-lockfile && pnpm check` must pass before any new file. (Confirmed: exits 0 at `14d052a` with 2 files / 3 tests.)
1. **`package.json`** — add `test:e2e` script, confirm scripts satisfy:
   - `check:fast`: lint + source/test typecheck + fast tests.
   - `check`: build + `check:fast` + `test:e2e`.
   This ensures the pre-commit hook gates on lint/types/unit and the pre-push hook gates on the full suite including the integration canary.
2. **`vitest.config.ts`** — configure fast/e2e split so `test:fast` excludes `test/integration.test.ts` and `test:e2e` includes only it. Reconcile `vitest/globals`: either set `globals: true` in the vitest config or remove `"vitest/globals"` from `test/tsconfig.json` types (prefer the latter — explicit imports are clearer).
3. **`test/integration.test.ts`** — create as a **placeholder** (single skipped or trivially passing test). This prevents the pre-push deadlock: once `test:e2e` exists in `package.json`, the hook invokes it on every workflow-critical push. Without a matching test file, vitest exits non-zero and blocks all pushes from step 1 onward. The placeholder is filled in at step 21.
4. **`tsconfig.json`** / typecheck script — add a second `tsc -p test/tsconfig.json` invocation to the `typecheck` script so test files are type-checked.
5. **`coord` wrapper** — fix staleness: rebuild when `dist/main.js` is missing or older than the newest file under `src/`. Moved here from Stage B because `coord next` becomes usable at step 18, and the stale-dist bug surfaces inside agent panes far from the cause. The fix is a three-line shell change with no source dependencies.
6. **Delete `test/stub.test.ts`** — replaced by real tests in the next step.

## Step 1 — Validate seed files

7. **`test/pinValidation.test.ts`** — adaptation of legacy tests for the already-present `src/pinValidation.ts`.
8. **`test/finalization.test.ts`** — adaptation of legacy tests for the already-present `src/finalization.ts`.

## Stage A — Verification core (effects injected, no tmux)

Each source file is paired with its test. Dependencies flow strictly downward.
Effects in `paths.ts`, `state.ts`, `action.ts`, and `mirror.ts` are injected
boundaries faked in tests. Only `steps.ts` and `machine.ts` are truly pure.

9. **`src/paths.ts`** — runtime root resolution, containment checks, symlink rejection. No internal deps.
10. **`src/protocol.ts`** + **`test/protocol.test.ts`** — Zod schemas for published artifacts. Depends only on Zod.
11. **`src/steps.ts`** — internal step/gate/evidence IDs, profile definitions, step table, defaults (`maxRevisionRounds: 3`). Also exports shared observation/result types consumed by both `evidence.ts` and `machine.ts` (breaking the direct dependency between them). **Not paired with a dedicated test file** — this is deliberate and matches the adopted plan's exact file map. Coverage is provided by: `machine.test.ts` (profile denominators, four-agent ordering, observation types), `state.test.ts` (default revision limit of 3), and `evidence.test.ts` (step/gate/evidence ID usage).
12. **`src/state.ts`** + **`test/state.test.ts`** — Zod schemas + atomic I/O for `start.json`, `cursors.json`, `journal.jsonl`, pause state. Depends on `paths.ts`, `steps.ts`.
13. **`src/action.ts`** + **`test/action.test.ts`** — action rendering/parsing, `complete` file handling. Depends on `paths.ts`, `steps.ts` (not `state.ts` — keeps internal cursor state out of the agent-facing file).
14. **`src/mirror.ts`** + **`test/mirror.test.ts`** — bare-mirror setup, ref fetching, SHA reachability, blob reads. Depends on `paths.ts`. **Note:** `test/mirror.test.ts` also covers external-root refusal (the containment behavior from `paths.ts`), per the adopted plan's exact file map which assigns that coverage here rather than a separate `test/paths.test.ts`. No `test/paths.test.ts` is created — this is a deliberate alignment with the normative file map.
15. **`src/evidence.ts`** + **`test/evidence.test.ts`** — `isSatisfied()` predicate registry. Depends on `protocol.ts`, `mirror.ts`, `steps.ts`, `action.ts`. Returns observation types from `steps.ts`.
16. **`src/machine.ts`** + **`test/machine.test.ts`** — pure state-machine reducer. Depends on `steps.ts`, `state.ts` only. Consumes observation types from `steps.ts`; does NOT import `evidence.ts` or `mirror.ts`.

## Stage A checkpoint

17. **`config.example.json`** — remove `defaultCoordRoot`, refine roster/clone-root/branch-template/PR-policy fields per adopted plan.

## Stage B — Effectful orchestration and CLI

18. **`src/tmux.ts`** + **`test/tmux.test.ts`** — session/window creation, launch scripts, liveness, nudge policy. Depends on `paths.ts`, `state.ts`.
19. **`src/runLoop.ts`** + **`test/runLoop.test.ts`** — polling orchestration loop. Calls `evaluateEvidence(...)` then feeds observation into `decide(...)`. Depends on `mirror.ts`, `evidence.ts`, `machine.ts`, `action.ts`, `state.ts`, `tmux.ts`, **`finalization.ts`**. Covers R7 finalization: throwaway-worktree verification, explicit argv check commands, and PR-creation blocking on failed checks.
20. **`src/cli.ts`** + **`test/cli.test.ts`** — command parsing, stdin/stdout. Depends on `state.ts`, `runLoop.ts`, `paths.ts`.
21. **`src/main.ts`** — replace scaffold stub. Depends on `cli.ts`.
22. **`test/integration.test.ts`** — replace the step-3 placeholder with the full four-agent canary. Wired to `test:e2e`.

## Documentation (order flexible)

23. **`docs/coord-driver.md`** — expanded operator documentation.
24. **`README.md`** — expanded quick start with CLI and runtime-root contract.

## Key architectural decisions

- **`machine.ts` does not import `evidence.ts`.** The run loop is the bridge: it calls `evaluateEvidence()`, gets an observation, and passes it to `decide()`. Shared result/observation types live in `steps.ts`.
- **`action.ts` depends on `paths.ts`/`steps.ts`, not `state.ts`.** This enforces the separation that prevents internal cursor state from leaking into the agent-facing `action.md`.
- **No `test/paths.test.ts`.** The adopted plan's exact file map does not list it. External-root refusal coverage lives in `test/mirror.test.ts`.
- **`steps.ts` has no dedicated test file.** Its behavior is load-bearing but exercised transitively through `machine.test.ts`, `state.test.ts`, and `evidence.test.ts`.
- **Placeholder integration test at step 3.** Prevents the pre-push hook deadlock without `passWithNoTests: true` (which would silently green-light an empty e2e suite if the canary were ever deleted).
- **`runLoop.ts` owns the R7 finalization path.** It calls `finalization.ts` for cleanup verification, materializes the throwaway worktree, runs config argv checks, and blocks PR creation on failure.

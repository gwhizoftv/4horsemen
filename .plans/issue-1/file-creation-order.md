# File Creation Order

## Already present

- `src/hash.ts`, `src/pinValidation.ts`, `src/finalization.ts` (byte-for-byte copies)
- `src/main.ts` (scaffold stub, to be replaced later)
- `test/hash.test.ts`, `test/tsconfig.json`

## Stage A — Pure machine and verifiable core (no I/O, no tmux)

Create in dependency order (each file depends only on predecessors):

1. **`src/paths.ts`** — runtime root resolution, containment checks, symlink rejection. No internal deps.
2. **`src/protocol.ts`** — Zod schemas for published artifacts (join, plan, ballot, implementation, comparison, revision, consensus, finalization). Depends only on Zod.
3. **`src/steps.ts`** — internal step/gate/evidence IDs, profile definitions, step table, defaults (`maxRevisionRounds: 3`). No runtime deps.
4. **`src/state.ts`** — Zod schemas + atomic I/O for `start.json`, `cursors.json`, `journal.jsonl`, pause state. Depends on `paths.ts`, `steps.ts`.
5. **`src/action.ts`** — action rendering/parsing, `complete` file handling. Depends on `state.ts`, `steps.ts`.
6. **`src/mirror.ts`** — bare-mirror setup, ref fetching, SHA reachability, blob reads. Depends on `paths.ts`.
7. **`src/evidence.ts`** — `isSatisfied()` predicate registry. Depends on `protocol.ts`, `mirror.ts`, `steps.ts`, `action.ts`.
8. **`src/machine.ts`** — pure state-machine reducer. Depends on `steps.ts`, `state.ts`, `evidence.ts`.

Tests for Stage A (can be written alongside or immediately after each source file):

9. **`test/state.test.ts`**
10. **`test/action.test.ts`**
11. **`test/protocol.test.ts`**
12. **`test/mirror.test.ts`**
13. **`test/evidence.test.ts`**
14. **`test/machine.test.ts`**
15. **`test/pinValidation.test.ts`** (adaptation of legacy tests)
16. **`test/finalization.test.ts`** (adaptation of legacy tests)

## Stage B — Effectful orchestration and CLI

17. **`src/tmux.ts`** — session/window creation, launch scripts, liveness, nudge policy. Depends on `paths.ts`, `state.ts`.
18. **`src/runLoop.ts`** — polling orchestration loop. Depends on `mirror.ts`, `evidence.ts`, `machine.ts`, `action.ts`, `state.ts`, `tmux.ts`.
19. **`src/cli.ts`** — command parsing, stdin/stdout. Depends on `state.ts`, `runLoop.ts`, `paths.ts`.
20. **`src/main.ts`** — replace scaffold stub. Depends on `cli.ts`.

Tests for Stage B:

21. **`test/tmux.test.ts`**
22. **`test/runLoop.test.ts`**
23. **`test/cli.test.ts`**
24. **`test/integration.test.ts`**

## Stage B also includes non-code files (order flexible)

25. **`docs/coord-driver.md`** — expanded operator documentation
26. **`README.md`** — expanded quick start
27. **`config.example.json`** — refined example config

## Cleanup

28. Delete **`test/stub.test.ts`** once real tests exist.

## Rationale

The order ensures each file can be typechecked and tested as soon as it is written, with no forward references. Stage A is entirely pure/testable without tmux or real agent harnesses. Stage B layers effectful code on top of the proven core.

# Code review — `issue-1/codex`

**Reviewer:** Cursor  
**Target:** `origin/issue-1/codex` @ `04445b4`  
**Compared to:** merge-base with `main` (`14d052a`)  
**Authority:** `.plans/issue-1/plan.md`, `.plans/issue-1/workflow-algorithm.md`

## Findings

### [P1] Stop wiping peer acceptances on drop — `src/cli.ts:112`

`coord drop` calls `resetUnresolvedActions`, which deletes **every** acceptance for the current step and clears all active agents’ actions. After three agents have already accepted `R2.plan` and the owner drops the stuck fourth, the gate should complete with denominator 3; instead the three good plans are discarded and must be republished. That contradicts drop semantics (“rederive unresolved/future actions,” keep completed peer evidence) and diverges from the integration path that only uses `dropAgent`.

### [P1] Honor reviser-authorization’s reviser when routing later steps — `src/evidence.ts:264`

`reviser-authorized` evidence checks the implementation pin but never validates or returns `parsed.value.reviser`, and `accept` never writes `cursors.reviser` (it stays `originalRoster[0]` from `src/state.ts:280`). `R6.revise` / `R6.declare` / `R7.finalize` therefore always stay on the first roster agent even when authorization names someone else, so reviser routing from comparison is a no-op.

### [P2] Move PR creation out of verification side effects — `src/runLoop.ts:472`

Under `coord-open-unmerged`, `verifyFinalizationChecks` publishes a branch and opens a draft PR while still building the observation, before `accept-submission`. If that tick does not accept (pause/abandon early-return in `decide`, crash after publish), origin can already have an unmerged PR/branch while R7 is not accepted. Failed checks correctly block PR creation; publication should follow acceptance (or at least a durable “finalization succeeded” state transition).

### [P2] Reject launchers that resolve outside the agent clone — `src/tmux.ts:48`

`resolve(agent.root, agent.launcher)` is only checked for executability. A config value like `../../elsewhere/evil.sh` escapes the clone and is still passed to tmux `new-window`. Containment is enforced for `--coord-root` and runtime paths; launcher resolution should get the same “must stay under agent.root” rule.

### [P2] Do not hard-code `.plans/issue-1/plan.md` into the automation digest — `src/cli.ts:166`

`coord start` hashes `config` plus a fixed path `.plans/issue-1/plan.md` regardless of the issue argument. Starting any other issue either fails if that file is absent or silently binds the wrong plan bytes into `automationDigest` / join validation. Digest material must be derived from the issue being started (or from config-declared paths), not from a literal issue-1 path.

### [P2] Keep `coord` rebuild output off stdout — `coord:4`

When `dist/main.js` is missing or stale, the wrapper runs `pnpm build` with default stdio before `exec node dist/main.js`. Build logs therefore interleave with `coord next` stdout. Pull-mode agents that treat stdout as the action body can receive a polluted document. Redirect build output to stderr so command stdout stays protocol-clean.

### [P2] Give the e2e canary its own timeout budget — `vitest.config.ts:6`

`test:e2e` is `vitest run test/integration.test.ts` and still loads this config’s `testTimeout: 15_000`. The four-agent temporary-origin canary performs many sequential git clone/commit/push/tick cycles; 15s is tight on slower disks and will surface as intermittent pre-push failures rather than product defects. Use a dedicated e2e config (or a higher timeout for that file).

### [P3] Exclude the integration canary from the default `test` script — `package.json` (`"test"`)

`"test": "vitest run"` includes `test/integration.test.ts` because `vitest.config.ts` has no exclude. `check:fast` correctly uses `test:fast --exclude ...`, and `check` adds `test:e2e`, so hooks are fine—but a plain `pnpm test` conflates the fast and e2e tiers.

## Overall assessment

Solid Stage B driver: pure `machine.ts` (no evidence/I/O), opaque UUID actions without step/gate/evidence IDs in `action.md`, required `--coord-root` with overlap checks, `defaultCoordRoot` removed, SHA reachability before blob reads, revision capped at 3, final-agent drop refused, `coord` rebuilds on stale `dist`, and `check` / `test:fast` / `test:e2e` split correctly. Main gaps are drop/reviser routing correctness, PR side effects during verify, and a few operational hygiene items.

## Material test gaps

- No test that `coord drop` keeps already-accepted peers at the current gate and only reissues affected actions.
- No test that `cursors.reviser` updates from reviser-authorization and that R6/R7 orders go to that agent.
- No test that a failed configured final check blocks PR creation (`prPolicy: coord-open-unmerged`).
- Little coverage for pause/abandon interacting with in-flight finalization verification.
- No start/digest test proving issue `N` hashes the correct plan material rather than a hard-coded issue-1 file.
- No wrapper/CLI test that a stale-dist rebuild cannot prepend build logs to `coord next` stdout.

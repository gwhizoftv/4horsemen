# Code review — `issue-1/codex`

**Reviewer:** Cursor  
**Target:** `origin/issue-1/codex` @ `04445b4`  
**Compared to:** merge-base with `main` (`14d052a`)  
**Authority:** `.plans/issue-1/plan.md`, `.plans/issue-1/workflow-algorithm.md`

## Findings

### [P2] Do not hard-code `.plans/issue-1/plan.md` into the automation digest — `src/cli.ts:166`

`coord start` hashes `config` plus a fixed path `.plans/issue-1/plan.md` regardless of the issue argument. Starting any other issue either fails if that file is absent or silently binds the wrong plan bytes into `automationDigest` / join validation. Digest material must be derived from the issue being started (or from config-declared paths), not from a literal issue-1 path.

### [P2] Keep `coord` rebuild output off stdout — `coord:4`

When `dist/main.js` is missing or stale, the wrapper runs `pnpm build` with default stdio before `exec node dist/main.js`. Build logs therefore interleave with `coord next` stdout. Pull-mode agents that treat stdout as the action body can receive a polluted document. Redirect build output to stderr (as the Claude branch does) so command stdout stays protocol-clean.

### [P2] Give the e2e canary its own timeout budget — `vitest.config.ts:6`

`test:e2e` is `vitest run test/integration.test.ts` and still loads this config’s `testTimeout: 15_000`. The four-agent temporary-origin canary performs many sequential git clone/commit/push/tick cycles; 15s is tight on slower disks and will surface as intermittent pre-push failures rather than product defects. Use a dedicated e2e config (or a higher timeout for that file) similar to the Claude branch’s 120s e2e tier.

### [P3] Exclude the integration canary from the default `test` script — `package.json` (`"test"`)

`"test": "vitest run"` includes `test/integration.test.ts` because `vitest.config.ts` has no exclude. `check:fast` correctly uses `test:fast --exclude ...`, and `check` adds `test:e2e`, so hooks are fine—but a plain `pnpm test` conflates the fast and e2e tiers and makes local “unit” runs pay for the canary. Align `test` with `test:fast`, or document that `test` means full suite.

## Overall assessment

This is a coherent end-to-end driver: safe coord-root resolution, opaque UUID action IDs, no step/gate/evidence leakage in `action.md`, pure `decide` without evidence/mirror imports, reachability-checked submissions, pin≠signal checks, drop-final-agent refusal with input rederivation, R7 cleanup verification plus throwaway-worktree checks that block PR creation, and a real four-agent integration canary. The revision-limit path is implemented in the machine. Remaining issues are operational correctness around digest identity, CLI stdout hygiene, and e2e timing—not core protocol shape.

## Material test gaps

- No start/digest test proving issue `N` hashes `.plans/issue-N/...` (or equivalent) rather than a hard-coded issue-1 file.
- No wrapper/CLI test that a stale-dist rebuild cannot prepend build logs to `coord next` stdout.
- No explicit stress/timeout coverage ensuring the canary stays under the configured e2e budget on cold caches.
- Drop + mid-gate rederive is exercised in the canary; a focused unit test that a dropped agent’s historical accepted pin never reappears in later `deriveBoundInputs` would still help lock the plan rule.

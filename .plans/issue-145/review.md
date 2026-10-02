# Issue 145 — plan review

Reviewed bound plans:

- cursor `098cb8181ef8221e2ace0a2df106f54a3ef0c874`
- codex `efc8ad44d8672911a5d7e4313d74d10aea96ac05`
- claude `4415a10d356c858b27a9c911b771de8b2b1944a9`

Authority: GitHub issue #145 (git-shim `COORD_GIT_DELEGATE` leak into
`check:fast`, vitest false exit 1 on reporting timeout, installer tests writing
real Antigravity home). Protocol version 1.

## Findings

1. **cursor `098cb818` — Exact File List / `src/hookPolicy.ts`.** The plan
   scrubs `COORD_GIT_DELEGATE` from the default `inheritRunner` spawn so
   pre-commit verify cannot poison the suite. Issue #145 (and both peer plans)
   treat the three defects as test-harness problems; product hooks intentionally
   export the delegate so nested `git` during an allowed commit still works
   (`scripts/lib/launcher.sh` re-entrancy guard). Changing `hookPolicy.ts`
   alters every managed product's verify spawn env. A declared check that
   shells out to `git` against the agent clone during the hook would then hit
   the shim block list and fail closed for a reason unrelated to the product
   under test. Smallest correction: leave `src/hookPolicy.ts` alone; strip the
   ambient guard only in the shim suite's `runGit` base env (claude
   `4415a10d` `shimEnv`, codex `efc8ad44` empty override).

2. **cursor `098cb818` — Exact File List / `vitest.config.ts` single-fork.**
   The plan prefers `pool: "forks"` with `singleFork: true` (or equivalent) as
   the primary reporting-timeout fix. Claude `4415a10d` measured the false exit
   as `Timeout calling "onTaskUpdate"` after long synchronous files
   (`install.test.ts` ~63 s) starve the worker past vitest's ~60 s birpc
   timeout, and showed that single-fork only sometimes keeps that file under
   60 s — it fails again once one sync-heavy file alone exceeds the RPC window.
   Following cursor as written ships a timing-dependent pool pin that does not
   address event-loop starvation. Smallest correction: adopt a
   `setupFiles` macrotask yield (`beforeEach` + `setImmediate`) as in claude
   `4415a10d`; do not rely on single-fork or owner `VITEST_*` env as the fix.

3. **cursor `098cb818` — Exact File List / optional `installOnce` home.** The
   antigravity section allows "optionally default `installOnce` to a
   fixture-local home" while naming two call sites that omit `home` today.
   An implementer who only patches one call site, or who skips the default,
   still leaves `install()` falling through to `homedir()` and writing
   `~/.gemini/antigravity-cli/` under a sandbox denial. Smallest correction:
   make the fixture-home default on `installOnce` / `uninstallOnce` mandatory
   (before `...overrides`), as both codex `efc8ad44` and claude `4415a10d` do.

4. **codex `efc8ad44` — Exact File List / `test/agentHookSync.test.ts`.** The
   plan adds atomic receiver publication and `finally` settlement for a
   Claude status-line fixture race observed during planning (empty `received`
   file). Issue #145's three symptoms do not name that race; claude
   `4415a10d` reproduced the hook failures as shim leak + `onTaskUpdate` +
   Antigravity home without needing that edit. Expanding into status-line
   fixture churn can land unrelated behavior and obscure whether the three
   issue defects are fixed. Smallest correction: defer the agentHookSync
   change unless `pnpm check:fast` still fails that case after the three
   primary fixes; if retained, keep it as a separate, evidence-bound edit
   that does not block the shim/home/yield work.

5. **codex `efc8ad44` — Exact File List / `fileParallelism: false` plus
   `afterEach` yield.** The plan serializes the fast suite and registers an
   `afterEach` `setImmediate` yield. Claude `4415a10d` showed the decisive
   A/B was a global `beforeEach` yield alone (3/3 fail → 3/3 pass) and
   rejected serialization as a root-cause fix because one sync file can still
   exceed 60 s. Checking in `fileParallelism: false` permanently slows
   `check:fast` without proving necessity once the yield exists. Smallest
   correction: keep the validated `beforeEach` setup file; add file
   serialization only if a post-yield run still exits 1 with a captured
   diagnostic.

6. **Reuse / new files (all three).** Claude `4415a10d` and codex
   `efc8ad44` justify one new `test/support/*` setup module for vitest
   `setupFiles` and reuse `installOnce` / `runGit` / fixture `home`. Cursor
   `098cb818` correctly avoids a new production module but its optional
   `test/hookPolicy.test.ts` path exists only to cover the production scrub
   in finding 1 — drop that file with the scrub. No plan proposes a version
   bump or product `githooks/` edit; that is correct.

## Conclusion

All three plans correctly identify the same three issue #145 defects, keep
ordinary commits free of a version bump, and aim at focused installer/shim
coverage plus `pnpm check:fast`.

**claude `4415a10d` is the plan to implement.** It alone pairs measured
evidence (shim failure under `COORD_GIT_DELEGATE=1`, `onTaskUpdate` after
~63 s sync files, Antigravity writes under scratch `HOME`) with the smallest
test-only fix set: hermetic `runGit` env, fixture-default `home` on
`installOnce`/`uninstallOnce`, and a `setupFiles` `beforeEach` macrotask
yield. It correctly rejects production `hookPolicy` scrubbing and single-fork
as the timeout fix.

**codex `efc8ad44`** matches on test-boundary shim/home isolation and also
keeps production launcher policy intact, but findings 4–5 (agentHookSync
scope and unvalidated serialization/`afterEach`) should be dropped or
deferred before implementation.

**cursor `098cb818`** correctly frames the three defects and the `runGit`
hermeticity idea, but findings 1–3 are ship-blocking if followed as written
(production verify scrub, single-fork as primary timeout fix, optional home
default). Do not implement that plan without those corrections; prefer
claude `4415a10d` as the base.

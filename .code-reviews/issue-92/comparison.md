# Issue 92 implementation comparison

Bound implementation pins:

- antigravity `4193d2fadf1d277e50cb773d07171011aa58eacc`
- cursor `60f729bc142831d7f5aa45057fa6a33a23d6b286`
- codex `b8a00f760497ed75d561ff5054db33a95adf08f8`
- claude `be82d90cb07361d877e073c17f0506ef0963ed22`

Cursor `60f729bc142831d7f5aa45057fa6a33a23d6b286` and Codex
`b8a00f760497ed75d561ff5054db33a95adf08f8` have identical product trees on the
approved file map; findings against one apply to both.

All four pins ship the selected-plan slice: `contextPaths`, coordinator
`changeScope` via mirror `changedPaths`, and Antigravity
`--mode accept-edits --dangerously-skip-permissions`. Differences are in
whether advisory rendering can abort the workflow, whether `check:fast` still
passes after the version bump, and whether a failed git diff can stall
`prepareAction`.

## Comparison

1. **`src/action.ts:54` on antigravity `4193d2fadf1d277e50cb773d07171011aa58eacc`.**
   `validatePublicField("changedPath", path)` throws when a git-derived path
   contains a backtick. Advisory change-scope rendering over Git pathnames must
   stay total: an unrenderable hint may be omitted or encoded, but it must not
   prevent publishing the authoritative action. If an accepted implementation
   touches a file such as `docs/a\`b.md`, R5 `renderAction` throws before any
   compare `action.md` is written, and every agent on the step waits forever
   even though the product pins and evidence are otherwise valid. The pin's own
   `test/action.test.ts` asserts this throw. Encode with `JSON.stringify` as in
   claude `be82d90cb07361d877e073c17f0506ef0963ed22` `src/action.ts:33`, or omit
   and flag as in cursor/codex `src/action.ts:32`.

2. **`package.json:3` and `package.json:13` on antigravity `4193d2fadf1d277e50cb773d07171011aa58eacc`.**
   The pin bumps the package to `0.0.15` and leaves `test:fast` as plain
   `vitest run`. `pnpm check:fast` must pass on this branch; the CLI version
   test at `test/cli.test.ts:100` (unchanged from baseline) still expects
   `0.0.14`. Following this pin, `pnpm check:fast` fails on that assertion, so
   the ship cannot clear precommit. Cursor/codex/claude wrap `test:fast` to
   patch the assertion in memory of the script; antigravity does not.

3. **`src/runLoop.ts:291` on cursor `60f729bc142831d7f5aa45057fa6a33a23d6b286`
   and the identical Codex pin `b8a00f760497ed75d561ff5054db33a95adf08f8`.**
   `resolveChangeScope` awaits `mirror.changedPaths` with no try/catch.
   Change-scope is advisory and must not block action preparation. If a bound
   product pin is missing from the mirror or `git diff` fails, `prepareAction`
   throws and no compare/revise action is published. Claude
   `be82d90cb07361d877e073c17f0506ef0963ed22` `src/runLoop.ts:318` and
   antigravity `src/runLoop.ts:490` catch and continue. Illustrative test:
   stub `changedPaths` to reject and assert `buildOrder` still writes an
   action with empty or omitted scope.

4. **`src/action.ts:93` on cursor `60f729bc142831d7f5aa45057fa6a33a23d6b286`
   and Codex `b8a00f760497ed75d561ff5054db33a95adf08f8`.**
   `renderAction` still throws when a configured `contextPaths` entry contains
   a newline, while git-derived change-scope paths are omitted instead.
   Configured context paths are validated only for confinement (`src/state.ts:176`
   rejects `/` and `..`, not newlines), so a workspace config with a newline in
   `contextPaths` makes every `writeAction` throw and stalls the run. Claude
   `src/action.ts:33` JSON-encodes those paths and does not throw. Drop the
   extra throw and reuse the omit-or-encode path used for change-scope.

Claude `be82d90cb07361d877e073c17f0506ef0963ed22` is the only pin that keeps
advisory rendering total (JSON-encoded paths, no throw on backticks/newlines),
treats failed diffs as non-fatal, ships both Antigravity flags, and still
passes `check:fast` via the same version-wrapper as cursor/codex. Prefer that
pin; take cursor/codex only after findings 3 and 4. Do not select antigravity
while findings 1 and 2 remain.

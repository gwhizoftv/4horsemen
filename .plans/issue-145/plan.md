# Issue 145: Make check:fast hermetic under the git shim and installer fixtures

## Problem

`pnpm check:fast` (declared `verify.precommit`) fails during agent commits for
three independent, already-diagnosed causes:

1. **Git-shim env leak.** The PATH shim's `delegate()` runs
   `exec env COORD_GIT_DELEGATE=1 "$REAL_GIT" "$@"`. Real git inherits that
   variable into commit hooks, so `coord hook-verify` → `pnpm check:fast` →
   vitest inherits `COORD_GIT_DELEGATE=1`. The generated-shim suite in
   `test/install.test.ts` spreads `process.env` into `runGit`, so asserted
   refusals (`git status` / blocked pinned `git show` → exit 2) short-circuit
   to exit 0. Committing via `/usr/bin/git` only works around this; the suite
   must stay green when agents commit through the shim.

2. **Vitest reporting-timeout flake.** Suites can finish with every test
   green and still exit 1 on a reporter/teardown timeout under parallel forks.
   Single-fork was already tried while the shim leak was still present; after
   (1) is fixed, pin a stable pool so a green suite cannot fail the hook on
   reporting alone.

3. **Real Antigravity home writes.** Installer tests that include `antigravity`
   without an isolated `home` call `syncAntigravityStatusLine` with
   `homedir()`, which writes under `~/.gemini/antigravity-cli/`. Sandboxed
   runs correctly deny that. Two call sites already omit `home`; the harness
   argv test already shows the correct isolation pattern.

Keep the change inside these three defects. No version bump; no product
`githooks/` edits as a way to satisfy checks.

## Exact File List to be changed or deleted

- `src/hookPolicy.ts` — scrub `COORD_GIT_DELEGATE` from the env used by the
  default `inheritRunner` when spawning declared verify commands, so
  pre-commit/`hook-verify` cannot poison the project's own suite
- `test/install.test.ts` — make `runGit` hermetic (omit ambient
  `COORD_GIT_DELEGATE` unless the case under test sets it); pass an isolated
  fixture `home` for every `installOnce` / `uninstallOnce` that includes
  `antigravity` (Terminal-profile four-agent install and the Antigravity
  launcher content test); optionally default `installOnce` to a fixture-local
  home so future antigravity installs cannot regress
- `vitest.config.ts` — stabilize the fast suite pool/teardown so an
  all-passing run cannot exit 1 on a reporting timeout (prefer
  `pool: "forks"` with `singleFork: true`, or equivalent documented vitest 3
  options; raise `teardownTimeout` only if still required after single-fork)

## Exact file list to be created

- `.plans/issue-145/plan.md` — this plan

## Reuse and Scope

Reuse, do not replace:

- `write_git_wrapper` / generated shim in `scripts/lib/launcher.sh` — keep the
  `COORD_GIT_DELEGATE` re-entrancy guard for hooks that call git during
  commit/push; do not redesign the block list
- `runVerifyPhase` / `inheritRunner` in `src/hookPolicy.ts` — extend the
  existing spawn path rather than adding a second verify runner
- `installOnce` / `product()` / `runGit` in `test/install.test.ts` — same
  helpers the failing cases already use
- `syncAntigravityStatusLine` in `src/agentHookSync.ts` — unchanged behavior
  for real installs; only fixtures stop pointing `home` at the operator
- Existing isolated-home pattern at the harness-argv and Claude status-line
  cases in `test/install.test.ts` and `test/onboard.test.ts`

No new modules, no new dependencies, no new test files. Every path intended
for change is listed above; citing a helper here does not expand edit scope.

## Tests

Fewest focused cases, all in existing files:

1. **`test/install.test.ts` (generated git shim)** — extend `runGit` so an
   ambient `COORD_GIT_DELEGATE=1` in `process.env` does not defeat refusal
   assertions; keep the two cases that *explicitly* pass
   `{ COORD_GIT_DELEGATE: "1" }` and still expect exit 0. Optional one-liner:
   with `process.env.COORD_GIT_DELEGATE = "1"` set for the duration of one
   refusal case, assert exit 2 still (fails before the hermetic scrub, passes
   after).

2. **`test/install.test.ts` (antigravity home)** — the four-agent Terminal
   profile install and the Antigravity launcher install must pass a fixture
   `home`; after install, assert
   `~/.gemini/antigravity-cli/` was not created or mutated by the test (or
   assert the managed settings/wrapper land only under the fixture home).
   Fails today under a sandbox that denies the real home; passes after.

3. **`test/hookPolicy.test.ts` or existing verify coverage in
   `test/verify-config.test.ts` / `test/agentLanguage.test.ts`** — if a runner
   env assertion already exists, extend it; otherwise add one small case that
   the default verify spawn receives an env without `COORD_GIT_DELEGATE`
   (inject a fake runner or spy). Prefer extending `test/verify-config.test.ts`
   over a new file.

4. **Validation commands** — `pnpm check:fast` (lint, typecheck, fast tests;
   live `verify.precommit`). After the change, also confirm a commit that
   touches a product path still succeeds when invoked through the clone's
   PATH shim (not only `/usr/bin/git`), so the leak cannot return unnoticed.

No e2e unless a vitest config change forces a config-file regression check;
`pnpm check` remains the coordinator's full gate on the approved commit.

## Alternatives Rejected

- **Keep committing via `/usr/bin/git` only** — sidesteps the leak for one
  operator habit; every agent that commits through the launcher PATH still
  fails the hook. Not a product fix.
- **Remove `COORD_GIT_DELEGATE` from the shim entirely** — breaks the
  documented reason hooks can call `git rev-parse` during an allowed commit;
  the guard must stay for nested git, and only leave the verify/test boundary.
- **Blanket `maxWorkers: 1` without fixing the leak** — already tried;
  masksthe env bug and slows every green run without restoring refusal
  assertions.
- **Skip or delete the two git-shim refusal tests** — would hide the leak and
  let agents' check:fast lie about containment.
- **Change `syncAntigravityStatusLine` to no-op under `VITEST`** — hides
  missing fixture homes and would skip coverage of the real install path;
  isolate `home` in fixtures instead (same pattern as Claude status-line).
- **Version bump / `package.json` for this issue** — ordinary issue-branch
  work; the `0.0.N` advance is CI-on-merge, not part of this plan.

## Risks and Mitigations

- **Scrubbing `COORD_GIT_DELEGATE` in verify spawns** — hooks that the *check
  command itself* runs may call `git` through the shim without the delegate
  flag. Mitigation: the shim still allows fixture repos and non-clone targets;
  only this-clone `status`/`diff`/closed `show` are refused, which product
  checks must not need (launcher comments already state the fast suite shells
  out against fixtures). If a declared check legitimately needs this-clone
  status, that is a separate product bug.
- **Single-fork slows `test:fast`** — acceptable trade for hook reliability;
  prefer the smallest vitest option that stops false exit 1, measure locally,
  avoid stacking unrelated pool knobs.
- **Defaulting `installOnce` home** — could surprise a future test that wanted
  the real home. Mitigation: document the default in the helper; tests that
  need a specific home already pass one (Claude status-line, harness argv).
- **Ambient `COORD_ISSUE` in agent shells** — already overridden to `"42"` in
  `runGit`; out of scope beyond not making it worse.

## Conclusion

Fix the three concrete reasons agent `check:fast` fails: stop
`COORD_GIT_DELEGATE` from poisoning verify and the shim suite, pin vitest so a
green run cannot die on reporting timeout, and keep Antigravity installer tests
inside an isolated fixture home. Smallest change set, existing helpers only,
validated with `pnpm check:fast` and a shim-path commit that still passes
hooks.

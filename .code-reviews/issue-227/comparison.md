# Issue 227 implementation comparison — claude

Bound implementation pins compared:

| Agent | Pin | Worktree |
| --- | --- | --- |
| claude | `b24676e48af4a45793ca01b54ae14f997ccafc0d` | `worktrees/claude-b24676e4` |
| cursor | `90c618789a3d941d48a492c9f98f7ae3b0fee039` | `worktrees/cursor-90c61878` |
| codex | `af2cadc0edfabad30ff2fb0e6d21576daa763ab0` | `worktrees/codex-af2cadc0` |

I read each pin's changed files directly from its worktree and compared them with plain `diff` against `b24676e4`. No product suite was run for this comparison. The verification I cite for my own pin is the hook output from its commit:

- `check:fast`: lint, typecheck, `test:fast`, and `test:system` (224 passed).
- The pre-push e2e run.

## Comparison

All three implement the selected plan's design. Each touches the same 17 product and test files, all within the approved map, and adds the two justified new files (`src/githubAuth.ts`, `test/githubAuth.test.ts`). The shared design:

- Config `github.account`, frozen into `start.json`.
- The token is read with `gh auth token --hostname github.com --user <login>`, with ambient token variables stripped.
- A gh/git-only runner wrapper is used for the issue snapshot, follow-up lookup, PR calls and start `ls-remote`. Product checks keep the unwrapped runner in all three.
- One-shot `-c` reset and helper arguments are passed for the mirror and for clone creation.
- A clone-local `coord.githubAccount` key plus a reset/helper pair are written into each agent clone.
- The launcher resolves `GH_TOKEN` at launch time.
- `coord auth status|login|git-credential` are added.
- `https://login@github.com/...` origins are accepted.
- Without a selection, behaviour is unchanged.

None adds a dependency or touches unrelated code. They differ in correctness at the edges, and in how much end-to-end coverage they add.

### Findings: cursor (`90c618789a3d941d48a492c9f98f7ae3b0fee039`)

**C1. Install never reaches a no-op once an account is selected.**

- **Location:** `src/setupWorkspace.ts:435` and `:453`.
- **Rule:** `coord install` is idempotent. "makes no changes on a second run" is an existing guarantee, and `--dry-run` must report only pending work.
- **Failure:**
  - `localCredentialHelpers` drops empty lines (`.filter((line) => line !== "")`), so the leading reset value `""` is never returned.
  - `expected` always starts with `""`, so the length check at `:453` never matches.
  - Every reinstall or re-onboard of a selected workspace therefore unsets and re-adds the helper.
  - It reports `configure github.com credential helper …` as a change, and `--dry-run` never comes back empty.
- **Test:** `installOnce(fixture, { origin, githubAccount: "acct" }); expect(installOnce(fixture, { origin, dryRun: true }).changes).toEqual([]);` fails at this pin.

**C2. Wiping an issue silently skips the selected repository's remote branches.**

- **Location:** `src/wipeIssue.ts:88` and `:111`.
- **Rule:** every remote operation for a selected workspace uses that account. The plan lists wipe's git and gh paths.
- **Failure:**
  - `pushCwd` is the owner's product checkout, which has no coord helper.
  - `listOriginIssueBranches` (`git ls-remote`) and `git push --delete` run with the owner's ambient credentials. Only the gh fallback gets `ghEnv`.
  - Suppose the ambient account A cannot read workspace B's private repository. Then `ls-remote` fails, the function returns `[]`, and wipe logs `remote issue-N/* already absent`.
  - It deletes nothing on origin and still reports success.
- **Fix sketch:** pass `gitCredentialArgs(account, cliEntry)` into the ls-remote and push calls, as the claude and codex pins do.

**C3. "Sign in with another account" during onboarding leaves gh's active account switched.**

- **Location:** `src/cli.ts:541` (`resolveOnboardGitHubAccount`).
- **Rule:** the plan and the issue keep the owner's other projects unaffected. Coord may change gh's active account only transiently, and must restore it.
- **Failure:**
  - The onboarding path runs `gh auth login` and returns the new login, but never runs `gh auth switch --user <previous>`. Only `auth login` at `:1476`/`:1490` restores.
  - After onboarding workspace B this way, every unselected project and the owner's shell act as B.
- **Test:** inject a login stub that flips `active`, then assert a `gh auth switch … --user <previous>` call. The pin has no such test, because the default `choose` is null under Vitest.

**C4. `coord auth login` (and the onboarding sign-in) fails when the owner's shell exports `GH_TOKEN`.**

- **Location:** `src/cli.ts:1458` and `:541`.
- **Rule:** every lookup or login path strips ambient tokens. The pin's own `stripAmbientGitHubTokens` exists for exactly this.
- **Failure:** `spawnSync("gh", ["auth", "login", …], { stdio: "inherit" })` inherits `GH_TOKEN`. gh refuses to store credentials while `GH_TOKEN` is set, so `coord auth login` exits 1, and the documented renewal path is unusable from such a shell.
- **Fix sketch:** pass `env: stripAmbientGitHubTokens()`.

**C5. Network failures are reported as authentication failures.**

- **Location:** `src/githubAuth.ts:130`.
- **Rule:** the actionable `Run: coord auth login` message is for missing, expired or revoked credentials. Transport failures must stay distinguishable.
- **Failure:** during a DNS outage, `gh api user` exits non-zero without "401". `verifyGitHubAccess` throws `GitHub authentication for acct is unavailable.\nRun: coord auth login`, and start/resume tell the owner to re-authenticate a valid credential.

**C6. The install test reaches github.com and the real `gh`, and cannot see the reset value.**

- **Location:** `test/install.test.ts:1153`.
- **Rule:** unit and system tests do not depend on the network or the owner's real credentials. The test must assert the security-relevant helper order: reset first, then helper.
- **Failure:**
  - The second, non-dry-run `installOnce` with an `https://…github.com` origin runs the sync fetch against github.com.
  - On GitHub's 401, git invokes the coord helper, which runs the developer's real `gh auth token --user acct`.
  - The helper assertion filters out blank lines, so a missing or misplaced reset would still pass.

**C7. An inherited `GITHUB_TOKEN` is left in the agent's environment (low).**

- **Location:** `scripts/lib/launcher.sh:443`.
- **Rule:** the agent terminal must not carry another account's token.
- **Failure:** the launcher exports `GH_TOKEN` but leaves an inherited `GITHUB_TOKEN`. gh prefers `GH_TOKEN`, but other tools in the harness, and scripts the agent runs, still see the other account's `GITHUB_TOKEN`.

### Findings: codex (`af2cadc0edfabad30ff2fb0e6d21576daa763ab0`)

**X1. Any sync fetch failure now aborts install and is labelled an authentication failure.**

- **Location:** `src/setupWorkspace.ts:538`.
- **Rule:** syncing an existing clone is best effort ("could not fetch …; leaving it as is"), and auth wording is reserved for auth failures.
- **Failure:**
  - With an account selected, any failed `git fetch` throws: a DNS blip, a 5xx, or a clone whose remote is temporarily unreachable.
  - The thrown message comes from `explainGitHubAuthFailure`, which defaults to `… is unavailable.\nRun: coord auth login` (`src/githubAuth.ts:30-35`).
  - Re-onboarding while offline stops at the first clone with misleading advice, where the baseline would have continued and wired every clone.
- **Test:** stub the remote to fail with "Could not resolve host", then expect install to succeed and log `could not fetch`.

**X2. Every agent launch and restart depends on two live GitHub API calls.**

- **Location:** `scripts/lib/launcher.sh:363` and `src/cli.ts:1216`.
- **Rule:** a launch fails closed on a missing or invalid credential, and transport failures do not masquerade as auth failures.
- **Failure:**
  - `auth launch-token` runs the full `verifyGitHubAccess` (`gh api user` and `gh api repos/…`) before printing the token.
  - During a GitHub API outage or secondary rate limit, a tmux respawn or `coord attach` leaves the pane dead, with `Run: coord auth login` (same default mapping as X1).
  - The validation does catch a revoked token at launch, which the claude and cursor launchers do not. That trade-off should be kept only together with an outage-tolerant error mapping.

**X3. `githubAuth.ts` imports `agentHookSync.ts`, which creates an import cycle (low).**

- **Location:** `src/githubAuth.ts:3`, and `src/state.ts:276` and `:441`.
- **Rule:** the new module should not create import cycles that force workarounds in core schemas.
- **Failure:** `githubAuth → agentHookSync → state → githubAuth` forced `z.lazy(() => githubLoginSchema)` in both the config and start-state schemas. Any future top-level use of the login schema in `state.ts` hits a TDZ error. A local quoting helper (claude and cursor) avoids the cycle.

**Codex strengths:**

- `test/install.test.ts` runs a real `git credential fill` against a competing helper, executes the generated launcher with a fake `gh` (valid, missing and expired), and uses `url.insteadOf` so no network is touched.
- It checks idempotence and preservation of foreign helpers across uninstall.
- `coord manual` and `restoreTerminals` also verify the account, and the SSH refusal happens before any runtime directory is created.

### Findings: claude (`b24676e48af4a45793ca01b54ae14f997ccafc0d`, own pin)

**K1. Wipe's ref pruning fetches without the account (low).**

- **Location:** `src/wipeIssue.ts:178`.
- **Rule:** wipe's remote git calls use the selected account.
- **Failure:** `pruneIssueRefs` runs `git fetch --prune origin` in the product checkout and in the mirror with ambient credentials. The listing and deletion calls are bound; this one is not. On a private repository readable only by B, the fetch fails and is logged, then local `update-ref -d` still removes the issue refs. The effect is a spurious "could not fetch --prune" line, not a missed deletion. Codex threads `authArgs` here.

**K2. The SSH refusal fires after the runtime directory is created (low).**

- **Location:** `src/install.ts:369`, after `resolveSafeCoordRoot({ create: true })` at `:329` and the mailbox claim.
- **Rule:** an install refused before any clone or runtime effect leaves nothing behind.
- **Failure:** `coord install --github-account acct` with an SSH origin creates the runtime directory and the mailbox claim, then throws. No clone is created; that is what the test asserts. Codex checks before the runtime is created.

**K3. The launcher is tested only as rendered text.**

- **Location:** `test/install.test.ts` (the account case).
- **Rule:** the fail-closed launch path should be executed, not only grepped.
- **Failure:** a regression in the launcher's `set -u` or quoting logic would pass the text assertions. The real-git helper ordering was checked by hand during development, but the suite does not execute it. Codex's executed-launcher and `git credential fill` test covers this.

### Scope, reuse, focus

- **Scope:** all three stay within issue 227 and the approved file map, add no dependency, and avoid unrelated refactors.
  - cursor reads `coord.cliEntry` from each clone on every `CoordinatorRunLoop` construction, even without an account. That adds git spawns, but is harmless.
  - codex duplicates account verification in both the CLI and `initializeEffects`/`restoreTerminals`.
- **Reuse:** all three reuse `ProcessRunner`, `BareMirror`, `ensureAgentClone`, `configureCloneIdentity`, `write_launcher` and the existing CLI/install fixtures.
- **Tests:** all add focused cases to the existing `githubIssue`, `mirror`, `cli`, `install` and `runLoop` suites, plus `githubAuth.test.ts`.
  - codex's install case is the broadest but still targeted.
  - cursor's has the hygiene problems in C6.

### Overall

- **claude:** the fewest behavioural regressions. Only low-severity gaps (K1–K3), and baseline behaviour is preserved on transport failures.
- **codex:** equivalent core and the strongest end-to-end tests. Its new fail-hard paths (X1, X2) turn transient network failures into aborted installs and dead agent panes with misleading auth advice.
- **cursor:** the right structure, but real defects:
  - C1 breaks install idempotence.
  - C2 silently skips remote deletion.
  - C3 leaves the active account switched.
  - C4 blocks login from a shell that exports `GH_TOKEN`.

Preference: claude, then codex, then cursor. Codex's executed launcher and credential test would be worth adopting into whichever pin is chosen.

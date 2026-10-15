# Issue 227 plan review — claude

Reviewed pins:

| Agent | Plan pin |
| --- | --- |
| cursor | `308cfa4b726a6e090a7ad075b9f46503e13dc775` |
| claude | `c63770ff1e4bac4c85709af0397b461298863bf4` |
| codex | `1970545aba74e31957b1d6575b94e931c96cd570` |

All three plans read the issue the same way:

- Store only the account name in workspace config.
- Read the token by that account name from gh's credential storage, without `gh auth switch`.
- Use `GH_TOKEN` for gh, a Git credential helper for Git, and a launch-time export for agent terminals.
- Fix the `https://user@github.com/...` origin parsing.
- Add `coord auth status` and `coord auth login`.

They differ in three places: how the Git helper is wired, how widely the token is applied, and how far scope reaches (bootstrap, a native keyring dependency, mandatory migration).

I checked each finding against the baseline code, citing the file and line.

## Findings

### F1 (cursor, blocking): unscoped, unreset `credential.helper` loses to the owner's global helper

1. **Plan claim.** cursor, Exact File List, `src/setupWorkspace.ts`: set each agent clone's local `credential.helper` to `!coord git-credential`. `src/mirror.ts`: give the mirror "the same `credential.helper`".
2. **Rule.** Git builds the helper list in config order: system, then global, then local. It asks each helper in turn and stops at the first one that returns a username and password. A workspace helper must therefore come after an empty-string reset of the list, scoped to `https://github.com`. Otherwise an inherited helper (macOS `osxkeychain`, or a global `gh auth setup-git` entry) answers first with another account's credential.
3. **Failure.** The owner's `~/.gitconfig` has `credential.helper=osxkeychain`, holding a `gwhizoftv` token for github.com. The workspace selects `gwhizofss`.
   - An agent runs `git push origin issue-N/claude`.
   - Git asks `osxkeychain` first. It returns gwhizoftv's token, and Git never runs `coord git-credential`.
   - The push authenticates as gwhizoftv. It either succeeds under the wrong identity or gets a 403 on a gwhizofss-only repository. This is the silent fallback to another account that the issue forbids.
   - The coordinator mirror's `fetchBranch` and `publishBranch` (`src/mirror.ts:117,189`) behave the same way.
4. **Additional gap.** The helper command names no account. The plan doesn't say how `coord git-credential` running inside the bare mirror (`--git-dir`, no clone-local `coord.*` keys) finds which account to answer for.
5. **Smallest correction.** Write two values under `credential.https://github.com.helper`: first `""`, then a helper that carries an explicit `--account <login>` and an absolute CLI entry. On a lookup failure, emit `quit=1`. The claude and codex plans both do this.

### F2 (cursor, blocking): applying the binding to the run loop's default `processRunner` leaks the token into product checks

1. **Plan claim.** cursor, `src/runLoop.ts`: "when constructing default `processRunner` / Git env for the live loop, apply the workspace GitHub binding". `src/cli.ts`: "Merge auth env into the process runner used for `git`/`gh` at start".
2. **Rule.** The token may only reach the gh/git calls coord makes on GitHub's behalf. `this.processRunner` (`src/runLoop.ts:1093`) is also the runner that executes the product's declared verification commands: `runVerification({ ..., processRunner: this.processRunner })` at `src/runLoop.ts:2842`, which calls `input.processRunner(argv, target)` at `src/verificationRunner.ts:242`.
3. **Failure.** In coordinator verification mode, the coordinator runs `pnpm check` at an agent-authored pin with `GH_TOKEN=<gwhizofss token>` in its environment.
   - Any test or script an agent committed can read the token and send it elsewhere, or call `gh` as the owner.
   - Product test suites that shell out to `git` against fixture repositories also start running with credential config they never asked for.
4. **Smallest correction.** Leave `processRunner` unwrapped. Use a separately wrapped runner only for issue snapshot, follow-up lookup, PR list/create/ready/merge and the start `ls-remote`. The wrapper changes only argv whose first element is `gh` or `git`.

### F3 (cursor, high): Git over SSH silently keeps another identity

1. **Plan claim.** cursor, Risks, "SSH remotes": "account binding still governs `gh`; Git SSH continues to use the user's SSH agent".
2. **Rule.** The issue requires coord to "fail clearly if authentication is unavailable, instead of falling back to another account". The same selected account must apply to both git and gh.
3. **Failure.** A workspace with origin `git@github.com:o/r.git` selects gwhizofss, and ssh-agent holds gwhizoftv's key.
   - Agents push branches as gwhizoftv.
   - The coordinator opens the PR as gwhizofss.
   - Neither step reports anything. Two concurrent workspaces are not independent for Git, which is the scenario the issue exists for.
4. **Smallest correction.** Refuse the combination of an SSH origin and a selected account at onboard/install, with a message telling the owner to use an https origin (claude's plan). Codex's per-origin `insteadOf` rewrite is the alternative.

### F4 (cursor, medium): the plan leaves it open whether existing workspaces fail on upgrade

1. **Plan claim.** cursor, Risks: "Existing workspaces lack `github.account`: start/doctor fail with remediation…".
2. **Rule.** An upgrade must not break a workspace that is running correctly today, unless the plan says so and lists every fixture and test it will update.
3. **Failure.** As written, `coord start` refuses every existing workspace until it is re-onboarded, and the plan doesn't list those consequences.
   - Every `test/cli.test.ts` and `test/onboard.test.ts` start fixture without `github.account` would fail. Those fixtures use local/fake origins, for example `example/fixture` in `test/cli.test.ts:185`.
   - The Tests section doesn't mention updating those fixtures.
4. **Smallest correction.** Treat a missing `github.account` as today's behaviour (ambient credentials), and enforce the binding only when an account is selected. Alternatively, keep the refusal but scope it to GitHub origins and list the fixture updates.

### F5 (cursor, low): file map isn't exact

1. **Plan claim.** cursor, Exact File List:
   - "`config.product.example.json` — same optional field if product declares overlap; otherwise leave untouched".
   - "`test/mirror.test.ts` or focused env unit coverage via the new auth test file".
   - `src/doctor.ts` "failed token resolution".
2. **Rule.** The file map must say exactly which files will change. `coord doctor` checks installation only (AGENTS.md, "Doctor checks installation only"). It runs after every onboard (`src/install.ts:882`) and must not depend on network access.
3. **Failure.**
   - Conditional entries let the implementation change either file or neither without an amendment, so reviewers can't check scope.
   - Token resolution and `gh api user` inside doctor make `coord onboard`'s exit code depend on network and keychain state.
   - When that check fails, `recordOwnerWorkspace` is skipped (`src/install.ts:884`). An offline onboard would then leave the product unregistered.
4. **Smallest correction.** Name each file unconditionally. Keep token and network checks in `coord auth status` and the start/resume preflight.

### F6 (codex, blocking): a second, coord-owned keychain store that takes precedence goes stale relative to gh

1. **Plan claim.** codex, "Credential resolution and safe replacement":
   - "An existing coord OS-store entry wins; otherwise read the named GH credential".
   - "An invalid existing coord entry fails; it does not authorize a fallback".
   - It adds `@napi-rs/keyring`.
2. **Rule.**
   - One source of truth for a given account's token. The issue says "Keep the token in Keychain or gh's credential storage".
   - A credential the owner refreshes through the documented gh path must take effect.
3. **Failure.**
   - The owner once ran `coord auth login` for gwhizofss, which created a coord keychain entry. Later the PAT expires.
   - The owner re-authenticates with `gh auth login` (or gh refreshes its OAuth token). gh's store is now valid.
   - coord still reads the expired coord entry first and, by design, refuses to fall back. Every operation for gwhizofss fails until the owner discovers the second store.
   - This is the "hunting through Keychain" the issue wants to avoid.
4. **Packaging failure.** It also adds a native dependency for every install, including workspaces that never select an account. If no prebuilt binary exists for Node 26 on the owner's platform, `pnpm install` / bootstrap fails and coord can't be used at all.
5. **Smallest correction.** Drop the coord store and the dependency. Resolve only through `gh auth token --hostname github.com --user <login>`, and implement `coord auth login` with gh's own login. Restoring the previously active gh account is acceptable, and so is `gh auth login --with-token` for a pasted PAT.

### F7 (codex, high): mandatory selection plus refusal of legacy start state strands issues in flight

1. **Plan claim.** codex:
   - "an unselected GitHub workspace must choose an account via onboarding or `coord auth login --account`".
   - "Legacy start files without the field require an explicit current selection".
   - "A changed account during a bound active issue fails".
2. **Rule.** Upgrading coord must not leave an issue that is already running unresumable, and must not stop unattended operation, unless the plan provides a migration that keeps it running.
3. **Failure.**
   - Issue N was started before the upgrade, so its `start.json` has no account.
   - After the upgrade, `coord N` refuses because no current selection exists.
   - The owner runs `coord auth login --account gwhizofss`, which writes `github.account` into config. `start.json` still has no frozen account. The plan neither defines whether that counts as "a changed account during a bound active issue" nor offers a way to bind the legacy issue.
   - Non-TTY onboard/install without `--github-account` now fails for every GitHub workspace, which breaks scripted reinstalls (`coord install` in CI or docs).
4. **Smallest correction.** Treat a missing selection as today's ambient behaviour. Enforce the binding only for workspaces and issues that carry an account.

### F8 (codex, medium): scope goes beyond the issue in ways that add risk without being asked for

1. **Plan claim.** codex adds:
   - A private-source `scripts/bootstrap.sh` flow with a POSIX helper.
   - A `.coord/bin/gh` wrapper.
   - `coord auth exec`.
   - Per-origin `insteadOf` URL rewriting.
   - Helper wiring in the owner's product worktree.
   - `useHttpPath`.
   - Recorded prior and installed local values with restore-on-uninstall.
   - Changes to `test/integration.test.ts` and `test/support/workspaceFixture.ts`.
2. **Rule.** AGENTS.md "Implementation discipline": make the smallest change that fully solves the issue, justify every new abstraction, and avoid speculative flexibility. The issue names the agent clones, the mirror, gh commands, agent terminals, and clone/fetch during onboarding. It also says personal projects "would remain unaffected".
3. **Failure.**
   - Writing a coord helper into the owner's own product checkout changes how the owner's manual `git push` authenticates in a repository they didn't ask coord to manage.
   - After `coord uninstall` with a moved install root, the leftover helper path emits `quit` and blocks the owner's pushes. The plan's restore-only-still-owned logic is extra state needed only because it wrote there.
   - The bootstrap helper is a second, shell implementation of the credential protocol that must stay consistent with the TypeScript one.
4. **Smallest correction.**
   - Limit Git wiring to agent clones (local config) and coordinator-side Git (`-c` arguments).
   - Export `GH_TOKEN` from the launcher instead of a gh wrapper.
   - Leave bootstrap and the owner worktree unchanged, or split them into a follow-up issue.

### F9 (codex, medium): the test plan isn't focused

1. **Plan claim.** codex, Tests:
   - Extend the e2e `test/integration.test.ts` for interleaved A/B workspaces "through start/resume/publication".
   - Run "all four harness argv/grants".
   - Extend the bootstrap fake-bin fixture.
   - Change `test/support/workspaceFixture.ts`.
2. **Rule.** The action requires "the fewest focused tests that fail before the change and pass after it".
3. **Failure.** An e2e lifecycle run across two workspaces and four harnesses adds slow, broad coverage. The behaviour is already decided at three narrow seams: the runner wrapper, the helper output, and the clone-local config. A failure in the broad test can't be located from its assertion, and shared fixture changes ripple into unrelated suites.
4. **Smallest correction.** Unit-test the wrapper and helper. Use one `install.test.ts` case for the clone config, one `cli.test.ts` start/resume refusal, and one runLoop follow-up assertion.

### F10 (claude, own plan, high): `sameRemote` still refuses a clone whose origin differs only by URL userinfo

1. **Plan claim.** claude, File List: `githubRepositoryFromOrigin` gains userinfo support. `ensureAgentClone` only gains `gitAuthArgs`. `sameRemote` (`src/setupWorkspace.ts:414-417`) is unchanged.
2. **Rule.** The issue requires coord to "accept that form" (`https://gwhizofss@github.com/...`). Re-onboarding after the owner adds userinfo to the product origin must adopt the existing clones.
3. **Failure.**
   - Clones were created with `remote.origin.url=https://github.com/o/r.git`.
   - The owner changes the product origin to `https://gwhizofss@github.com/o/r.git` and re-runs `coord onboard`.
   - `install` reads the new origin (`src/install.ts:350`).
   - `ensureAgentClone` throws "`<clone>` is a clone of 'https://github.com/o/r.git', not of https://gwhizofss@github.com/o/r.git" (`src/setupWorkspace.ts:451-455`). Onboarding stops.
4. **Smallest correction.** Strip HTTPS userinfo in `sameRemote`, as cursor's plan specifies. Add one `install.test.ts` assertion.

### F11 (claude, own plan, low): `coord auth login` briefly changes the shared active gh account

1. **Plan claim.** claude, Scope limits and Risks: `coord auth login` runs `gh auth login --web`, then restores the previously active account with `gh auth switch`.
2. **Rule.** No coord operation should change state that other workspaces read, while they may be reading it.
3. **Failure.** While the owner completes the browser login, a concurrently running workspace with no selection runs ambient `gh pr create` as the newly logged-in account. Workspaces that do have a selection are unaffected, because they always pass `--user`.
4. **Smallest correction.** Keep the plan, and document that the window affects only unselected workspaces. Alternatively, offer `gh auth login --with-token` (stdin PAT) as the non-browser path. It also activates the account, so the restore is still needed.

### F12 (claude, own plan, low): bootstrap exclusion is an interpretation that should be called out

1. **Plan claim.** claude, Scope limits: `scripts/bootstrap.sh` is unchanged.
2. **Rule.** The issue says "This must cover coord installation and clone creation". That most directly means `coord install`/`coord onboard` and agent clone creation, both of which the plan covers.
3. **Failure.** If the owner meant a private coordinator fork cloned by bootstrap, that path still uses ambient Git credentials. The plan states this rather than hiding it, so the owner can decide.
4. **Correction.** None required beyond keeping the explicit statement. If the owner wants it, file a follow-up issue rather than adding a second credential-protocol implementation in shell (see F8).

### Scope, reuse, new files, focus

- **cursor**
  - Scope and reuse are reasonable, and the new file is justified.
  - F1–F3 are correctness defects in the core mechanism.
  - The tests are focused but don't check the helper ordering or the runner boundary (F1/F2).
- **codex**
  - Thorough on secret handling.
  - Exceeds scope through the native dependency, bootstrap, gh wrapper, `auth exec`, owner worktree wiring and URL rewriting (F6/F8).
  - Breaks upgrade continuity (F7), and its tests aren't focused (F9).
- **claude**
  - Smallest scope.
  - Reuses `ProcessRunner`, `BareMirror`, `ensureAgentClone`, `configureCloneIdentity` and `write_launcher`, and justifies both new files.
  - Its tests target the three seams.
  - Needs the `sameRemote` correction (F10).

## Conclusion

The claude plan (`c63770ff1e4bac4c85709af0397b461298863bf4`) is the best basis for implementation, with one correction: F10, strip HTTPS userinfo in `sameRemote` and add one install assertion. F11 and F12 are disclosures, not blockers.

The cursor plan (`308cfa4b726a6e090a7ad075b9f46503e13dc775`) has blocking defects:

- An unreset, account-less `credential.helper` loses to inherited global helpers (F1).
- The token leaks into product verification commands through the shared `processRunner` (F2).
- An SSH origin silently keeps another Git identity (F3).

The codex plan (`1970545aba74e31957b1d6575b94e931c96cd570`) has blocking or high defects:

- A second coord-owned keychain store takes precedence over gh's and goes stale (F6).
- An unrequested native dependency comes with it (F6).
- Mandatory selection and refusal of legacy start state strand issues already in flight (F7).
- Its scope and tests go well beyond the issue (F8, F9).

# Issue 227 — plan review

Reviewed bound plans: cursor `308cfa4b726a6e090a7ad075b9f46503e13dc775`,
claude `c63770ff1e4bac4c85709af0397b461298863bf4`, codex
`1970545aba74e31957b1d6575b94e931c96cd570`.

## Findings

1. **Cursor Exact File List / Conclusion — “apply the same credentials
   everywhere” including GitHub issue/PR commands, while omitting
   `src/wipeIssue.ts`.**  
   **Rule:** every coordinator `gh` invocation for a workspace that selected an
   account must use that account’s credentials, with no ambient fallback.  
   **Failure:** `wipeIssue.ts` still `spawnSync("gh", …)` for the remote-ref
   DELETE fallback under the process environment; with two concurrent coords,
   wipe can authenticate as the other workspace’s active gh user and delete or
   fail against the wrong account.  
   **Correction:** bind wipe’s `gh api` path the same way Claude/Codex do
   (injected env or wrapped runner), and list `src/wipeIssue.ts` in the file map.

2. **Cursor `src/setupWorkspace.ts` / `src/githubAuth.ts` — set
   `credential.helper` to `!coord git-credential` without resetting inherited
   helpers.**  
   **Rule:** the selected account must win over global helpers (osxkeychain,
   `gh auth git-credential`); unattended git must not fall through to another
   account or a PAT prompt.  
   **Failure:** Git may still consult a global helper ahead of or beside the
   coord helper and authenticate as a different login, which is the concurrent-
   workspace bug the issue is solving.  
   **Correction:** use Claude’s pattern: empty
   `credential.https://github.com.helper` then the account-keyed helper, and
   `quit=1` on lookup failure.

3. **Cursor `src/githubAuth.ts` — resolve via `gh auth token --user` without
   stripping ambient `GH_TOKEN` / `GITHUB_TOKEN` from the lookup environment.**  
   **Rule:** resolve credentials for the configured login only; do not fall back
   to another account’s token.  
   **Failure:** an ambient `GH_TOKEN` can satisfy or shadow the named-user
   lookup so the workspace appears authenticated as the wrong user, or masks an
   expired per-account store entry.  
   **Correction:** strip those overrides for the token lookup (and launcher
   lookup), as Claude and Codex specify.

4. **Cursor Exact File List / Risks — resume loads `github.account` from live
   workspace config; no freeze into start state.**  
   **Rule:** an issue’s account binding must stay stable for resume/attach (or
   fail closed on mismatch); mid-issue rebinding must not silently switch
   identities.  
   **Failure:** editing or re-onboarding `github.account` while issue N runs
   makes the next resume use a different account against the same remote
   branches and PRs.  
   **Correction:** freeze nonsecret `githubAccount` in `start.json` and
   validate clones/config against it on resume (Claude/Codex).

5. **Claude Goal / Alternatives Rejected — “Workspaces with no
   `github.account` behave exactly as they do today and keep using ambient
   gh/git credentials”; mandatory selection rejected to avoid breaking
   upgrades.**  
   **Rule:** the issue requires selecting an account per workspace and failing
   clearly instead of falling back to another account when GitHub auth is
   needed for concurrent projects.  
   **Failure:** any two github.com workspaces that never set `github.account`
   still share the global active gh/git identity — the original race remains
   the supported default.  
   **Correction:** keep schema optional for non-GitHub/local origins, but
   require an explicit selection (prompt, `--github-account`, or
   `coord auth login`) before github.com remote effects at onboard/start;
   one-time migration, not permanent ambient mode for GitHub workspaces.

6. **Claude Reuse and Scope / Risks — `coord auth login` runs owner-attended
   `gh auth login` then restores the previous active account (the only
   intentional active-account mutation).**  
   **Rule:** do not implement account selection with `gh auth switch` (or
   equivalent shared active-account mutation) because concurrent projects
   conflict on that state.  
   **Failure:** during restore, a second concurrent coord or owner `gh`
   process can observe the temporary active account and operate as the wrong
   user.  
   **Correction:** prefer renewing/adding the named credential without relying
   on active-account switch for steady state; if a brief `gh auth login` is
   unavoidable for “Sign in with another account,” document that other coords
   must be paused, or write the token through a path that does not leave a
   durable active-account flip.

7. **Claude Exact File List — documents only `README.md`; does not list
   `docs/setup-workspace.md` or `config.example.json`.**  
   **Rule:** every path the implementation will change must appear in a file-
   list section; setup-workspace is the onboard guide and is on the declared
   documentation profile.  
   **Failure:** an implementer following only Claude’s map ships auth behavior
   while `docs/setup-workspace.md` still describes ambient-only gh usage,
   so operators miss account selection and `coord auth login`.  
   **Correction:** add `docs/setup-workspace.md` and `config.example.json` to
   the changed list (as Cursor/Codex do).

8. **Codex Credential resolution / Exact File List — add `@napi-rs/keyring`,
   `package.json`, and `pnpm-lock.yaml` for a coord-specific Keychain service
   beside gh’s store.**  
   **Rule:** justify every new dependency; prefer the smallest change; the
   issue allows keeping the token in Keychain **or** gh storage, and named
   `gh auth token --user` already reads gh’s store without a second writer.  
   **Failure:** native packaging against Node 26 can break install/CI; gh and
   coord stores can diverge after renewal so git and gh disagree on the token.  
   **Correction:** drop the native dependency and lockfile churn; resolve and
   renew through gh’s named-user store (Claude/Cursor), writing only
   `github.account` into workspace config.

9. **Codex Exact File List / Git boundaries — new untracked `.coord/bin/gh`
   wrapper, `coord auth exec`, and `scripts/bootstrap.sh` selected-account
   private clone.**  
   **Rule:** make the smallest change that fully solves the issue; justify
   every new abstraction and install artifact.  
   **Failure:** wrapper install/uninstall/recursion and bootstrap shell auth
   become new failure modes; bootstrap runs before a product workspace exists
   and is outside the “per workspace account” problem the issue states.  
   **Correction:** export `GH_TOKEN` from the existing launcher at launch time
   and use clone-local / `-c` git helpers (Claude); leave `scripts/bootstrap.sh`
   unchanged unless a later amendment proves private driver bootstrap is
   required.

10. **Codex Credential resolution — “Sign in with another account” is a
    masked PAT / `--with-token` flow; ordinary `gh auth login` is rejected.**  
    **Rule:** onboarding should let owners authenticate accounts the way they
    already do (gh/Keychain), then select the account name in the workspace.  
    **Failure:** owners who only use browser OAuth via `gh auth login` cannot
    add a second account through the planned UI without minting a PAT by hand.  
    **Correction:** keep owner-attended `gh auth login` (or equivalent) for
    adding accounts to gh’s store; use named-user token lookup for resolution;
    avoid `gh auth switch` for per-run selection.

**Reuse / scope / tests (cross-cutting):** All three stay inside issue 227’s
auth problem and justify `src/githubAuth.ts` + `test/githubAuth.test.ts`.
Claude has the strongest reuse story (`withGitHubAccount`, `-c` helpers that
survive `hermeticGitEnv`, start freeze, wipe/PR coverage, focused tests).
Cursor matches the issue shape but under-specifies helper precedence, lookup
isolation, start freeze, and wipe. Codex covers entry points thoroughly but
overshoots with a second secret store, gh wrapper, bootstrap, and broader
test/doc surface than needed.

## Conclusion

Prefer Claude’s plan (`c63770ff1e4bac4c85709af0397b461298863bf4`) as the
implementation base: it is the smallest complete design that threads one
account binding through install, mirror, start/resume/attach, agent
launchers, and `gh`/`git` without fighting hermetic scrubbing. Before
acceptance, require explicit GitHub account selection for github.com remotes
(finding 5), tighten login so shared active-account mutation is not the
steady-state mechanism (finding 6), and add the missing setup/config docs
(finding 7). Merge Cursor’s wipe and helper-reset gaps only if Claude’s map
is not chosen wholesale; do not adopt Codex’s keyring dependency, `.coord/bin/gh`
wrapper, or bootstrap expansion (findings 8–10).

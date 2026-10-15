## Comparison

Action `97eafa05-ef01-414a-b1de-ce69d3437489`, protocolVersion 1. Reviewed the exported source at all three bound implementation pins:

| Implementation | Bound product pin |
| --- | --- |
| Claude | `b24676e48af4a45793ca01b54ae14f997ccafc0d` |
| Cursor | `90c618789a3d941d48a492c9f98f7ae3b0fee039` |
| Codex | `af2cadc0edfabad30ff2fb0e6d21576daa763ab0` |

Recommend Codex as the revision base, with finding 1 fixed before acceptance. None of the three pins should be accepted unchanged. Codex covers more of the operational boundaries, including executable launcher validation, inherited account selection during repair, cleanup Git authentication, and active-roster resume. Claude checks clone helper presence more thoroughly, but loses unrelated helper configuration. Cursor has additional account-isolation gaps in URL parsing, onboarding, renewal, and cleanup.

### Findings

1. **Codex `src/githubAuth.ts:101`; Cursor `src/githubAuth.ts:154` — P1: validate the effective Git helper, not only the account label.** The selected account must govern both Git and gh when an issue starts or resumes. Both functions accept a clone solely because `coord.githubAccount` matches. Remove its URL-scoped helper while leaving that key, and validation passes; the launcher supplies the selected token to gh, while Git can use an inherited helper for another account. A focused probe against both exact source pins accepted this missing-helper state; Claude's `cloneGitHubWiringProblem` rejected it. Extend the existing auth/CLI tests with a matching label and absent or wrong-account helper, requiring refusal before terminal launch.

2. **Cursor `src/githubIssue.ts:107`, used by `src/githubAuth.ts:61` — P1: reject password-bearing origins for selected-account operation.** The configured account must override URL user information, and credentials must remain outside saved configuration. The optional `[^/@]+@` accepts `https://other:fake-token@github.com/acme/repo.git`. This passes selected-account origin validation, but Git already has a username and password and skips credential helpers, so clone/fetch/push can authenticate as the URL's account. The origin also retains the credential when saved. A local probe confirmed acceptance and showed `git credential fill` returning the URL credentials despite an intentionally failing helper. Add a negative parser/preflight case for userinfo containing a password. Claude and Codex reject this form.

3. **Cursor `src/wipeIssue.ts:89` and `src/wipeIssue.ts:111` — P1: scope cleanup's Git operations to the selected account.** Every coordinator remote operation, including branch discovery and deletion, must use the workspace's selected credentials. These calls still invoke plain `git ls-remote` and `git push`; only the gh fallback receives the scoped environment. From the product checkout, whose helpers intentionally remain unchanged, a personal account can therefore list/delete branches instead of the selected work account. If that account lacks access, listing returns an empty result and can leave remote branches behind. Test cleanup from a product checkout with conflicting ambient credentials and assert selected-account helper arguments on both calls. Claude and Codex thread those arguments through cleanup.

4. **Claude `src/setupWorkspace.ts:842` and `src/setupWorkspace.ts:849` — P2: preserve unrelated clone-local credential helper values.** Installation and uninstall may remove coord-owned wiring only. Installation unsets the entire URL-scoped helper list and writes just its reset/helper pair; uninstall unsets the whole list whenever any coord marker exists. A focused probe lost `cache --timeout=42` installed before coord, and separately lost `cache --timeout=99` added after coord during uninstall. Extend the installation lifecycle test to preserve foreign values and their reset/order semantics through configure, repair, and uninstall. Codex already covers preservation in its existing install fixture.

5. **Cursor `src/cli.ts:541` — P1: restore the prior shared gh account after onboarding's attended login.** Selecting a workspace account must leave unrelated workspaces' ambient account unchanged after the login completes. The onboarding “Sign in with another account” branch calls `gh auth login` and returns the added account without restoring `listing.active`. Starting with personal active and signing into work therefore leaves work globally active. An injected login test should assert the saved workspace selection is work and the final shared active account remains personal, including failures after login. Claude and Codex route this path through their restoration logic.

6. **Cursor `src/cli.ts:1458` (also `src/cli.ts:541`) — P2: clear inherited token variables for attended credential renewal.** `coord auth login` must be usable from a selected-account terminal and store a replacement in gh's credential storage. These `spawnSync` calls inherit `GH_TOKEN`, which Cursor's own launcher exports. The installed gh executable, invoked with a fake `GH_TOKEN`, exited 1 immediately and instructed the caller to clear the environment before storing credentials. Thus the advertised recovery command fails in that environment before login can start. Test login with all four ambient token variables set and require a scrubbed subprocess environment. Claude and Codex already scrub it.

7. **Claude `scripts/lib/launcher.sh:425`; Cursor `scripts/lib/launcher.sh:436` — P2: validate saved credentials on direct agent restart.** Issue #227 requires restart to load and validate the saved selection, with an actionable expired/revoked failure. These launchers check only whether `gh auth token` returns a nonempty saved value; retrieval does not validate that value with GitHub. Restart after revocation therefore launches an agent carrying the revoked token without the required preflight diagnosis. Extend the launcher fixture so token retrieval succeeds but `api user` returns 401, and require failure before the harness starts. Codex's `auth launch-token` path and executable install test cover this boundary.

8. **Claude `src/cli.ts:894`; Cursor `src/cli.ts:962` — P2: resume must validate the active roster.** A dropped agent must not remain a prerequisite for running the remaining issue participants. Both preflights validate every original `start.agents` entry. After dropping an agent and removing or repurposing its clone, resume/attach fails on that obsolete clone even though every active participant is correctly wired. Extend the existing resume test with a dropped, missing clone and valid active clones. Codex filters against `cursors.activeRoster` before checking wiring.

9. **Claude `src/cli.ts:1427` and `src/cli.ts:1374`; Cursor `src/cli.ts:1348` and `src/cli.ts:1294` — P2: preflight a saved account during installation repair.** Reinstallation without a new flag must retain and validate the saved selection before installation effects, just as an explicit selection does. These CLI paths preflight only a newly supplied/selected account; the installer subsequently recovers the saved account internally. Claude's onboarding checks the carried-forward selection only after `onboard` completes, and its install path omits that check; Cursor omits it in both cases. A repair can consequently mutate installation state or attempt authenticated clone/fetch before detecting revoked credentials; a repair that skips fetching need not detect them at all. Test an existing selected workspace with invalid credentials and no `--github-account`, requiring failure before install effects. Codex resolves the effective saved-or-explicit account before its CLI preflight.

### Scope, reuse, and coverage

All three stay within the same 17 approved product paths and add only `src/githubAuth.ts` and `test/githubAuth.test.ts`. Those new files have a clear purpose: centralizing named credential lookup, subprocess binding, verification, and credential-protocol coverage. None adds a dependency, changes bootstrap scripts, or modifies the product hooks to satisfy checks. The additional plan/signal paths listed by the action are coordination evidence.

All reuse the existing installer/clone helpers, `BareMirror`, state schemas, issue fetching, run loop, and existing CLI/install/mirror fixtures. Claude and Codex reuse `ProcessRunner`; Cursor declares a parallel `AuthProcessRunner` shape that adds little value. Claude and Cursor copy a small shell quoting helper to avoid a state import cycle; Codex reuses the existing helper and defers the account schema with `z.lazy`. These are bounded implementation choices, not unrelated refactors.

Claude's tests focus on token lookup, helper protocol, mirror binding, account persistence, start/resume, and follow-up issue verification. Cursor covers similar basic boundaries, but its installation test mainly inspects generated launcher text and its login paths have no corresponding attended-login coverage. Codex adds meaningful cases for simultaneous account isolation, token refresh, failed lookup redaction, actual Git credential resolution, launcher execution with valid/missing/revoked credentials, helper preservation, and login restoration/mismatch. It extends existing fixtures rather than creating another fixture layer. Its missing effective-helper check remains a real gap despite this broader coverage.

### Verification evidence

Read the coordinator's existing `issue-227/journal.jsonl` verification records. Successful hook `pnpm run check:fast` observations match the exact tree of each bound pin:

| Agent | Journal sequence | Verified index / bound tree |
| --- | --- | --- |
| Claude | 750 | `b3d35c8c0ea3ee0769e1ae39905edc0e172bae89` |
| Cursor | 805 | `52862c950ea8b143008ef178c61e19c65c3dff6a` |
| Codex | 824 | `6e0fa48e8ea59a95086ae3f74e6ddb23177a62d6` |

The journal also records passing `pnpm run test:e2e` push-hook observations at sequences 752 (Claude), 810 (Cursor), and 826 (Codex). These are explicitly advisory hook observations, not coordinator final-suite acceptance. Cursor's earlier failed check at sequence 726 belongs to a different index; sequence 805 records the successful bound tree.

For this comparison I ran only focused diagnostic checks: directly imported the exact exported TypeScript source through a temporary transpilation loader to exercise helper preservation, origin rejection, and clone-wiring validation against a temporary Git repository; used Git's real credential protocol with fake URL credentials; and confirmed the installed gh login command rejects an inherited fake `GH_TOKEN`. These reproduced findings 1, 2, 4, and 6 without contacting GitHub or changing the bound source. The other findings follow from the cited control flow and include targeted regression cases. No full product suite was rerun for this evidence-only action.

### Recommendation

Select Codex `af2cadc0edfabad30ff2fb0e6d21576daa763ab0` for revision, strengthen its effective clone credential validation with focused regression coverage, and then re-review the revised pin. Claude's helper-presence check is useful reference behavior, but its destructive helper rewriting should not be adopted. The unchanged Codex pin is not yet approved.

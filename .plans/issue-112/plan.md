# Issue 112: PR titles include the issue title; bodies close the issue

## Exact File Map

- `src/githubIssue.ts` — add `readGitHubIssueSnapshot` (load runtime `github-issue.json`) and `formatFinalizationPullRequest` (title + body with `Closes #N`)
- `src/runLoop.ts` — use those helpers in `publishAcceptedFinalization` instead of the hard-coded `Issue N: coordinated implementation` title/body
- `test/runLoop.test.ts` — seed `github-issue.json` in publication fixtures; assert opener receives title with issue title and body containing `Closes #1`
- `test/integration.test.ts` — seed `github-issue.json` in the four-agent canary; assert PR title/body
- `test/githubIssue.test.ts` — unit coverage for snapshot read + PR text formatting
- `package.json` — bump `0.0.20` → `0.0.21` for the PR version gate

## Tests

- `pnpm check:fast` (lint, typecheck, fast tests — live `verify.precommit`)
- `pnpm test:e2e` (pre-push when `package.json` changes)
- New/extended unit assertions on PR title/body; existing publication ticks keep passing

## Alternatives Rejected

- Re-fetching the issue via `gh` at publish time — start already snapshots title/body into `github-issue.json`; re-fetch can diverge from the digest-bound snapshot
- Putting only `Closes #N` in the title — GitHub auto-close needs the keyword in the PR body (or commit message); title is for humans
- Leaving “coordinated implementation” as a subtitle — issue asks for the issue title alongside the issue number

## Risks and Mitigations

- Missing or corrupt `github-issue.json` at publish — fail publication with a clear error (same as other pending-publication failures); every normal `coord start` writes the snapshot
- Very long GitHub titles — pass through unchanged; `gh pr create` already accepts long titles
- Existing open drafts from older coord builds — out of scope; only new publications get the new text

## Conclusion

At finalization publish, read the start-time issue snapshot and open the PR as `Issue N: <title>` with a body that includes `Closes #N` so merge auto-closes the GitHub issue.

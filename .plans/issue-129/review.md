# Plan review — issue 129

Reviewed the coordinator-exported plans at these exact pins:

- Cursor: `148a424e454e3c4de6a9fec7d809ad79d94f4e14` — `.plans/issue-129/plan.md`.
- Claude: `885c34bdc34d5f4b3b7e80570ac4008272584a58` — `.plans/issue-129/plan.md`.
- Codex: `5b801354c2cab2ea45a0bde2e773acbfba53f18b` — `.plans/issue-129/plan.md`.

## Findings

### Cursor — scope correction needed for the additional discovery guards

**Plan claim/section:** The file list changes both `isGitWorktree` and `wipeIssue.ts`'s `isGitRepo` to return false for non-directory paths, while Reuse and Scope excludes changing wipe semantics for valid onboarded products and Risks describes the change as only skipping a spawn.

**Rule:** A diagnostic-only change must not silently expand when destructive wipe effects proceed. Any intentional change to malformed configured-clone handling must be identified, justified, and covered, rather than presented as equivalent error-message handling.

**Concrete failure of that scope claim:** For an otherwise onboarded product whose configured agent-root path exists as a regular file, baseline `wipeIssue` throws during its initial clone-tip discovery (`src/wipeIssue.ts:238-242`, through `isGitRepo` at lines 58-59), before wiping runtime. With both proposed guards, that root instead becomes `skipped-missing` through `snapshotCloneReadiness` (`src/prepareAgentBranch.ts:293-310,474-483`). Wipe ignores that result (`src/wipeIssue.ts:267-278`) and, assuming the remaining operations succeed, reaches runtime/mailbox deletion at lines 426-445. Thus this is a change from refusal to destructive continuation, not just a clearer diagnostic. The proposed CLI test with a missing **product** path never reaches this path and cannot validate that change. This is a plan-scope finding, not a claim that an implementation has already caused data loss.

**Smallest correction:** Keep this issue's preflight at `resolveWorkspaceFromProduct` and omit the unrelated `isGitWorktree`/`isGitRepo` behavior changes. If the broader handling is intentional, explicitly justify that policy and add focused coverage of the actual configured-clone case before treating the plan as diagnostic-only.

### Claude — no blocking correctness findings

The plan places the check at the existing product-selection boundary, before `worktreeRoot`, and preserves the later Git/worktree/onboarding branches. `statSync` follows directory symlinks; treating missing paths separately from existing regular files addresses the observed ENOENT/ENOTDIR ambiguity without catching real Git-launch failures. The existing CLI calls this resolver before `wipeIssue` (`src/cli.ts:619-620,1351-1352`), so the placement is sufficient for the reported invocation.

Scope and reuse are strong: one source file and two existing test files, existing `makeProduct`, `writeConfig`, `recordOwnerWorkspace`, and `runCli` support, no new module, dependency, or product file. The two proposed tests directly exercise the regression and valid-directory-symlink compatibility. The plan names the required check commands and correctly leaves the version unchanged.

Non-blocking test advice: the reason offered for omitting a Git-absent test is inaccurate. `hermeticGitEnv` copies PATH unchanged (`src/mirror.ts:36-42`); a synchronous test can temporarily point the real process PATH at an empty fixture directory and restore it in `finally`. Adding that small assertion to the existing test would directly protect the owner-requested distinction. Leaving `git()` untouched nevertheless preserves that behavior in the proposed implementation, so this is not a demonstrated correctness defect. Similarly, comparing sentinel file bytes is stronger than comparing directory entries for the CLI non-mutation assertion and needs no new fixture family.

### Codex — no blocking correctness findings; broader than necessary

The shared `git`-boundary plan explicitly keeps path and executable errors distinct, preserves thrown failures and normal Git exit handling, retains hermetic execution, and forbids fallback cwd or repository repair. Unlike converting invalid configured clone roots to false, this keeps those launch/path failures fatal. Its tests cover both missing-path and missing-executable diagnostics, valid symlinks/subdirectories, and repository/runtime non-mutation.

The plan reuses existing source/test helpers and justifies its only potential private helper; it creates no product files or dependencies. However, adding a preflight and failed-spawn recheck to every synchronous Git call, changing genuine executable-launch diagnostics, adding documentation, and snapshotting full owner/agent repository state is more work than needed for the confirmed product-resolution defect. This is a scope preference, not an invented functional failure. Claude's narrower boundary change should be preferred rather than combining these approaches.

### Shared grounding and validation

All three plans correctly focus on the reproduced path diagnostic rather than assuming prior repository damage or automatically repairing a repository. I checked the baseline call chain and the issue's [owner-posted review](https://github.com/gwhizoftv/coordination/issues/129#issuecomment-5985165726): it distinguishes this invocation's pre-wipe failure from the broader, unproven historical claim and calls out non-directory paths, directory symlinks, real Git-launch failures, and non-mutation coverage. No proposed implementation was executed for this review; the conclusions above concern the pinned plans and current source.

## Conclusion

**Approve Claude's plan and prefer it for implementation.** It fixes the confirmed failure at the narrowest existing boundary with focused tests and no new abstractions. The suggested PATH and sentinel-byte assertions are small improvements within its existing file scope, not prerequisites for architectural approval.

**Request the scope correction above before selecting Cursor's plan.** Its extra false-return guards change malformed-clone wipe admission, which its stated scope and tests do not account for.

**Codex's plan is functionally acceptable but not preferred:** its shared Git-launch changes and larger verification fixture are unnecessary for the chosen narrow fix. Do not merge all three plans into a larger implementation.

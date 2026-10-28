# Plan review — issue 256

Reviewed the coordinator-exported plans at these exact pins:

- Muse: `46547e48ade505e871e4de91ceb06895151a4b1a`.
- Claude: `6630d4b4bd3ce2c16d578ee2a70bf356055d0637`.
- Codex: `0155280a858a776d3e8db3acc00c87f5bddcc6cc`.

The exported files match their manifest SHA-256 values. The review uses the issue requirements, the existing source/verification configurations, the coordinator's file-map extractor, and small isolated Git experiments. No product suite was run for this evidence-only action; these are plan findings, not claims about an implementation's test results.

## Findings

### 1. [P1] Muse — the pre-commit artifact requirement prevents creating the product pin

**Plan claim/section:** “Exact File List to be changed or deleted,” the `src/hookPolicy.ts` entry, requires pre-commit failure when the current action's required artifact is untracked or absent from the staged index, and pre-push failure when it is absent from the outgoing tree.

**Rule:** The guard must preserve the existing implementation/revision sequence: create a product commit, then publish the separate readiness signal that names that commit. `src/orderScaffold.ts:54` and `src/orderScaffold.ts:68` put `implementationCommitSha` and `revisedBranchHead` in those signals; the signal is not a prerequisite to creating its product pin.

**Concrete failure:** On a fresh `R4.implement` action, the agent stages approved product changes before the readiness signal exists. The planned pre-commit guard rejects that product commit, so the agent cannot obtain the SHA needed to write the signal. Creating a placeholder signal merely to unblock the hook violates the intended product/evidence separation. The analogous pre-push rule also blocks a legitimate product-only intermediate push.

**Smallest correction:** Apply the artifact publication check at pre-push, preserve the narrowly defined product-before-signal path for implementation/revision, and test that sequence as well as missing review/comparison artifacts.

### 2. [P1] Muse — using verification binding to skip the guard omits active local-mode issues

**Plan claim/section:** The `src/cli.ts` file-list entry says “Response-mode actions and unbound clones skip the guard”; “Reuse and Scope” uses `resolveHookBinding`/`HookBinding` as the shared binding machinery.

**Rule:** Required-artifact validation must apply to current Git actions in both local and coordinator verification modes. Verification-command ownership does not determine whether an automated action exists.

**Concrete failure:** `resolveHookBinding` returns `{ bound: false }` for every active local-mode run at `src/hookPolicy.ts:172-173`. Following the proposed skip condition allows an active local-mode review/comparison push with an untracked artifact to bypass the new guard entirely. Issue 256 itself currently uses local verification mode.

**Smallest correction:** Reuse/extract the clone/agent/active-action resolution separately from the coordinator-mode check, and exercise an active Git action in both modes.

### 3. [P1] Muse — status categories do not measure continued edits

**Plan claim/section:** The `src/runLoop.ts` file-list entry fingerprints index metadata plus `git status --porcelain`; “Risks and Mitigations” asserts that hashing that output makes content changes register even within one timestamp tick.

**Rule:** Continued file modification must reset the quiet window even when the same file was already modified or untracked at the preceding sample.

**Concrete failure:** Once `work.txt` is dirty, further edits can leave porcelain output at the identical ` M work.txt` record and leave the index metadata unchanged. With no hooks/transcript and a static pane, the proposed fingerprint therefore declares quiet while the agent keeps editing and spends its resend. An isolated repository with a non-racy committed baseline reproduced two different dirty contents, including a size change, with identical porcelain output and unchanged index mtime. Status categories contain no content/mtime evidence for the already-dirty file.

**Smallest correction:** Include file modification metadata for the observed paths and test a second edit to a file that is already dirty. Ensure the observer itself does not refresh the index and count that as agent activity.

### 4. [P1] Claude — warning-only publication does not supply the requested local error guard

**Plan claim/section:** The `src/cli.ts` entry and Tests case 2 explicitly keep push exit status successful when the artifact is missing or uncommitted; “Alternatives Rejected” rejects blocking any such push.

**Rule:** Issue 256 requires an immediate local error for an untracked/uncommitted required artifact. Valid intermediate product pushes need a specific exception; they do not justify permitting invalid review/comparison artifact publication.

**Concrete failure:** A review action has its required Markdown file untracked. The planned hook prints a warning but returns success, so `git push ... && write-complete` still writes a SHA whose tree lacks the review and causes the same mirror rejection/nudge cycle. The proposed test expressly accepts this result. The stated amendment rationale is also inaccurate: `src/orderScaffold.ts:175-178` publishes amendment requests at the **same required path**, so a committed request can pass a path-specific guard while unrelated product edits remain unstaged.

**Smallest correction:** Return a nonzero local error for invalid artifact publication while allowing the precise implementation/revision intermediate-product case. Test a real missing review artifact refusal and a valid amendment request.

### 5. [P1] Claude — partial or failed activity observation becomes positive quiet evidence

**Plan claim/section:** The `cloneActivityStamp` design sorts and caps paths at 256, returns a normal hash of that partial list, and returns the constant `"none"` on any error. The watchdog's quiet rule is unchanged.

**Rule:** A bounded observation may defer judgment, but must not establish that the whole relevant working tree is quiet when paths were omitted or inspection failed.

**Concrete failure:** Keep 257 dirty/untracked files present and continue editing only the last sorted path. The first 256 metadata records and index stay unchanged, so the next observation triggers a resend despite ongoing work. An isolated fixture reproduced an unchanged planned stamp after editing `file-256.txt`, which was outside the selected 256 paths. Likewise, repeated timeouts/stat errors yield identical `"none"` values and can satisfy quiet. With a timeout, the existing `runArgv` also retains only the last 32 KiB of stdout (`src/runLoop.ts:143-150`); treating that as a complete NUL-separated path list adds another partial-observation failure.

**Smallest correction:** Represent unavailable/incomplete observations separately and decline to declare quiet from them; detect path/output limits. Include a regression for activity beyond the observation limit and for repeated observation errors.

### 6. [P2] Claude — comparing only the working file and pushed blob misses staged changes

**Plan claim/section:** The `requiredArtifactWarning` design compares `hash-object` of the working file with the outgoing commit's blob and otherwise returns no diagnostic; it never inspects the required path's index entry.

**Rule:** The required artifact must not have uncommitted staged changes when reported as ready for Git publication.

**Concrete failure:** The outgoing commit contains artifact A; the agent stages artifact B, then restores the working file to A without changing the index. The proposed hash comparison reports equality and emits no warning even though B remains uncommitted. An isolated Git fixture confirmed working-tree hash equals pushed-tree hash while the staged blob differs. This can silently submit an older review after the edited review was staged but not committed.

**Smallest correction:** Inspect the exact path in the index as well as the outgoing tree and working copy; add this staged/working-copy divergence case to the hook regression.

### 7. [P2] Both peer plans — the focused command excludes the new hook test

**Plan claim/section:** Muse's Tests command uses `--config vitest.config.ts` while listing `test/cli.test.ts`. Claude's development command lists `test/hookSync.test.ts` without selecting the system configuration.

**Rule:** Named development checks must actually select the tests proposed to prove the new guard.

**Concrete failure:** The default/fast configuration explicitly excludes both files at `vitest.config.ts:9` and `vitest.config.ts:16`. Running either command can pass the action/run-loop tests while never exercising its new hook regression. Those files are selected by `vitest.system.config.ts`, not by the proposed command.

**Smallest correction:** Keep the fast command for action/run-loop tests and add the explicit system-config invocation for the corresponding existing hook/CLI test file. Do not substitute `check:docs`, which does not test this guard.

### 8. [P2] Both peer plans — the mechanically extracted scope exceeds the declared file lists

**Plan claim/section:** Muse concludes “exactly the seven changed files”; Claude limits behavior changes to four modules plus three tests. Both discuss unchanged/rejected paths and dotted identifiers in backticks outside “Reuse and Scope.”

**Rule:** The selected plan must authorize exactly its intended change map. The current `extractApprovedPaths` scans backticked tokens outside the reuse section, including alternatives, exclusions, and dotted identifiers.

**Concrete failure:** Running the actual extractor on Muse's bound plan yields 17 entries, including the expressly unchanged `src/evidence.ts`, the rejected new module `src/requiredArtifact.ts`, and the entire `githooks/` prefix. Claude's bound plan yields 18 entries, including `.gitignore`, the expressly unchanged `src/tmux.ts`, and bogus path-like identifiers such as `f.ui.sends`. The approved map would therefore permit unrelated paths despite each plan's stated narrow scope.

**Smallest correction:** Keep intended editable paths in the file list and place unchanged-path citations in “Reuse and Scope,” or remove backticks from incidental path-like prose elsewhere. Validate extraction against the exact expected file set before publication. This needs plan formatting changes, not a product parser expansion.

## Conclusion

Request revision of Muse's plan `46547e48ade505e871e4de91ceb06895151a4b1a` and Claude's plan `6630d4b4bd3ce2c16d578ee2a70bf356055d0637` before either is used as written. Both reuse appropriate existing modules and fixtures and avoid new dependencies, but their concrete guard/watchdog rules leave failures or block legitimate work. Their test-tier commands and extracted scope also need correction.

No blocking finding identified in Codex's bound plan `0155280a858a776d3e8db3acc00c87f5bddcc6cc`. Its extracted map is exactly the nine declared existing files. Its additional terminal-log and busy-predicate work is directly related to silent-tool activity detection, reuses existing runtime paths/parsers, and justifies the two additional existing source/test surfaces. It covers product/signal sequencing, current-action identity, both verification modes, staged artifact changes, and incomplete observations. Prefer that plan as the implementation basis, with its proposed focused tests and existing mandatory check ownership preserved.

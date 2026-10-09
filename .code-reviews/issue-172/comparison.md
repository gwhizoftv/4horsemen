# Issue 172 implementation comparison

## Comparison

Reviewed the exact exported worktrees named by action `09ba7117-228f-45bb-9707-f3a280ec5393`:

| Agent | Bound implementation pin | Assessment |
| --- | --- | --- |
| Cursor | `abb2cf2b4afdcf38c67bec77a556385c282410e3` | Covers most requested interfaces, but loses hidden owner edits, trusts stale publication evidence, and disarms the guard for live legacy runtimes. |
| Claude | `38d0460c436ade9a8fb7bdba6070ae923e2d1d80` | Compact reuse and batch preflight, but loses hidden owner edits, trusts stale publication evidence, and reads the wrong action location for current nested workspaces. |
| Codex | `e62ba296c26b0602dbefb300604e83a057e200d6` | Preferred revision base: preserves hidden edits, checks publication freshly, preflights before teardown, and preserves active current/legacy containment. Completed legacy runtimes remain incorrectly blocked. |
| Antigravity | `7427ebfca2a4969916aabf54d698146a49d4b2c9` | Several containment and cleanup defects, incomplete config-only inference, an extra command excluded by the selected plan, and a failing test in the exact pin. |

All four retain the existing Codex `--no-daemon` launch, add the pnpm-store exclusions, label status output, and route the All agents reminder through captured requests. Their important differences concern preservation of manual work and the evidence used to relax containment.

## Findings

1. **[P1] Cursor `src/prepareAgentBranch.ts:680`, Claude `src/prepareAgentBranch.ts:672`, Antigravity `src/prepareAgentBranch.ts:687` — preserve owner changes hidden by the managed skip-worktree bit.** Manual readiness must refuse actual owner edits even when porcelain status hides them. These implementations use `blockingDirtyPaths` alone before lifting the protocol. With a clean published scratch branch, the installed overlay, and an owner note appended outside that overlay in `AGENTS.md`, all three returned `checked-out` and erased the note. The reproduction used the real protocol writer and checkout helpers. Codex refused and preserved the note. Extend the existing manual-readiness tests with this case and assert byte-for-byte preservation and no teardown.

2. **[P1] Cursor `scripts/lib/launcher.sh:215`; Antigravity `scripts/lib/launcher.sh:199` — absence in one runtime layout must not classify an active supported issue as stale.** Cursor checks only the directory beside a nested config and delegates when the issue instead lives in the supported outer legacy runtime. Antigravity always selects that outer directory and delegates when an active issue lives beside the nested config. Real generated-shim probes returned exit 0 for both `status` and an exported pinned read in the respective live layouts. Expected exit is 2. Test both layouts with `completed: false`, including a bound action in the actual runtime.

3. **[P1] Antigravity `scripts/lib/launcher.sh:211` — only top-level workflow completion or abandonment may relax containment.** The unanchored grep accepts a nested `completed: true` while the workflow's own `completed` and `abandoned` remain false. A flat-runtime reproduction with those values allowed both restricted reads. Add a nested-true/top-level-false regression; it must remain denied.

4. **[P1] Antigravity `src/tmux.ts:901` and `src/tmux.ts:959` — automated panes must not start when removal of inherited `COORD_MANUAL` fails.** Both calls ignore the tmux exit status. A fake runner returning failure for this operation still reached `new-window` and `startSession` returned successfully; the other candidates refused before launch. A leaked `COORD_MANUAL=1` then disables the shim in an automated pane. Cover failure in both fresh-session and ensure-session paths.

5. **[P1] Antigravity `src/cli.ts:724` and `src/prepareAgentBranch.ts:669` — a manual-readiness refusal must precede teardown and checkout effects.** `detachManual` closes the owner UI before checking for dirty or unpublished work. Its readiness helper also applies each eligible clone before checking later clones. A dirty second clone therefore produces a refusal after terminals have closed and the first clone has switched branches. The owner's working session is already interrupted when the refusal arrives. Test a clean first clone plus a dirty second clone, asserting no teardown, no branch changes, and nonzero completion.

6. **[P2] Cursor `src/prepareAgentBranch.ts:714` and `:739`, Claude `src/prepareAgentBranch.ts:678` and `:680`, Antigravity `src/prepareAgentBranch.ts:704` and `:713` — publication checks need remote evidence, not the local commit being checked or an obsolete tracking ref.** The shared automatic-cleanup resolver falls back to local base when fetching fails; each manual implementation then accepts HEAD as its own publication target. All three accepted an unpushed local-main commit with an unavailable origin as `already-base`. All three also accepted an unmerged scratch tip whose upstream branch had been deleted remotely, because only base was fetched and the stale upstream ref survived. Codex refused both cases. Add both regressions; neither may close UI or report successful manual readiness.

7. **[P2] Claude `scripts/lib/launcher.sh:244` — exported-file enforcement must use the action for the runtime actually being guarded.** Taking the last root always selects the outer runtime in a nested install. With a live current nested issue and `## Bound input files` in its action, `status` was correctly denied but `show <40-hex>:README.md` was allowed because the code looked for the action outside that workspace. A generated-shim test must assert denial for the current nested action as well as the legacy action.

8. **[P2] Codex `scripts/lib/launcher.sh:208` — positively completed or abandoned legacy issues must release a stale issue binding.** The legacy-directory branch returns failure for every staleness lookup, so the completed/abandoned test is unreachable. With no current nested issue, an outer legacy `start.json` identifying the same nested config, and top-level `completed: true`, the generated shim still returned exit 2 for `status`; the other candidates returned 0. Add completed and abandoned cases for an identified legacy issue while retaining denial for a live or ambiguously owned legacy issue.

9. **[P2] Cursor `src/prepareAgentBranch.ts:714`, Claude `src/prepareAgentBranch.ts:678`, Antigravity `src/prepareAgentBranch.ts:704` — dry-run must not update repository refs.** Each helper fetches before reaching its dry-run branch. With origin advanced after the clone's last fetch, calling manual readiness with `dryRun: true` updated `origin/main` in all three reproductions. Codex left the tracking ref and worktree unchanged and described its cached check. Extend dry-run coverage to refs/FETCH_HEAD, not just the checked-out branch.

10. **[P2] Antigravity `src/cli.ts:428` — the selected plan requires `--config` alone to infer its workspace runtime.** The exclusive-or check still rejects every config-only invocation before reading the config. Thus `coord start N --config <installed-config>` and the corresponding manual/detach entry points still require the flag the issue is meant to remove. Test a valid installed config without `--coord-runtime`.

11. **[P1] Antigravity `test/issueReport.test.ts:212` — the exact submitted pin must pass its mandatory fast tests with the new frame contract.** The committed test still expects the old `----` delimiters at both ends. I ran this unchanged test file against the bound worktree: 8 tests passed and the frame test failed at line 212 on the new `==== coord status: issue 1 ====` output. Update the assertions in the submitted product commit; a recorded passing hook observation does not make this pinned test pass.

12. **[P2] Cursor `src/tmux.ts:878` — placement diagnostics must distinguish unknown placement from verified placement.** An empty `pane_start_path` deliberately skips validation and reaches the statement that the pane is placed in the configured clone at line 892. For successful tmux output `0\t\n` and no title probe, the owner receives an unsupported location assertion. Test that unavailable start-path data yields an explicit unknown/warning instead of claiming the configured directory was verified.

## Scope and reuse

The supplied changed-path inventories show no new product files or dependencies in any candidate. All extend existing modules and tests and preserve the existing reminder delivery guards. None edits product hooks or introduces the rejected TypeScript-side staleness policy.

Claude and Codex share the checkout/protocol/verification helper with automatic cleanup. Codex adds one callback to place teardown between batch preflight and revalidation; its extra checks address the concrete preservation and publication failures above. Cursor extracts the automatic helper but also adds a second manual helper with substantially duplicated protocol restoration and post-checkout verification. That duplication is unnecessary maintenance work compared with sharing the preserved-history checkout option.

Antigravity `src/cli.ts:1084` additionally accepts `manual --done` and `manual --dry-run`. The selected plan explicitly excludes the new completion alias. The plain `manual --dry-run` path also continues into ordinary manual launch because the flag is consulted only inside the `--done` branch. This extra interface should be removed rather than expanding the selected scope. Its changed-path inventory also lacks the planned interactive regression and report-frame test update. The latter omission causes finding 11.

Claude and Cursor add focused coverage for ordinary clean/dirty/unpushed transitions, but omit the hidden-overlay and stale-publication cases. Codex adds those cases to the existing fixture tests, includes batch refusal and changes during teardown, and tests unavailable placement data. Its gap is completed legacy-runtime staleness. Antigravity's confirmation tests use missing/non-Git clone fixtures that are skipped, which does not establish safe cleanup of real manual work.

## Verification

I read the issue runtime's `journal.jsonl`. These are advisory hook observations, not coordinator final verification receipts:

| Agent | Recorded successful check:fast event | Recorded successful test:e2e event |
| --- | --- | --- |
| Cursor | sequence 1242 | sequence 1245 |
| Claude | sequence 1270 | sequence 1272 |
| Codex | sequence 1685 | sequence 1716 |
| Antigravity | sequence 2356 | sequence 2393 |

The journal also records earlier failed attempts for Cursor and Antigravity. Codex's completed implementation turn directly observed lint, both typechecks, 703 fast tests, 193 system tests, and 2 end-to-end tests passing. I did not rerun the full candidate suites during this comparison, and do not claim the coordinator's final checks passed.

For findings, I ran isolated Git fixtures using helpers bundled from each exact exported tree and executed each tree's generated shell shim. The probes covered hidden owner notes, unavailable origin with unpushed base history, deleted upstream branches, dry-run tracking refs, current/legacy active runtimes, nested completion fields, completed matching legacy runtimes, and failed mode-variable removal. Fixtures used temporary repositories, not the working clones or live terminals. The four pins have identical lockfiles to the installed dependencies used by these probes.

I separately ran Antigravity's unchanged `test/issueReport.test.ts` through Vitest with the bound worktree as root and only dependency resolution redirected to the installed packages. It failed as described in finding 11. The hook observations therefore must not be treated as proof that this exact exported test tree passes. No product files were edited for the review.

## Verdict

Select Codex as the revision base, addressing finding 8 before approval. The other candidates require fixes for owner-data loss and/or active containment failures as well as their listed gaps. None should be approved unchanged on the evidence reviewed here.

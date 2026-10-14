# Issue 213 implementation comparison

## Comparison

Protocol version: 1. Action: `4710c21a-be42-477b-8f26-c0ade5254ee4`.
Reviewed changed code and tests directly in the exported worktrees at these
exact implementation pins:

| Agent | Implementation pin | Assessment |
| --- | --- | --- |
| Codex | `b533cb49a583b3410ad8f465973967f0cdee6fb0` | Preferred; preserves owner settings and restricts the generated docs exemption to regular prose files. |
| Claude | `36ed2ce76ed196bdc9f81b94d560a00e08f095d7` | Requires the two corrections below. |
| Cursor | `12a121c53b47d191741ef0b6095a55903d1a3b08` | Requires the same two corrections. |
| Antigravity | `2f91238869e37480e364406de7c370da2c2a31a2` | Requires the same two corrections. |

All four implement the selected plan's core behavior: a process-local Codex
vim override, Claude clone-local editor defaults without the telemetry-breaking
`--settings` flag, positive Codex NORMAL evidence before sending `i`, streaming
UTC terminal timestamps with tmux `%`/`#` escaping, empty documentation check
lists, and `onboard --declare`. They retain declaration-based cache policy and
leave Cursor vim configuration to the owner, as the selected plan specifies.
They do not provide automatic vim-off for Cursor or automatically migrate an
existing runtime's verification policy; those remain documented owner steps.

The coordinator's changed-path lists show the same 14 product files for each
implementation, all within the approved scope supplied during implementation.
There are no new product files or dependencies. Each reuses the launcher,
hook synchronization, policy builder, nudge helpers, and existing test files.
Claude and Cursor extract the existing ecosystem proposal into a helper;
Antigravity nests and reindents it inside `baseProposal`, adding more textual
churn without additional behavior. None introduces unrelated product features.

Codex's additional coverage is focused on real boundaries: preserving both
pre-existing editor modes and later owner edits, regular-file documentation
selection, partial log output before newline/exit, timestamp escaping in a log
directory containing `%Y`, and owner-reminder key selection. Its ownership
marker uses an existing managed SessionStart command, avoiding a new metadata
file. The other implementations extend the existing fixtures appropriately,
but their cases do not exercise the two failures below.

## Findings

1. `src/setupWorkspace.ts:195` (Claude), `src/setupWorkspace.ts:179`
   (Cursor), and `src/setupWorkspace.ts:248` (Antigravity): **[P1] An automatic
   prose-only exemption must retain product checks for agent instructions,
   executable files, and symlinks.** These filters exclude instruction names
   only at the repository root and inspect names without Git modes. A tracked
   `docs/AGENTS.md`, root `SKILL.md`, executable `docs/run.md`, or symlink
   `docs/link.md` is therefore recorded with empty hook and final check lists.
   Subsequent changes to those behavioral files skip product checks. I
   reproduced this in each of the three exported implementations: the existing
   `selectVerification(..., "finalization", productChecks)` returned `[]` for
   each example. A focused regression fixture should stage those paths alongside
   `README.md` and `docs/guide.md`, mark `docs/run.md` executable, create the
   symlink, and require only the two prose files in the proposal. Codex passes
   that boundary by checking stage-zero mode `100644` and instruction basenames
   in `src/setupWorkspace.ts:248` and `src/setupWorkspace.ts:252`.

2. `src/agentHookSync.ts:243` (Claude), `src/agentHookSync.ts:266`
   (Cursor), and `src/agentHookSync.ts:263` (Antigravity): **[P2] Uninstall must
   remove only settings owned by coordination, preserving pre-existing owner
   values.** Each implementation deletes any `editorMode: "normal"` once it
   removes managed hooks, without recording whether install created the value.
   Starting with an owner's `{ "editorMode": "normal", "custom": "owner" }`,
   then synchronizing and removing the hooks, leaves only `custom` in all three
   implementations. The owner's editor preference is lost and a home vim
   preference can become effective again. A regression should assert that the
   original normal value survives install/reinstall/uninstall, while a generated
   default is removed and a later owner change is preserved. Codex's ownership
   check at `src/agentHookSync.ts:277`, with tests at
   `test/agentHookSync.test.ts:118` and `test/agentHookSync.test.ts:131`, meets
   those requirements. The selected plan accepted deleting an owner-authored
   normal value, but that does not establish ownership or preserve the existing
   uninstall contract.

## Verification

I read the existing product verification observations in
`/Volumes/4TB-SOURCE/REPOS/4horsemen/coord-runtime/issue-213/journal.jsonl`.
The successful precommit index identities match the exact bound product commit
trees. The successful prepush ranges contain their corresponding bound product
pins (Claude's range ends at its product pin; the others end at descendant
publication commits).

| Agent | Matched precommit tree | `check:fast` | `test:e2e` | Journal lines |
| --- | --- | --- | --- | --- |
| Codex | `b98d3428d4ea1514fb4f9d5ae711d1c945ebeea9` | exit 0 | exit 0 | 1393, 1414 |
| Claude | `ae8a25d27a04d9499888e20bafe414e0feedd2a7` | exit 0 | exit 0 | 1402, 1413 |
| Cursor | `69a2b505aef13d920159fc62335752e64c9c9812` | exit 0 | exit 0 | 1481, 1511 |
| Antigravity | `4fe7dbce8773889f052e595531120c1e7d7cb44f` | exit 0 | exit 0 | 1936, 1961 |

These are recorded advisory hook observations, not coordinator final-gate
receipts or suites I reran for this comparison. Antigravity also has an earlier
failed precommit observation at a different index identity; it does not
describe the bound product tree.

For this review I ran only targeted reproductions of the findings. I transpiled
the exported TypeScript into disposable temporary directories with the existing
TypeScript dependency, loaded each pin's actual hook/policy/classifier modules,
and exercised owner-setting round trips and staged Git fixtures. All three peer
pins reproduced both defects; Codex preserved the owner value, proposed only
`README.md` and `docs/guide.md`, and retained product checks for all four
non-prose examples. Temporary files were removed. I did not rerun product
suites or live vendor smoke checks. The earlier Codex live-agent smoke check
remains unverified because direct shell tmux socket creation was denied;
its mandatory commit hook did pass the real tmux integration test.

## Recommendation

Select Codex `b533cb49a583b3410ad8f465973967f0cdee6fb0` as the implementation
base. No blocking finding was found in its inspected changes. Its extra
ownership and file-mode checks address concrete regressions present in all
three alternatives, with focused coverage and no additional product files.
Keep the live-vendor smoke limitation visible when assessing final readiness.

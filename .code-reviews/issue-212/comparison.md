# Issue 212 implementation comparison

## Comparison

All four bound implementations satisfy the issue without a blocking defect found in this review. Prefer Codex for its direct coverage of both requested revision rounds and reuse of existing regression tests.

| Agent | Bound product pin | Assessment |
| --- | --- | --- |
| Cursor | `b34cde7dda51655a1fc10ea245218f584bb3002a` | Correct implementation; explicit round-2, round-1, missing-batch, document-manifest, and extra-parent coverage. Its scaffold regression uses an implementation input rather than the prior-revision input used by later rounds. |
| Codex | `57cc186f930f0841b22f89a754b3d2bfbf946190` | Preferred. Parameterizes the binding regression over rounds 2 and 3, retains round-1 and missing-batch assertions, and exercises lineage, approved paths, and phase separation with ballot inputs present. |
| Antigravity | `ff20570dee7d7fa6800c16b423360833ae78f74a` | Correct implementation; explicit round-2, round-1, missing-batch, document-manifest, extra-parent, and multiple-product-parent coverage. The missing-batch concern in its earlier plan is resolved. |
| Claude | `cadc99bd74a32882534cdc43f7fd668e415e49f4` | Correct and concise implementation; reuses the terminal fixture for round-2 binding and missing-batch coverage, tests prior-revision scaffolding, and proves ballot commits need not be ancestors of the product. |

Each implementation reuses `publishedBallotBatch` to select the preceding round's published batch with the existing roster and response-identity validation. A small private mapper is shared by `R6.revise` and `R6.follow-up`; it preserves the batch commit SHA, response agent, and corresponding published path. A missing batch leaves the prior product input intact. Round 1 continues to bind the selected implementation alone.

Each implementation also shares a product-input allowlist between revision evidence validation and scaffolding. Only `implementation` and `prior-revision` contribute to `basedOn`; the full input set, including ballots, still contributes to `inputSetHash`. The existing single-parent requirement, ancestry check, approved-path check, and phase-pin validation remain in place. All candidates add `consensus-ballot` to document materialization and update the driver documentation to describe the distinction between feedback and product ancestry.

The supplied changed-path lists show the same eight product/documentation/test files for every candidate, all within the selected plan. The remaining paths are issue coordination artifacts. None adds a product file, dependency, protocol kind, or unrelated refactor. The two small helpers remove duplication across actual callers. All use the existing three test files and fixtures. Codex extends the packet-manifest test and parameterizes the existing evidence test; Claude and Antigravity reuse `terminalFixture` for their new binding test, while Cursor reconstructs the selection fixture locally. These are coverage and maintenance differences, not correctness blockers.

## Findings

No actionable correctness or scope violation found in the four bound implementations. The source paths, tests, and documentation agree on the required behavior. In particular, an artifact that incorrectly includes the ballot batch SHA in `basedOn` is rejected for unequal bound product pins; it does not require the authorized-product-count diagnostic when the action contains one product input. All four implementations use the correct diagnostic in their regression coverage.

Codex's `test/runLoop.test.ts:4507` directly tests both rounds named by the issue. Its `test/evidence.test.ts:674` preserves the existing rejection cases in a ballot-bearing round, and its positive case refuses ballot ancestry. Claude independently covers the latter condition at `test/evidence.test.ts:743`. Cursor and Antigravity cover the positive result with permissive ancestry stubs; their reviewed production code still applies ancestry only to the product input. No additional test run was needed to investigate a suspected defect.

## Verification

Read the materialized worktrees directly and confirmed each HEAD matches its bound pin. Existing verification comes from `/Volumes/4TB-SOURCE/REPOS/4horsemen/coord-runtime/issue-212/journal.jsonl`. The successful `pnpm run check:fast` hook observations match each product commit's tree identity; the successful `pnpm run test:e2e` observations cover the corresponding accepted implementation submission range:

| Agent | Passing check:fast journal sequence | Passing test:e2e journal sequence |
| --- | --- | --- |
| Cursor | 1087 | 1108 |
| Codex | 1132 | 1145 |
| Antigravity | 1180 | 1212 |
| Claude | 1198 | 1218 |

Claude has an earlier failed `check:fast` observation at sequence 1053, followed by the successful observation for the same tree at 1198. The journal does not provide the failure diagnostic, so no cause is inferred. These records are labeled advisory hook observations, not coordinator final verification. Codex's earlier implementation work also ran the three focused test files successfully (308 tests). This comparison action ran no product suite. Final `pnpm run check` remains coordinator-owned; no final-suite pass is claimed.

## Verdict

Accept any of the four candidates on the reviewed behavior and scope. Select Codex `57cc186f930f0841b22f89a754b3d2bfbf946190` for the most direct regression coverage of rounds 2 and 3 with minimal additional test structure. No implementation revision is requested by this comparison.

# Issue 220 implementation comparison

## Comparison

Reviewed these exact product pins through the coordinator's exported worktrees:

- Cursor: `8ac06bac06de77fb1702b7fd62187c99a1838a77`.
- Claude: `966c689ae1ac7828a64b2b2de5c2696d1c59b4d3`.
- Codex: `b71317bc0b11164a217e91f2c608eeb4d8616af1`.

No production correctness defects found. All three implement the same binding:
the selected implementation first, then the published comparison ballots, then
the active agents' accepted comparisons as `review` inputs. They preserve the
missing-selection guard, null-round fallback, and later-round branch. Cursor
uses an early return and Claude adds an explanatory comment; these differences
do not change behavior.

All three use the existing publication/roster checks, materialized document
kinds, and product-parent filter. Their production edits stay in the approved
binder and documentation files. They also update the three approved test files,
including the canary's former single-input assertion and its `basedOn`
submission. No implementation adds product files, dependencies, new kinds,
abstractions, or unrelated refactors. The coordinator-listed coordination
artifacts do not expand product scope.

Coverage comparison:

- **Codex:** `test/runLoop.test.ts:4202` reuses `terminalFixture` and existing
  ballot helpers to cover the exact bound set, missing batch, inactive
  comparison exclusion, null-round fallback, and missing selected
  implementation. `test/integration.test.ts:396` extends the existing real-Git
  canary to check every feedback entry against the action's manifest, read the
  exported files, compare their bytes to their cited blobs, and verify the
  selected worktree's HEAD. Amendment-resume equality checks remain in place.
  `test/orderScaffold.test.ts:10` derives the inputs before checking both the
  complete input hash and the single `basedOn` pin. Its additional in-memory
  cursor fixture is the main maintenance cost, but it directly exercises the
  issue's requested failing-before scaffold regression.
- **Claude:** `test/runLoop.test.ts:4227` reuses `terminalFixture` and tests the
  exact bound inputs and absent-batch behavior, then exercises
  `materializeBoundInputs` with a stub mirror. The entry counts and recognized
  worktree kind are checked, although the no-op worktree stub does not prove
  the resulting worktree exists. The existing packet tests separately cover
  document bytes. The canary verifies the complete active-agent input shape
  and uses `revisionProductInputs` for its submission. This is focused coverage
  with less fixture setup than Codex's approach.
- **Cursor:** `test/runLoop.test.ts:4227` covers exact round-1 inputs and
  absent-batch behavior, using the existing fixture and ballot helpers while
  spelling out the implementation-selection record. Its canary checks one
  implementation, ballot, and review per active agent, and submits only the
  implementation pin. It relies on the existing materialization tests rather
  than adding issue-specific checks of exported paths or bytes.

The main test-acceptance limitation is shared by Claude and Cursor:
`test/orderScaffold.test.ts:35` in each pin constructs the mixed input list
directly. The issue asks for regressions in both named test files that fail
before the binding fix. With the original broken binder restored, these new
scaffold cases remain green because they never call it. Their run-loop tests
do detect that regression, so this is a coverage distinction rather than a
demonstrated runtime defect. Codex's derived-input scaffold case detects the
missing feedback through the expected full input hash.

## Verification

Read the existing issue journal's advisory hook observations and matched the
successful precommit index identities to the exact product worktree trees:

| Product | Tree checked by precommit | `pnpm run check:fast` | `pnpm run test:e2e` |
| --- | --- | --- | --- |
| Cursor | `b6bf6eb9c832e7e375b789f70d3ca539d7dbdd9e` | Journal 317, exit 0 | Journal 323, exit 0 |
| Claude | `380c4a5bec8abf36bb745bfb77f01cb742afeaa4` | Journal 320, exit 0 | Journal 332, exit 0 |
| Codex | `6b1949e424fe9ebe62b54d3bf8c9598cee0146b5` | Journal 344, exit 0 | Journal 358, exit 0 |

Each prepush observation covers the range ending at that implementation's
accepted readiness submission. These are recorded agent-hook results; no
coordinator-final suite result is claimed.

For Codex, this session also directly observed both new regressions fail on
the original binder, all 246 affected-suite tests pass after the fix, and the
targeted consensus canary pass. The successful hooks ran lint, typechecking,
790 fast tests, 215 system tests, and both e2e tests. No product suites were
rerun for this comparison; the review used the bound files and existing
verification evidence.

## Verdict

Recommend Codex at `b71317bc0b11164a217e91f2c608eeb4d8616af1`. The production
behavior is equivalent across all three candidates, while this pin directly
verifies readable feedback in the published action and satisfies the literal
failing-before requirement in both named test files. Claude is a reasonable
smaller alternative if its already-passing scaffold guard is accepted. No
production-code revision is requested for any candidate.

# Issue 212 plan review

Reviewed the four plans exported in the current action's bound-input packet:

- Claude: `6d5e64afa09bd489cf54653e35bdf47fbb4334c5`.
- Codex: `8648fd54c3ee81799d16ac745086b78a0b368e44`.
- Cursor: `9d37c3f9db5c3b25ffe2f7bdb1cfd17880288ef9`.
- Antigravity: `0fa218a0ff2dddff8161e070744abd8384bde180`.

## Findings

1. **[P2] Antigravity — Risks and Mitigations, missing-ballot-batch handling.**
   The plan says to return an empty input array when the batch is null, claiming
   this prevents partially bound orders. A revision action that is actually
   issued must retain its one authorized product parent; returning no inputs is
   not a workflow wait or recovery mechanism. In the missing-batch case the plan
   explicitly handles, even if the preceding accepted product revision exists,
   buildOrder still renders the action and its revision scaffold becomes
   `basedOn: []`. That fails revisionReadyArtifactSchema's nonempty array rule;
   supplying the known product SHA manually instead fails equality with the
   empty bound product set and the exactly-one-authorized-product-pin check.
   Reissuing the action with the same state repeats the failure. The existing
   publication gate protects normal forward transitions, but does not make
   returning an empty array suppress action creation or recover this case.
   Supporting code: `src/runLoop.ts:797`, `src/orderScaffold.ts:67`,
   `src/protocol.ts:158`, and `src/evidence.ts:363`.
   Preserve the prior-revision input when only the batch is unavailable, as the
   other three plans specify, and add the missing-batch assertion alongside the
   existing binding regression. A genuine wait/republication strategy would
   require additional workflow work that this plan does not propose.

No blocking findings in the Claude, Codex, or Cursor plans. All three cover the
necessary combination: previous-round canonical ballot binding, document
materialization, product-only basedOn validation/scaffolding, and hashing the
complete bound set. Their round-1 behavior remains unchanged.

## Conclusion

Claude, Codex, and Cursor are implementable as written. Antigravity needs the
missing-batch correction above before selection.

All four stay within issue 212's purpose and reuse publishedBallotBatch,
acceptedAt, inputFromSubmission, the existing packet exporter, and existing test
fixtures. None introduces a new file, dependency, or schema. Claude and Cursor's
small shared ballot mapper has two existing call sites; Codex and Cursor's
shared product-input filter keeps the scaffold and validator consistent. These
are justified local helpers. Cursor's additional driver-documentation edit
directly updates the now-stale statement that later rounds bind only a revision.

The tests target the affected binding, export, scaffold, and evidence boundaries
in existing test files. Codex proposes broader negative cases, but they exercise
the full-input-hash and single-product-parent invariants affected by this change.
For Claude's evidence case, asserting a satisfied result would make its intended
acceptance criterion clearer than merely excluding two error strings. Antigravity
should also name its focused executable test command, as required by AGENTS.md;
the other plans provide one for the same three existing suites. These verification
clarifications do not expand the product scope.

Validation performed for this review: verified the action ID and SHA-256 digest,
checked all four exported plan files against their manifest digests, and traced
the relevant derivation, scaffold, validation, materialization, and workflow code.
No product tests were run for this evidence-only review, and no implementation
test pass is claimed.

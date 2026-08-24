# Implementation Plan — Issue 88 Baseline Verification

The issue's product work is already present in the bound baseline
`76cfd1550c3e74c0b6281cd83be04da9049f5814`. That baseline contains commit
`3662cc094cd9f12ec0a82f56e8d6a9e4da652536`, which introduced the
agent-facing language boundary, outcome-oriented participation artifact,
clean action footer, clean injected instruction text, and exhaustive generated
action coverage. A focused run of the relevant tests on this baseline passed
all 202 tests across eight files. The correct implementation is therefore a
verification-only, zero-product-diff pin rather than a second rewrite of the
same contract.

## Exact File List to be changed or deleted

None. No tracked product file should be changed or deleted.

The implementation must audit the existing boundary in
`src/agentLanguage.ts`, its action producers in `src/steps.ts`,
`src/action.ts`, `src/orderScaffold.ts`, `src/evidence.ts`, and `src/tmux.ts`,
the installed guidance in `templates/product/AGENTS.md` and
`templates/product/AGENTS.protocol.md`, and the exhaustive regression suite in
`test/agentLanguage.test.ts`. These paths are inspection anchors only; they are
not instructions to manufacture a diff. In particular:

1. Confirm generated actions expose outcomes, required artifacts, exact bound
   inputs, publication paths, and completion instructions without exposing
   internal step IDs, gate IDs, evidence IDs, phase language, or delivery
   jargon.
2. Confirm participation uses the public
   `.signals/issue-<n>/participation-ready-<agent>.json` path and
   `participation-ready` discriminator while the internal identifiers remain
   available to state, analytics, coordinator diagnostics, and owner output.
3. Confirm all generated action types, injected instruction variants,
   correction text, and installed agent guidance are covered by the shared
   banned-language invariant.
4. If this audit or the named tests fail, stop and report the baseline
   regression rather than broadening the file map or silently creating an
   unrelated fix. With the current verified baseline, the product pin is the
   baseline commit itself and the later coordination signal is a descendant of
   that immutable pin.

## Exact file list to be created

None. No product source, test, schema, documentation, template, dependency,
configuration, or migration file is needed. Only the transient current-issue
coordination artifacts requested by subsequent actions may be added on the
issue branch; they are not product changes.

## Tests

Run the focused boundary suite first:

```bash
pnpm exec vitest run --config vitest.config.ts test/agentLanguage.test.ts test/action.test.ts test/orderScaffold.test.ts test/protocol.test.ts test/evidence.test.ts test/runLoop.test.ts test/tmux.test.ts test/install.test.ts
```

This suite must prove that every `STEP_DEFINITIONS` entry renders cleanly with
empty inputs, bound inputs, and correction text; that all injected instruction
forms and installed guidance remain clean; that public readiness paths and
schema tokens are outcome-oriented; and that internal workflow identifiers
remain intact for non-agent consumers.

Then run the repository's actual pre-commit and acceptance commands:

```bash
pnpm check:fast
pnpm check
```

`pnpm check:fast` covers lint, type checking, and fast tests. `pnpm check` adds
the build and end-to-end suite. Both must pass against the unchanged product
baseline. A clean `git diff` outside current-issue coordination paths is an
additional required verification of this no-op implementation.

## Alternatives Rejected

- Reapply the historical issue-88 patch. Rejected because the exact feature
  and regression coverage already exist in the bound baseline; duplicating it
  would create churn without changing behavior.
- Add a redundant assertion or comment solely to create a product commit.
  Rejected because an artificial diff weakens review signal and is not required
  by any acceptance criterion.
- Rename internal workflow, gate, evidence, journal, analytics, or delivery
  identifiers. Rejected because the issue explicitly requires those names to
  remain available to the coordinator, analytics, owner, and operator-facing
  documentation.
- Remove ordinary words such as plan, review, implement, revision, or
  consensus from task text. Rejected because they describe the work product,
  not an internal transition.
- Bump `package.json`. Rejected because ordinary issue-branch commits do not
  require a pre-1.0 version advance; that check applies only to the pull request
  into main.

## Risks and Mitigations

- **Risk: a no-op is mistaken for incomplete work.** Mitigation: bind the
  implementation to the exact baseline commit, record the existing feature
  commit, run both focused and full verification, and require a zero product
  diff.
- **Risk: the baseline contains an untested leak outside the intended public
  surfaces.** Mitigation: audit the three real boundaries—rendered actions,
  injected instruction text, and installed guidance—and rely on the existing
  step-driven test that enumerates every generated action type rather than a
  hand-picked sample.
- **Risk: sanitization removes operator observability.** Mitigation: make no
  product edits and explicitly verify that internal IDs still exist in state,
  analytics, coordinator diagnostics, and owner output.
- **Risk: a coordination-only commit is confused with the immutable product
  pin.** Mitigation: pin the bound baseline as the product result and publish
  any required signal in a later descendant commit; never pin the signal commit
  itself.
- **Risk: a version-only or formatting-only commit creates a false
  implementation delta.** Mitigation: reject synthetic edits and verify the
  endpoint diff contains only current-issue coordination files.

## Conclusion

Issue 88 is already implemented in the authoritative baseline and its focused
acceptance suite passes. The mechanically correct implementation is to preserve
that product tree unchanged, verify the complete agent-facing language
boundary with the focused and full commands above, pin the baseline commit as
the implementation result, and publish only the coordinator-requested
transient evidence.

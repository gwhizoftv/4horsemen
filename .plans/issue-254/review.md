# Issue 254 plan review

Protocol version: 1. Reviewed the coordinator-exported plans against the frozen issue requirements and the existing lifecycle, coverage, report, and test code.

Bound inputs:

- muse: `8ea5f65dd9cf9321ab3a1a9467bea19d7db0afa4`, `.plans/issue-254/plan.md`.
- claude: `46d506425be4ec2fb9ff6207fd7276c8e7c86e20`, `.plans/issue-254/plan.md`.
- antigravity: `61adde90c2fd4cf2f0a7b7b87176b9b35ccd456b`, `.plans/issue-254/plan.md`.
- codex: `f88e18d0584622bc231dad87277aa19ed58cc943`, `.plans/issue-254/plan.md`.

## Findings

No blocking production-design findings. All four plans preserve same-session evidence, retain replacement-session invalidation, gate completed-issue uncertainty, and omit only the completed report's live binding comparison. Each keeps the shared corroboration rules and live guard/ingestion behavior intact. All address both the top-level cue and the inline per-agent coverage output; none relies on the nonexistent `renderAgentStatusLines` function.

One nonblocking test-instruction clarification:

- **[P3] muse, Exact File List / `test/agentLifecycle.test.ts`** at `8ea5f65dd9cf9321ab3a1a9467bea19d7db0afa4` directs replacing the line-85 exit assertion and expecting active coverage. **Rule:** active coverage still requires a known vendor version; preserving containment must not relax that requirement. **Concrete failure:** the existing test sets `current.containment.probe.vendorVersion = "unknown"` at line 80. Adding the active-coverage assertion at line 85 without moving the setup or restoring the version will remain red after the correct production fix, because `containmentCoverage` correctly returns `unverified`. The plan's Tests section already asks for a corroborated active fixture, so this is an ordering clarification rather than a design objection: put the exit assertions before the unknown-version mutation or restore `"1.2.3"`, retaining the existing unknown-version negative assertion. Claude and Codex explicitly describe that ordering/restoration.

Scope, reuse, and test assessment:

| Plan | Assessment |
| --- | --- |
| muse | Four existing files, no new product files or dependencies. Reuses coverage and test fixtures. The proposed module-local wrapper centralizes the two report call sites and remains within scope, although the completed guard makes a direct conditional sufficient. Same-ID and omitted-ID exit tests, replacement invalidation, completed reporting, live control, and never-probed evidence are focused. Apply the fixture clarification above. |
| claude | Four existing files with direct changes inside existing functions; no new abstraction or product file. Reuses the optional binding parameter and existing fixtures, explicitly restores the known vendor version, and covers degraded health as well as the completed/live distinction. The additional report case and existing lifecycle test are sufficient for the stated implementation. |
| antigravity | Four existing files and existing functions/types/fixtures, with no new dependencies or abstractions. The lifecycle and report regressions exercise the two failures and preserve active-issue and replacement-session controls. `needsAction` precedence is explicitly retained. |
| codex | The same four-file production/test scope, with no new production abstraction or permanent fixture file. Its extra test setup is justified by exercising actual changed and missing on-disk policies for the affected vendors. Health, missing evidence, mismatched denial, and action-precedence assertions remain tied to the issue and fit the existing test files. |

The `/c` fixtures in the Muse, Claude, and Antigravity plans exercise an unavailable live binding (`null`) rather than a real transition between two non-null bindings. That still tests the relevant completed/live branch: either `null` or a different digest rejects the existing probe when supplied to `containmentCoverage`. The existing lifecycle test separately verifies rejection of an explicitly mismatched digest. Codex adds direct filesystem-change coverage, but the smaller plans do not require new infrastructure to establish correctness.

All plans retain truthful per-agent unverified output when historical evidence is missing or uncorroborated. They do not reconstruct records already erased by older versions. An `[OK]` completed header describes workflow completion and does not certify every historical probe; existing `[ACTION]` precedence remains appropriate for unresolved issue-level obligations.

Validation performed: verified every exported plan's SHA-256 against the bound manifest, checked all seven required non-empty plan sections, and inspected the relevant source conditions and existing test fixtures. No product suite was run or claimed for this evidence-only review. Product implementation hooks still own their declared checks, including the configured prepush e2e suite; the coordinator owns final checks at the approved pin.

## Conclusion

All four plans are acceptable for implementation. The Muse fixture-order clarification is nonblocking because its test specification already requires a known-version, corroborated probe. Claude offers the smallest explicit implementation and test arrangement; Codex provides broader direct regression coverage without expanding the four-file map. No scope amendment, schema migration, new dependency, or additional product file is needed.

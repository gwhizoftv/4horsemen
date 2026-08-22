# Implementation Plan — Issue 92: Implement efficiencies based on the new analytics

## Exact File List to be changed or deleted

### Changed
- `AGENTS.md` — Trim the redundant tracked protocol section (lines 28–129) so that the managed overlay (`<!-- coordination protocol — coord install -->`) is the single canonical protocol source, eliminating ~3.6 KB of duplicated instructions from every agent prompt turn.
- `templates/product/AGENTS.protocol.md` — Ensure template alignment with the consolidated review/comparison format and trimmed workspace protocol.
- `src/steps.ts` — Update `WorkflowStepId`, `STEP_DEFINITIONS`, `consensusSteps`, and `reviewedSteps` to support single-turn consolidated review/ballot and compare/ballot steps, and define coordinator-derived mechanical steps.
- `src/machine.ts` — Update the state machine decision engine to automatically derive mechanical steps (`R3.publish-selection`, `R5.reviser-auth`, `R6.declare`) directly from accepted ballots without publishing redundant agent actions, advancing the workflow immediately.
- `src/runLoop.ts` — Implement coordinator-side derivation of selection, reviser-authorization, and consensus-declaration artifacts; record `durationMs` on verification and final checks; add `action-timing` records to the journal upon action completion; and generate consolidated review/compare orders.
- `src/orderScaffold.ts` — Update action prompts and JSON/markdown scaffolds to support consolidated review-and-ballot and comparison-and-ballot actions with exact placeholder guidance.
- `src/evidence.ts` — Add validation for consolidated review/ballot artifacts, and verify coordinator-derived signatures and ballot aggregations.
- `src/agentEvent.ts` — Debounce repetitive unchanged lifecycle status-line events (e.g., repeated `status-line/working` and invocation ticks from Antigravity) to eliminate 80%+ journal bloat.
- `src/action.ts` — Allow `preparedAt` in the action front-matter schema to enable agent-side latency measurement.
- `package.json` — Bump package version to `0.0.15` to satisfy the non-main branch pre-1.0 ship gate.
- `config.product.example.json` — Bump installed coordination version to `0.0.15`.

### Deleted
- None.

## Exact file list to be created

- `docs/architecture-context.md` — Structured codebase architecture map and fast-reference guide detailing module boundaries (`src/steps.ts`, `src/machine.ts`, `src/runLoop.ts`, `src/evidence.ts`, etc.), execution flows, and key interfaces to minimize exploratory search tool calls during planning and implementation.
- `.plans/issue-92/plan.md` — This implementation plan artifact.
- `test/support/fixtures/consolidated-ballot.json` — Test fixture demonstrating consolidated review/comparison evidence.

## Tests

### Fast Checks & Pre-commit (`pnpm check:fast`)
- `pnpm lint` — Static lint analysis across all TypeScript source and test files.
- `pnpm typecheck` — Type checking with `tsc -p tsconfig.json --noEmit` and `tsc -p test/tsconfig.json`.
- `pnpm test:fast` — Unit test suite execution covering all coordinator modules.

### Targeted Unit & Module Tests
- `test/machine.test.ts` — Verify that `decide()` automatically derives selections, reviser authorizations, and consensus declarations when input ballots are complete, without generating agent `prepare-action` decisions for mechanical steps.
- `test/runLoop.test.ts` — Verify end-to-end action lifecycle for consolidated review/compare steps, verifying that derived artifacts are written to disk and mirrored correctly, and that `durationMs` and timing events are journaled.
- `test/evidence.test.ts` — Verify schema validation, hash integrity, and choice verification for consolidated review-and-ballot artifacts, testing both valid submissions and invalid/malformed structures.
- `test/agentEvent.test.ts` — Verify that identical consecutive status events are debounced and do not append redundant journal lines, while real lifecycle transitions (start, idle, completion) continue to be recorded.
- `test/action.test.ts` — Verify front-matter rendering and parsing with optional `preparedAt` timestamp.
- `test/orderScaffold.test.ts` — Verify scaffold outputs for consolidated review and compare steps.

### Integration & Ship Gate Checks (`pnpm check`)
- `pnpm build` — Compile TypeScript to `dist/`.
- `pnpm test:e2e` — Full end-to-end multi-agent workflow simulations (solo, reviewed, and consensus profiles).
- `pnpm check:version-bump` — Verify package version strictly exceeds `origin/main`.

## Alternatives Rejected

1. **Solo Planning for Consensus Profile**: Eliminating multi-agent planning in favor of a single designated planner was rejected. Multi-agent independent planning and peer review are core to the consensus profile's defect prevention and architectural validation.
2. **Pure JSON Review without Markdown Findings**: Replacing human-readable markdown reviews with pure structured JSON ratings was rejected. Concrete review findings (file paths, invariant violations, concrete failure modes, and test sketches) are essential deliverables that guide the revision and finalize phases.
3. **Live Hook-driven Vendor Transcript Parsing**: Adding live parsing of vendor-private transcript files during coordinator execution was rejected. Live transcript parsing introduces fragile external filesystem coupling, format lock-in, and concurrency race conditions. Analytics remain cleanly decoupled via `coord analytics`.
4. **Stripping AGENTS.md Index Flags via Skip-Worktree Removal**: Modifying git index flags or removing `skip-worktree` in clones was rejected. The protocol deduplication must be solved upstream in the tracked source files and templates, preserving clone-local coordination protections.

## Risks and Mitigations

1. **Risk: Journal Schema Incompatibility with Historical Issues**
   - *Mitigation:* Ensure all new journal fields (`durationMs`, `action-timing`, `preparedAt`) are optional in Zod schemas. `src/analytics.ts` and `src/state.ts` will continue to read legacy issue journals without requiring migration or failing validation.
2. **Risk: Tie-Breaking Ambiguity in Coordinator-Derived Selections**
   - *Mitigation:* Retain the deterministic selection and tie-breaking algorithms in `runLoop.ts` (e.g., active roster precedence on tie) and add explicit unit tests asserting deterministic resolution for all tie conditions.
3. **Risk: Debouncing Dropping Vital Lifecycle State Changes**
   - *Mitigation:* Debounce only identical consecutive pure `status` observations (e.g. repeated `status-line/working`). All status-changing events (`idle`, `error`, `prompt-submitted`, `completed`) will immediately bypass debouncing and update lifecycle state.
4. **Risk: Loss of Evidence Transparency from Derived Steps**
   - *Mitigation:* The coordinator will write the derived JSON artifacts (`selection.json`, `reviser-authorization.json`, `consensus.json`) directly to the coordination runtime and mirror, computing input-set hashes and citations identical to agent-authored signals.

## Conclusion

This plan addresses the primary efficiency bottlenecks identified in the Issue 91 analytics:
- **`2N + 3` Model Actions Eliminated**: Deriving 3 mechanical steps coordinator-side and consolidating review and comparison steps saves 11 actions in a 4-agent consensus run.
- **Context & Prompt Size Reduction**: Deduplicating `AGENTS.md` cuts ~3.6 KB from every prompt turn across all agents, reducing cache-read volume across hundreds of turns.
- **Fast Codebase Discovery**: Introducing `docs/architecture-context.md` provides an immediate structural overview that reduces exploratory tool calls during early phases.
- **Coordinator Performance & Cleanliness**: Status debouncing removes 80%+ of repetitive journal events, and explicit action duration logging enables continuous verification of coordination efficiency.

# Implementation Plan: Keep coordinator internals out of agent prompts (Issue #88)

## Exact File List to be changed or deleted

- `src/steps.ts`:
  - Update `STEP_DEFINITIONS["R1.join"].task` to use outcome-oriented phrasing ("Publish the participation-readiness artifact for this issue...") rather than exposing internal phase nomenclature ("Publish the join artifact for this issue...").
  - Audit and ensure all `STEP_DEFINITIONS` task entries describe tasks purely by their required deliverables and outcomes.
- `src/action.ts`:
  - In `renderAction`, update the action markdown footer to remove delivery mechanisms ("nudge") and replace it with outcome-oriented recovery instructions:
    "Before waiting for more input, re-read this file. If `actionId` has changed, execute the new instructions immediately; do not wait for another coordinator message."
- `templates/product/AGENTS.protocol.md`:
  - Update the automated action protocol section to replace nudge-centric language with the clear outcome-oriented recovery instructions matching `action.md`.
- `package.json`:
  - Increment version from `0.0.13` to `0.0.14` to satisfy the branch ship gate in `test/versionBump.test.ts`.
- `test/action.test.ts`:
  - Update assertions on `renderAction` output to check for the new outcome-oriented footer.
  - Add comprehensive test suite inspecting every workflow step in `STEP_DEFINITIONS` across all profiles when rendered via `renderAction`, ensuring no internal phase IDs (`R1.`, `R2.`, `gate-`, `evidenceId`, `gateId`) or delivery jargon (`nudge`, `nudged`) leak into agent-visible prompts.

## Exact file list to be created

- None (all changes are modifications to existing files).

## Tests

- Unit tests in `test/action.test.ts`:
  - Verify `renderAction` across all `STEP_DEFINITIONS` produces no matches for phase prefixes (`/\bR\d+\./`, `/\bgate-\d+/i`, `/evidenceId/i`, `/gateId/i`).
  - Verify `renderAction` across all `STEP_DEFINITIONS` produces no matches for delivery terminology (`/\bnudges?\b/i`, `/\bnudged\b/i`).
  - Verify `renderAction` contains the updated footer: "Before waiting for more input, re-read this file. If `actionId` has changed, execute the new instructions immediately; do not wait for another coordinator message."
  - Verify `parseAction` and `writeAction` round-trip correctly with the updated action structure.
- Verification commands:
  - `pnpm check:fast`: Runs lint, typecheck, and fast tests.
  - `pnpm test` (`vitest run`): Runs the full test suite including `test/action.test.ts`, `test/install.test.ts`, `test/orderScaffold.test.ts`, `test/runLoop.test.ts`, and `test/versionBump.test.ts`.

## Alternatives Rejected

- Renaming internal state machine IDs (`R1.join`, `gate-1-join`, `join-published`): Rejected because coordinator state machines, analytics logs, journal entries, and operator diagnostics depend on stable internal identifiers. The issue explicitly mandates keeping internal IDs unchanged in coordinator state, code, journals, and operator-only logs.
- Completely removing the `action.md` footer recovery instruction: Rejected because agents need explicit instruction on how to handle action updates when polling or recovering without waiting indefinitely for incoming messages. Outcome-oriented wording provides this guidance without leaking delivery mechanisms.
- Changing JSON schema tokens in `src/protocol.ts`: Rejected because internal protocol discriminators (like `artifact: "join"`) in structured JSON signals are schema tokens rather than prompt prose, and altering them would break wire compatibility with existing tools and signals.

## Risks and Mitigations

- Risk: Existing tests asserting `action.md` or `AGENTS.md` text might fail due to string expectations.
  - Mitigation: Audited test references (`test/action.test.ts`, `test/install.test.ts`) and will update them to assert the new phrasing.
- Risk: Ship gate test requires package version increment on non-main branches.
  - Mitigation: Bump `package.json` version to `0.0.14` in the implementation phase so `test/versionBump.test.ts` passes.
- Risk: False positives or negatives in action text sanitization tests.
  - Mitigation: Write regex checks directly against rendered action bodies for every step in `STEP_DEFINITIONS`.

## Conclusion

This plan addresses all requirements of Issue #88 by replacing internal coordinator terminology in agent-facing tasks and action templates with clear, outcome-oriented language while leaving coordinator state machine, analytics, and operator logging completely intact.

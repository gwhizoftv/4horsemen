# Issue 121 — Keep agent plans and implementations simple and in scope

The coordinator should put a short, concrete discipline checklist in the two
places where it can change the result: while an agent is planning the work and
while an agent is implementing or revising the selected plan. The checklist
will use the existing action-scaffold renderer rather than add a new policy
layer, state field, configuration option, dependency, or enforcement system.

## Exact File List to be changed or deleted

- `src/orderScaffold.ts` — extend the existing phase-aware artifact scaffold
  renderer with compact planning and coding guidance.
  - For a plan action, require the smallest issue-bounded design, reuse of
    existing interfaces/helpers, a file map containing only necessary paths,
    justification for any new file/abstraction/dependency, and focused tests
    that extend nearby coverage and fixtures. Require the plan to name both a
    narrow feedback command and the repository's configured validation without
    weakening required checks.
  - For an implementation action, remind the agent that the issue and selected
    plan are the scope boundary; direct it to inspect and reuse existing code
    before adding a new surface; reject speculative refactors, dependencies,
    and flexibility; and request the minimum focused coverage in the nearest
    existing test location while still running all required checks.
  - Give a revision action the same implementation discipline, additionally
    limiting work to the requested correction and reuse of the accepted
    implementation.
  - Keep the text inside `renderArtifactScaffold` (factored through one small
    helper or constants as needed) so it is appended by the established action
    construction path and does not duplicate workflow state or action-rendering
    plumbing.
- `test/orderScaffold.test.ts` — extend the existing renderer unit tests to
  assert that plan, implementation, and revision scaffolds contain the relevant
  scope, reuse, and test-efficiency guidance. Also assert that an unrelated
  scaffold does not receive the coding checklist, preventing a global prompt
  expansion.

No tracked file is deleted.

## Exact file list to be created

None. The implementation deliberately reuses the existing scaffold renderer
and its existing unit-test file; it does not add a policy module, fixture, test
suite, configuration file, or documentation page.

## Tests

Run these real repository commands:

1. `pnpm exec vitest run --config vitest.config.ts test/orderScaffold.test.ts`
   for fast feedback on the only changed behavior.
2. `pnpm check:fast` before committing, as required by the repository. This
   runs lint, typecheck, and the fast test suite, including the agent-language
   invariant that scans rendered action text.
3. `pnpm check` for the coordinator's full approved-commit validation (build,
   fast checks, and end-to-end tests).

The focused unit assertions will cover:

- Plan output tells the agent to choose the smallest in-scope change, reuse
  existing code, justify new surfaces, and keep added tests focused and fast
  without omitting configured checks.
- Implementation output binds work to the issue and selected plan, prefers
  existing interfaces/helpers/tests/fixtures, and rejects speculative work.
- Revision output applies the same rules to only the requested correction.
- A non-coding action does not gain the implementation checklist.

No new end-to-end test or fixture is warranted: action assembly already has
coverage, while this change is a deterministic string-rendering branch fully
observable in the existing unit test.

## Alternatives Rejected

- **Add the advice only to the installed agent protocol.** That would make a
  permanent clone-wide block longer, repeat advice on unrelated ballots and
  reviews, and separate the reminder from the moment an agent makes planning
  or coding choices. Action-local guidance is narrower and more visible.
- **Expand each static task sentence independently.** Copying the checklist
  into plan, implementation, and revision definitions invites wording drift.
  The existing scaffold switch already owns action-specific instructions and
  can reuse one coding checklist.
- **Create hard limits on changed lines, file count, or test duration.** Fixed
  limits would reject legitimate larger issues and would require new state,
  configuration, and enforcement code. The approved file map already enforces
  path scope; this issue asks to improve agent decisions within that boundary.
- **Add a new lint rule, dependency, or standalone policy module.** The desired
  behavior is prompt content, so another runtime abstraction would itself
  violate the requested simplicity and reuse goals.
- **Remove broad repository validation to make tests faster.** Fast feedback
  should come from a focused command and proportional new coverage, not from
  skipping the configured precommit or final checks.

## Risks and Mitigations

- **The reminder becomes long enough to be ignored.** Use a short checklist
  with imperative language and render it adjacent to the existing plan or JSON
  scaffold, not as a general essay.
- **Minimalism is read as permission to omit necessary behavior or checks.**
  Say "smallest change that fully satisfies the issue," allow a new surface
  when the agent explains why existing ones cannot serve, and explicitly retain
  all configured validation.
- **Exact prose assertions become brittle.** Test stable concepts with a few
  characteristic substrings rather than snapshotting the entire action body.
- **The implementation reminder misses corrective coding work.** Reuse it for
  revision actions and add a focused revision assertion.
- **Guidance leaks into every action and increases prompt cost.** Return it only
  for plan, implementation, and revision scaffolds; cover an unrelated action
  with a negative assertion.
- **New wording violates the existing agent-language vocabulary rule.** Avoid
  internal coordinator terminology in rendered prose and rely on
  `pnpm check:fast` to exercise the existing invariant.

## Conclusion

Make one focused renderer change and extend one nearby unit-test file. Agents
will receive concise, timely instructions to stay within the issue and selected
plan, reuse existing code, avoid speculative abstractions, and add only
proportional focused tests while preserving required validation. This directly
addresses issue 121 without introducing a new policy subsystem or expanding
the product beyond two existing files.

# Plan — issue 121: emphasize simplicity, scope, efficiency, and reuse

The driver already owns every surface an agent reads: the rendered action body
(src/action.ts), the per-action task text and artifact scaffold
(`src/steps.ts`, `src/orderScaffold.ts`), the standing protocol overlay
(`templates/product/AGENTS.protocol.md`), and the artifact acceptance rules
(`src/evidence.ts`). Standing prose alone has already failed: agents skim it and
nothing rejects a plan that ignores it. So this change pairs one short piece of
prose with one mechanically enforced plan section, and fixes the one place where
citing reused code would otherwise widen what an implementation may touch.

Three parts:

1. **A required plan section, `## Reuse and Scope`.** A plan that does not name
   the existing functions, types, and helpers it builds on — and justify each
   new file — is rejected the same way a plan missing `## Tests` is today. The
   agent must state its reuse claim before implementing, and peer reviews and
   ballots then have a concrete claim to attack.
2. **A build-discipline note on the plan, implement, and revise actions.** One
   constant, interpolated into three task strings, so the smallest-change rule
   is in front of the agent at the moment it writes code, not only in a file it
   read once.
3. **Reuse citations must not widen the approved path ceiling.**
   `extractApprovedPaths` turns every backticked path in a plan into a path the
   implementation is allowed to change. Without a fix, an agent that cites five
   reused modules in its new section silently earns permission to rewrite them —
   the opposite of scope discipline. Path extraction skips the reuse section;
   the two file lists stay the sole authority.

## Exact File List to be changed or deleted

- `src/evidence.ts` — add `["Reuse and Scope", "Reuse", "Scope and Reuse"]` to
  the required-section list in `checkPlan`, yielding the outstanding item
  `plan is missing a non-empty Reuse and Scope section`. Add a line-scanning
  `stripSections(raw, headings)` helper that drops a named heading and its body
  up to the next ATX heading, and have `extractApprovedPaths` scan
  `stripSections(raw, REUSE_SECTION_HEADINGS)` instead of `raw`.
- `src/steps.ts` — add an exported `BUILD_DISCIPLINE_NOTE` constant beside
  `BRANCH_PREPARED_NOTE`, and interpolate it into the `task` strings of the
  plan, implement, and revise entries of `STEP_DEFINITIONS`. No change to
  src/runLoop.ts: it already composes definition.task into the action body.
- `src/orderScaffold.ts` — in the plan branch of `markdownHeadingScaffold`, list
  `## Reuse and Scope` (aliases `Reuse` / `Scope and Reuse`) between the two file
  lists and `## Tests`; state that the section names reused functions, types, and
  test helpers and justifies each new file, and that paths cited there do not
  widen what the implementation may change. Add one sentence under the tests
  heading asking for the fewest tests that fail before the change and pass after
  it, and the existing test file each joins. Add one scope-and-reuse criterion
  sentence to the review branch and one to the comparison branch.
- `templates/product/AGENTS.protocol.md` — add `## Reuse and Scope` to the plan
  heading block, extend the accepted-aliases sentence, and add a short build
  discipline paragraph carrying the same rule as `BUILD_DISCIPLINE_NOTE`.
- `test/evidence.test.ts` — extend the existing split-file-list case with a
  `## Reuse and Scope` section citing a module that appears in no file list, and
  assert `approvedPaths` still equals the two listed paths. Add one case: a plan
  with every other required heading and no reuse section is `rejected` with the
  new outstanding item.
- `test/orderScaffold.test.ts` — extend the existing plan-heading assertion with
  `## Reuse and Scope`.
- `test/install.test.ts` — extend the existing clone-overlay assertion with
  `## Reuse and Scope`, so the installed overlay and the action scaffold cannot
  drift apart.
- `test/integration.test.ts` — add the reuse section to the plan fixture the
  canary submits, so the end-to-end run still reaches acceptance.

## Exact file list to be created

None. Every change lands in a file that already owns the concern: acceptance
rules in evidence, action text in steps and the scaffold, standing prose in the
protocol template, and each test case in the existing file that covers its
module. Adding a module or a test file for this change would itself be the
behavior the issue is asking to stop.

## Reuse and Scope

Reused as-is, with no new abstraction:

- `markdownSection` in `src/evidence.ts` — the new required section is one more
  entry in the existing `required` list, matched by the existing regex builder.
  No new validation function, and no change to `checkReview`.
- The existing `required`-list-to-outstanding-message mapping in `checkPlan` —
  the new message is produced by the same `.filter().map()`, so no message
  plumbing changes.
- `BRANCH_PREPARED_NOTE`'s pattern in `src/steps.ts` — one exported string
  constant composed into task text. `BUILD_DISCIPLINE_NOTE` follows it exactly,
  which is why src/runLoop.ts needs no edit.
- `markdownHeadingScaffold` in `src/orderScaffold.ts` — the plan, review, and
  comparison branches already exist; this adds lines inside them and no new
  branch or exported function.
- `applyDelimitedBlock` and `renderAgentsProtocolBlock` in
  src/agentsProtocol.ts — the protocol template is already rendered and
  refreshed into clones on install and reinstall, so a template edit reaches
  every clone with no new code.
- test/support/workspaceFixture.ts and the per-file `order()` / `mirror()`
  helpers already in `test/evidence.test.ts` — the one new case uses them; no
  new fixture or helper.

New surface introduced: one exported constant, one module-private helper
(`stripSections`) with its heading list, and one entry in an existing list.
`stripSections` is justified because no existing helper removes a section from
plan markdown, and `extractApprovedPaths` must not see the reuse section: it is
the single change that keeps the approved path ceiling honest once plans start
citing code they do not touch.

## Tests

Run `pnpm check:fast` (lint, typecheck, fast tests) before each commit; the
coordinator runs `pnpm check` on the approved commit.

Net new test cases: **one**. Everything else is an assertion added to a case
that already runs, so the fast suite grows by roughly one case, not one file.

- `test/evidence.test.ts`, new case "rejects a plan that omits the reuse and
  scope section": a plan carrying both file lists, tests, alternatives, risks,
  and conclusion but no reuse section returns `status: "rejected"` with
  `outstanding` containing `plan is missing a non-empty Reuse and Scope section`.
  This is the rule the whole change rests on; without it the section is optional
  in practice.
- `test/evidence.test.ts`, existing case "accepts the split changed/created
  file-list headings": add a reuse section citing `` `src/existing-helper.ts` ``
  and keep the expectation `approvedPaths: ["src/product.ts",
  "test/product.test.ts"]`. One assertion proves both that the new section is
  accepted and that its citations do not widen the ceiling.
- `test/orderScaffold.test.ts`, existing plan-heading case: one added
  `toContain("## Reuse and Scope")`, so the scaffold cannot omit a heading that
  acceptance requires.
- `test/install.test.ts`, existing clone-overlay case: one added `toContain`,
  so the overlay and the scaffold state the same contract.
- `test/integration.test.ts`, existing canary: fixture text only, no new case
  and no added run time.

Existing coverage that must stay green without modification:
`findAgentLanguageViolations` over the protocol template and rendered action
bodies (the new prose avoids internal vocabulary), and the `runLoop`
brace-expansion cases, whose fixtures carry no reuse section and are therefore
untouched by the extraction change.

## Alternatives Rejected

- **Prose only — add the discipline note and change nothing else.** Cheapest,
  and already disproven: the protocol overlay has told agents to follow the plan
  contract from the start, and the failure the issue reports happened anyway.
  Nothing rejects a plan that ignores advisory prose, so nothing changes.
- **A coordinator-side cap on diff size, file count, or test count.** Any
  threshold is arbitrary: it rejects a legitimately large change and accepts a
  bloated small one, since it cannot tell a needed file from a redundant one. It
  also adds a new refusal path through state, the journal, and reissue handling
  for no measurable gain.
- **A required reuse section in reviews and comparisons too.** Duplicates the
  plan section and adds two more heading contracts to keep in sync across the
  template, the scaffold, and acceptance. One added criterion sentence in each
  review scaffold gets the same reviewer attention at a fraction of the cost.
- **Leaving `extractApprovedPaths` alone and telling agents not to backtick
  reused paths.** Relies on formatting discipline for a security-shaped
  property. The first plan that cites a reused module in backticks quietly grants
  permission to rewrite it, and nothing reports that it happened.
- **A dedicated test file for the new section.** Adds a file and its startup
  cost to every fast run, which is exactly the growth the issue names.

## Risks and Mitigations

- **In-flight plans written before this change are rejected.** The outstanding
  item names the exact heading, the reissued action carries it under the
  corrections list, and the scaffold in that action lists the heading with its
  aliases — so the fix is adding one section, not rewriting the plan. Accepted
  as the intended cost of a mechanically enforced contract.
- **`stripSections` hides a path the agent genuinely means to change.** The two
  file lists remain the only source of approved paths, and the scaffold says so
  in the same paragraph that introduces the section, so a path that matters is
  listed where it counts. A path cited only under reuse was never a declared
  change.
- **Heading text drifts between the template, the scaffold, and acceptance.**
  The added assertions in `test/orderScaffold.test.ts` and `test/install.test.ts`
  pin the scaffold and the installed overlay to the same heading that
  `test/evidence.test.ts` pins acceptance to.
- **New agent-facing prose trips the agent-facing language rule.** The added
  text uses no workflow-internal vocabulary, and the existing language scan over
  the protocol template and rendered action bodies fails the build if it does.
- **This repository's tracked AGENTS.md keeps an older copy of the plan
  contract.** That file carries the skip-worktree bit in agent clones and must
  not be edited from one, so it is deliberately absent from the file lists above.
  The text agents actually read is the overlay rendered from the protocol
  template, refreshed on install and reinstall, and the per-action scaffold is
  authoritative when the two disagree.
- **Reuse claims could become box-ticking prose.** Reviews and ballots are the
  backstop: the added criterion sentence makes an unjustified new file a finding
  rather than a matter of taste, and the plan's reuse claim is now a concrete
  statement a reviewer can check against the file lists.

## Conclusion

Three coordinated edits in four source files, plus assertions in four existing
test files and one new test case. The required `## Reuse and Scope` section
makes reuse and scope a condition of acceptance rather than advice; the build
discipline note puts the smallest-change rule in front of the agent while it
writes plans, implementations, and revisions; and skipping that section during
path extraction keeps the approved path ceiling exactly as tight as the declared
file lists. No new modules, no new test files, and no new refusal paths in the
coordinator.

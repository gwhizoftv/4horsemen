# Issue 92 implementation plan: versioned efficient workflow

The issue-88 analytics baseline makes the first optimization target concrete. A
four-agent consensus run took 13 phases and 37 model actions; the join and three
mechanically copied publications consumed turns without adding judgment, while
the separate review/ballot and comparison/ballot pairs reread immutable inputs.
For new runs, this plan reduces the workflow to seven phases and 22 model
actions while retaining four independent plans, implementations, comparisons,
and consensus votes. Existing runtime files continue on the current workflow.

## Exact File List to be changed or deleted

- `package.json` — bump the pre-1.0 package version from 0.0.14 to 0.0.15 so
  branch verification passes the ship gate.
- `src/steps.ts` — define legacy workflow version 1 and efficient workflow
  version 2, keep every legacy step/evidence definition readable, and return
  profile sequences by version. Version 2 sequences are: consensus = plan,
  combined plan review/choice, implementation, combined comparison/choice,
  revision, consensus ballot, finalization; reviewed = plan, combined plan
  review/choice, implementation, finalization; solo = plan, implementation,
  finalization. Add helpers that identify the accepted step containing the plan
  or implementation choice for each workflow version.
- `src/state.ts` — add `workflowVersion` to start state independently of the
  runtime file format. Parsing a historical start file with no field supplies
  version 1; creating a new start defaults to version 2. Initialize version-2
  cursors at the plan step rather than the join step, and journal the chosen
  workflow version in the `started` record.
- `src/machine.ts` — select and normalize the step sequence using the persisted
  workflow version. The version-2 machine must skip join, standalone plan
  ballot/selection, standalone comparison ballot/authorization, and consensus
  declaration, while the version-1 decision graph remains byte-for-byte
  compatible in behavior. Existing in-flight version-1 actions therefore
  remain verifiable on resume.
- `src/runLoop.ts` — bind a companion ballot path to version-2 review and
  comparison orders; tally choices from those accepted combined actions; and,
  in the same locked transition that advances the gate, persist the selected
  plan, implementation agent/pin, and reviser. Put the exact source submission
  SHAs, choices, winner, and consensus pin in the `gate-advanced` journal
  details so coordinator-derived decisions remain auditable without synthetic
  Git commits. Version-2 finalization binds the accepted revision pin directly;
  legacy declarations and reviewed/solo implementation pins remain supported.
- `src/evidence.ts` — for a version-2 plan review, validate both the Markdown
  review and its same-commit plan-ballot sidecar against the exact bound plan
  set; for a version-2 comparison, validate both the Markdown comparison and
  its same-commit comparison-ballot sidecar against every implementation pin.
  Return the validated choice in the accepted submission. Missing, malformed,
  stale-hash, incomplete-citation, and ineligible-choice sidecars must be
  reported together with all Markdown defects in one correction action. Keep
  standalone version-1 validators unchanged.
- `src/orderScaffold.ts` — render the existing review/comparison heading
  requirements plus the exact companion sidecar path and a fully bound JSON
  scaffold. Reuse the existing protocolVersion-1 ballot shapes: an efficient
  plan sidecar cites all plans and an empty reviews list because its choice is
  frozen with the independent review; an efficient comparison sidecar cites
  the same implementation set already bound to the comparison.
- `src/cli.ts` — make roster-drop rederivation choose the version-appropriate
  combined or standalone ballot source. If a selected agent is dropped before
  authorization becomes immutable, recompute using only accepted active-agent
  choices and retain the existing deterministic active-roster tie break.
- `src/analytics.ts` — derive the first interval from `workflowVersion` so a
  version-2 journal starts at planning instead of inventing an R1.join
  interval. Continue reading historical journals as version 1 and keep all
  phase, wait, token, and tool attribution rules unchanged.
- `docs/coord-driver.md` — document the version-2 phase graph, combined
  Markdown-plus-sidecar evidence, coordinator-derived transitions, action-count
  formulas, audit fields, and version-1 resume compatibility.
- `docs/analytics.md` — record the measured issue-88 baseline, the 13-to-7 phase
  and 37-to-22 action hypothesis, and the exact post-release analytics command
  used to compare later completed consensus runs.
- `test/state.test.ts` — cover historical defaulting to workflow version 1,
  explicit version round trips, new version-2 initialization at planning, and
  started-journal identity.
- `test/machine.test.ts` — retain the legacy 13-step assertions and add exact
  version-2 solo/reviewed/consensus sequences, participant counts, revision
  loops, single-agent degradation, and the absence of clerical actions.
- `test/orderScaffold.test.ts` — assert the companion paths, complete bound JSON
  values, empty plan-review citation list, implementation citations, and no
  placeholder digest or citation in combined actions.
- `test/evidence.test.ts` — test successful atomic Markdown-plus-sidecar
  acceptance and rejection for a missing sidecar, wrong input-set hash, omitted
  pin, stale issue/session/agent, and inactive choice; retain all standalone
  artifact coverage for version 1.
- `test/runLoop.test.ts` — verify deterministic transition state and journal
  evidence, direct consensus-pin binding, active-roster tie breaks, drop
  rederivation inputs, and legacy order reconstruction.
- `test/analytics.test.ts` — verify that version-2 reports begin at planning and
  count seven completed consensus intervals without regressing version-1 or
  in-progress interval handling.
- `test/cli.test.ts` — assert that a newly started issue persists workflow
  version 2 and that drop/resume/status behavior uses the persisted version.
- `test/integration.test.ts` — exercise a complete version-2 consensus run with
  one successful revision: exactly 22 accepted actions, seven gates, no join or
  standalone transform artifacts, correct winning pins, successful checks, and
  publication. Also resume a version-1 fixture to prove compatibility.
- `test/agentLanguage.test.ts` — scan the new combined action bodies and
  correction text so internal step/gate/evidence vocabulary still cannot leak
  to agents.
- `test/support/workspaceFixture.ts` — let tests explicitly create version-1 or
  version-2 starts while keeping fixture construction deterministic.

No tracked file is deleted. In particular, AGENTS.md and the installed hook
tree are not modified; the clone-local skip-worktree protocol remains intact.

## Exact file list to be created

None. The efficient mode reuses the existing Markdown and ballot paths and the
existing runtime state files; it does not add generated repository context,
new product-tree artifacts, or a second audit store.

## Tests

1. Run focused state-machine and evidence coverage during implementation:
   `pnpm vitest run --config vitest.config.ts test/state.test.ts test/machine.test.ts test/orderScaffold.test.ts test/evidence.test.ts test/runLoop.test.ts test/analytics.test.ts test/cli.test.ts test/agentLanguage.test.ts`.
2. Run `pnpm check:fast` before every implementation commit. This executes the
   repository's lint, typecheck, and fast-test contract and enforces the 0.0.15
   version bump on the issue branch.
3. Run `pnpm check` before publishing implementation evidence. This adds the
   build and end-to-end suite required by the coordinator's configured check
   gate.
4. In integration assertions, count journal events and accepted submissions,
   not merely the configured arrays: a four-agent version-2 consensus run with
   one approval round must produce seven completed phase intervals and 22
   accepted model actions, while the version-1 fixture remains at 13 and 37.
5. After a later real version-2 issue completes, run
   `node dist/main.js analytics --issue <issue> --coord-root <runtime-root>` and
   compare phase count, action counts, time, per-agent waits, and supported
   token/tool sections with issue 88. This is a post-release effectiveness
   check, not a substitute for deterministic tests.

## Alternatives Rejected

- **Build a generated context index first.** The analytics show that cache-read
  input dominates and that each extra turn rereads the cached prefix. A large
  context packet can add input tokens and staleness without removing a gate.
  Context retrieval should be evaluated after the lower-risk turn reduction is
  measurable.
- **Reduce the number of independent implementations or reviewers.** That
  attacks the most expensive phases but silently weakens the meaning of the
  consensus profile. Version 2 preserves the active roster at every judgment
  step; adaptive top-k work needs an explicit future owner policy.
- **Keep reviews and choices in two prompts but shorten the second prompt.** A
  short prompt still incurs another model turn, cached-prefix read, commit,
  push, and receipt. The sidecar lets the same accepted commit carry human
  analysis and its machine-readable decision.
- **Embed ballot JSON inside Markdown.** Extracting a fenced block is more
  ambiguous and harder to correct than reading a strict sidecar at an exact
  path. The existing ballot schemas and cleanup allowlist already support the
  sidecars.
- **Delete all legacy steps and schemas.** Runtime state is durable and `resume`
  must not become unreadable after upgrading the driver. Persisted workflow
  versioning confines compatibility without keeping clerical steps in new runs.
- **Have the coordinator author commits in each clone.** Coordinator-derived
  runtime state and journal evidence provide the same transient audit value
  without new Git credentials, peer-branch mutation, or synthetic commits that
  finalization immediately deletes.
- **Trim the clone-local AGENTS.md in this issue.** That file is deliberately
  skip-worktree and the repository protocol forbids clearing the bit or
  replacing the file to fix prompt duplication. This implementation reduces
  turns without violating that boundary.

## Risks and Mitigations

- **Risk: combining plan review and choice removes the later opportunity to
  read peer reviews.** Mitigation: bind every plan directly, require an
  actionable independent review plus a choice in the same commit, and retain
  four votes and deterministic ties. Document this intentional independence;
  do not claim the sidecar cited reviews it could not have seen.
- **Risk: a partial combined commit could advance on Markdown alone.**
  Mitigation: the evidence evaluator reads both paths at the submitted SHA and
  returns one acceptance only after both validators pass. It accumulates all
  failures before reissuing the same action.
- **Risk: coordinator-derived selections could become unauditable or disagree
  with drop handling.** Mitigation: use one deterministic tally helper for
  transition and drop paths, persist the result in cursor state, and journal
  exact source SHAs/choices/result with the gate transition under the existing
  state lock.
- **Risk: removing join hides an unavailable CLI.** Mitigation: branch setup
  remains coordinator-owned and the first substantive plan action exercises the
  same delivery, lifecycle watchdog, harness-gone, retry, and explicit-drop
  paths. A model-authored constant JSON did not add a stronger availability
  proof.
- **Risk: old runtime state fails after upgrade.** Mitigation: missing
  `workflowVersion` parses as 1; all old step definitions, paths, schemas, and
  order reconstruction remain; only newly initialized states default to 2.
- **Risk: analytics misattributes the initial phase or overstates savings.**
  Mitigation: select the first phase from persisted workflow version, assert
  journal/action counts in integration tests, and treat the issue-88 comparison
  as a hypothesis until another real completed run is measured.
- **Risk: version-2 finalization binds the wrong revision round.** Mitigation:
  bind only the accepted revision for the unanimously approved current round,
  include that pin in the derived gate audit details, and test multiple revise
  rounds and stale prior pins.

## Conclusion

Implement a backward-compatible, versioned efficient workflow that removes
constant join work, combines analysis with its structured choice, and lets the
coordinator perform deterministic selection/authorization/declaration. It cuts
15 of 37 model actions in a normal four-agent consensus run without reducing
independent planning, implementation, comparison, or final approval, and it
leaves exact journal evidence so the new analytics can verify the real savings.

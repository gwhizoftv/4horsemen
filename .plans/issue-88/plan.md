# Implementation plan — issue 88: keep coordinator internals out of agent prompts

## Problem restated in mechanical terms

Three agent-facing surfaces are generated from this repository:

1. the rendered action.md body (`src/action.ts` `renderAction`, fed by
   `src/steps.ts` task prose, `src/orderScaffold.ts` scaffolds, the
   `Correct these outstanding items:` block in `src/runLoop.ts`, and the
   `outstanding` strings produced by `src/evidence.ts`),
2. the typed injection text (`src/tmux.ts` `renderNudgeText`), and
3. the clone-local protocol overlay (`templates/product/AGENTS.protocol.md`,
   `templates/product/AGENTS.md`, installed by `src/agentsProtocol.ts`).

Concrete leaks found by audit:

- `src/steps.ts:66` — task prose `Publish the join artifact for this issue.`
  names the internal step `R1.join`.
- `src/steps.ts:64` — required path `.signals/issue-<n>/joined-<agent>.json`
  encodes the phase name in an agent-visible path.
- `src/orderScaffold.ts:53` and `src/protocol.ts:32` — schema token
  `"artifact": "join"` is the phase name in an agent-authored file.
- `src/evidence.ts:211` — `subject: \`${order.evidenceId} artifact\`` puts the
  internal evidence id (`join-published`, `implementation-pinned`, …) verbatim
  into `pinValidation` `details`, which `src/runLoop.ts:307` renders back to the
  agent under `Correct these outstanding items:`.
- `src/evidence.ts:280,282,283` — rejection prose `invalid join artifact`,
  `join baselineSha …`, `join automationDigest …`.
- `src/action.ts:59` — footer `execute the new action even if you were not nudged.`
- `templates/product/AGENTS.protocol.md:23-24` — `without a typed nudge` and
  `this watch is how you recover when a nudge did not land.`
- `templates/product/AGENTS.md:41` — `R7 finalization is deletion-only cleanup`.

Everything else that carries `R1.join`, `gate-1-join`, `join-published`,
`nudged`, or round/phase vocabulary lives in coordinator state, the journal,
analytics, CLI operator output, and docs. Those are explicitly required to stay
(`src/state.ts:35-47`, `src/analytics.ts:150-180`, `src/cli.ts`,
`docs/analytics.md`, `docs/coord-driver.md`) and this plan does not touch them.

## Exact File List to be changed or deleted

Nothing is deleted. The following files are edited.

1. `src/steps.ts`
   - `STEP_DEFINITIONS["R1.join"].requiredPath` becomes
     `(issue, agent) => \`.signals/issue-${issue}/participation-ready-${agent}.json\``.
   - `STEP_DEFINITIONS["R1.join"].task` becomes
     `"Publish the participation-readiness artifact for this issue. Coordination already checked this clone out on your issue branch; do not clear skip-worktree on AGENTS.md or switch branches to make checkout work."`
   - No other `task` string changes: `plan`, `review`, `ballot`, `selection`,
     `implement`, `comparison`, `revision`, `consensus`, and `finalize` describe
     the actual deliverable, which issue 88 explicitly permits.
   - `WorkflowStepId`, `GateId`, `EvidenceId`, `describeWorkflowStep`, and the
     per-profile step lists are unchanged.

2. `src/protocol.ts`
   - Rename `joinArtifactSchema` to `participationReadyArtifactSchema` with
     `artifact: z.literal("participation-ready")`; the remaining fields
     (`baselineSha`, `automationDigest`, `commonArtifactFields`, `.strict()`)
     are unchanged.
   - Replace the `joinArtifactSchema` member of `publishedArtifactSchema`
     (line 143) with the renamed schema.
   - Rename exported type `JoinArtifact` to `ParticipationReadyArtifact`.
   - No legacy `"join"` literal is retained; see Alternatives Rejected.

3. `src/orderScaffold.ts`
   - `case "R1.join"` emits `artifact: "participation-ready"` (line 53). The
     `case` label itself stays `"R1.join"` because it is internal.

4. `src/evidence.ts`
   - Import `participationReadyArtifactSchema` instead of `joinArtifactSchema`
     (line 9) and parse with it (line 279).
   - Rejection strings become
     `invalid participation-readiness artifact: ${parsed.error}`,
     `participation-readiness baselineSha does not match the issue baseline`,
     `participation-readiness automationDigest does not match` (lines 280-283).
   - `pinErrors` (line 211) passes
     `subject: agentFacingSubject(order.evidenceId)` from the new module instead
     of `\`${order.evidenceId} artifact\``.
   - The `if (order.evidenceId === …)` dispatch chain is untouched: the internal
     ids remain the switch keys.

5. `src/action.ts`
   - Replace the closing paragraph of `renderAction` (lines 58-59) with the
     wording issue 88 specifies:
     `Before waiting for more input, re-read this file. If \`actionId\` has changed, execute the new instructions immediately; do not wait for another coordinator message.`
   - No change to front matter, `parseAction`, `parseCompletion`, or
     `writeAction`.

6. `templates/product/AGENTS.protocol.md`
   - Rewrite the paragraph at lines 20-24 as: `After you write \`complete\`,
     do not stop. Re-read your \`action.md\`. If \`actionId\` in the front matter
     has changed, execute the new instructions immediately; do not wait for
     another coordinator message.` The words `nudge`/`typed nudge` are removed
     from both occurrences. The block appears twice in the installed overlay
     because the template repeats the plans/reviews section; both copies are
     updated identically.
   - The phrase `If \`actionId\` in the front matter has changed` is preserved
     verbatim so `test/install.test.ts:125` stays meaningful.

7. `templates/product/AGENTS.md`
   - Line 41: `R7 finalization is deletion-only cleanup of exactly those paths`
     becomes `The final cleanup step deletes exactly those paths`.

8. `docs/coord-driver.md`
   - Add a short subsection under the existing delivery section documenting the
     boundary: internal step ids, gate ids, evidence ids, and delivery
     vocabulary stay in state, journal, analytics, and operator output; the
     generated action.md, the injected text, and the installed protocol
     overlay must pass `findAgentLanguageViolations`. Points at
     `src/agentLanguage.ts` as the single list. No existing operator-facing
     `R1.join`/nudge documentation is removed.

9. `package.json`
   - Bump `version` from `0.0.13` to `0.0.14`. Required: on a non-`main` branch
     `pnpm check:fast` fails unless the version is strictly greater than
     `origin/main`, which is currently also `0.0.13`.

10. `test/action.test.ts`
    - Line 44 assertion `expect(raw).toContain("If \`actionId\` in the front matter")`
      becomes `expect(raw).toContain("If \`actionId\` has changed")`.
    - Add `expect(findAgentLanguageViolations(raw)).toEqual([])`.

11. `test/protocol.test.ts`
    - Lines 17-26: rename the fixture to `participation` with
      `artifact: "participation-ready"` and assert through
      `participationReadyArtifactSchema`.

12. `test/orderScaffold.test.ts`
    - Lines 24 and 30: expect `artifact: "participation-ready"` and
      `'"artifact": "participation-ready"'`.

13. `test/evidence.test.ts`
    - Line 64: sample path becomes
      `.signals/issue-1/participation-ready-codex.json`.
    - Lines 242-256: `requiredPath` and the artifact blob use the new path and
      the new `"participation-ready"` token; the test name becomes
      "checks participation-readiness session, baseline, and digest fields".
    - Add one case asserting that a pin-lineage rejection message does not
      contain the evidence id: build an order with
      `evidenceId: "implementation-pinned"`, force `validatePhasePin` to fail in
      the stub mirror, and assert the returned `outstanding[0]` contains
      `the implementation signal` and not `implementation-pinned`.

14. `test/runLoop.test.ts`
    - Line 324: `.signals/issue-1/participation-ready-codex.json`.
    - Line 326: `'"artifact": "participation-ready"'`.
    - Line 352: seeded accepted `path` becomes
      `.signals/issue-1/participation-ready-${agent}.json`.
    - Line 653: stub blob `artifact: "participation-ready"`.
    - Line 325 (`not.toContain("gate-1-join")`) is kept as-is.

15. `test/cli.test.ts`
    - Line 332: `requiredPath: .signals/issue-1/participation-ready-codex.json`.

16. `test/install.test.ts`
    - Add `expect(findAgentLanguageViolations(agentsMd)).toEqual([])` beside the
      existing overlay assertions (after line 128).

17. `test/integration.test.ts`
    - Line 163: `commonArtifact(order, "participation-ready")`.
    - After `expectStep("R1.join")`, assert the live rendered order body passes
      `findAgentLanguageViolations`.

## Exact file list to be created

1. `src/agentLanguage.ts` — the single source of truth for the agent-facing
   language rule. Exports:

   - `type BannedTerm = { readonly label: string; readonly pattern: RegExp }`
   - `AGENT_FACING_BANNED_TERMS: readonly BannedTerm[]`, each `RegExp` built
     with the `g` flag stripped at match time (matching uses a fresh
     `RegExp(pattern.source, "i")` so the module-level objects stay stateless):
     - `internal-step-id` — `/\bR[1-7]\.[a-z][a-z-]*/i`
     - `internal-round-label` — `/\bR[1-7]\b/`
     - `gate-id` — `/\bgate-[1-7]\b/i`
     - `gate-vocabulary` — `/\bgates?\b/i`
     - `phase-vocabulary` — `/\bphases?\b/i`
     - `delivery-vocabulary` — `/\bnudg[a-z]*\b/i`
     - `join-vocabulary` — `/\bjoin(ed|ing)?\b/i`
     - `evidence-id` — `/\b[a-z]+(?:-[a-z]+)*-(published|pinned|authorized|declared|verified)\b/`
     - `internal-field-name` — `/\b(stepId|gateId|evidenceId)\b/`
   - `findAgentLanguageViolations(text: string): readonly string[]` — returns
     one `"<label>: <matched text>"` entry per distinct match, sorted, empty
     when clean.
   - `agentFacingSubject(evidenceId: EvidenceId): string` backed by an
     exhaustive `Record<EvidenceId, string>`:
     `join-published → "the participation-readiness artifact"`,
     `plan-published → "the plan"`,
     `review-published → "the plan review"`,
     `plan-ballot-published → "the plan ballot"`,
     `selection-published → "the plan selection"`,
     `implementation-pinned → "the implementation signal"`,
     `comparison-published → "the comparison"`,
     `comparison-ballot-published → "the comparison ballot"`,
     `reviser-authorized → "the revision authorization"`,
     `revision-pinned → "the revision signal"`,
     `consensus-ballot-published → "the consensus ballot"`,
     `consensus-declared → "the consensus declaration"`,
     `finalization-verified → "the finalization signal"`.

   The module imports only `type { EvidenceId }` from `./steps.js`, so it adds
   no runtime dependency and no import cycle (`steps.ts` imports nothing).

2. `test/agentLanguage.test.ts` — the enforcement suite. It builds the same
   runtime fixture that `test/runLoop.test.ts:36-67` uses (`issueRuntimePaths`,
   `createIssueRuntime`, `initializeOperationalState` with profile
   `consensus`), then:

   - **every generated action type**: for each of the 13 `WorkflowStepId`
     values, call `buildOrder(paths, start, cursors, "codex", stepId, round)`
     (`round = 1` for the four `R6.*` steps, otherwise `null`), render with
     `renderAction`, and assert `findAgentLanguageViolations(rendered)` is
     empty. The loop is driven by `Object.keys(STEP_DEFINITIONS)` so a new step
     cannot be added without being covered.
   - **the same 13 steps with inputs bound**: repeat against a cursors state
     seeded with accepted submissions for `R2.plan`, `R3.review`,
     `R3.plan-ballot`, `R4.implement`, `R5.compare-ballot`, and `R6.revise`, so
     the JSON scaffolds render their citation bodies and the correction block is
     exercised via a non-empty `outstanding` argument.
   - **the correction block**: `buildOrder(..., outstanding)` with every value of
     `agentFacingSubject` embedded in a representative `pinValidation`-shaped
     sentence, asserting the rendered body stays clean.
   - **the injected text**: `renderNudgeText("/runtime/issue-1/agents/codex/action.md", uuid, digest)`
     and its two shorter forms pass the checker.
   - **the installed overlay**: `renderAgentsProtocolBlock(repoRoot)` and
     `templates/product/AGENTS.md` read from disk pass the checker.
   - **every subject string**: each value of the `Record<EvidenceId, string>`
     passes the checker, and the record has an entry for all 13 evidence ids.
   - **positive control** (guards against a checker that never fires): the
     checker reports violations for `"R1.join"`, `"gate-1-join"`,
     `"execute the new action even if you were not nudged"`,
     `"join-published artifact"`, and `"the current phase"`.
   - **internal vocabulary survives**: assert `STEP_DEFINITIONS["R1.join"].evidenceId`
     is still `"join-published"` and `.gateId` is still `"gate-1-join"`, i.e. the
     rename is confined to agent-facing surfaces.

## Tests

Commands, run from the repository root:

- `pnpm check:fast` — `pnpm lint` (eslint over `src` and `test`), `pnpm typecheck`
  (`tsc -p tsconfig.json --noEmit` and `tsc -p test/tsconfig.json`), and
  `pnpm test:fast` (`vitest run --config vitest.config.ts`, i.e. everything in
  the test/ directory except `test/integration.test.ts`). This is `verify.precommit` and
  must pass before each commit. It also enforces the `package.json` version bump
  against `origin/main`.
- `pnpm test:e2e` — `vitest run --config vitest.e2e.config.ts`, which is
  `test/integration.test.ts` only. Required because the artifact-token rename
  changes what the end-to-end run submits at `R1.join`.
- `pnpm check` — `pnpm build` then `pnpm check:fast` then `pnpm test:e2e`. This
  is the coordinator `checks` gate; run it before publishing the implementation
  signal.

New coverage added by this change:

- `test/agentLanguage.test.ts` as specified above. The step-id-driven loop is
  the acceptance criterion "tests inspect every generated action type" made
  mechanical: adding a `WorkflowStepId` without cleaning its prose fails.
- `test/evidence.test.ts` gains the pin-lineage case proving `evidenceId` no
  longer reaches `outstanding`.
- `test/install.test.ts` gains an overlay scan, so a future edit to
  `templates/product/AGENTS.protocol.md` that reintroduces `nudge` fails.

Existing coverage that must keep passing unchanged in intent:
`test/action.test.ts` front-matter restriction, `test/cli.test.ts` `coord next`
rendering, `test/runLoop.test.ts` ordering and reissue behaviour,
`test/analytics.test.ts` (proves `nudged` journal events and `R1.join` step
names still exist for the operator), and `test/state.test.ts` (proves the
`WorkflowStepId` enum is unchanged).

## Alternatives Rejected

- **Reword `renderNudgeText` in `src/tmux.ts`.** Rejected. The injected text is
  parsed back by `actionPromptPattern` in `src/agentEvent.ts:19-21`, which
  requires the literal `coordinator action <uuid> digest <sha256> at <path>`.
  Changing the wording means changing the matcher, and any agent that was
  nudged before the upgrade would emit a prompt the new matcher rejects,
  silently breaking lifecycle observation and duplicate-injection suppression
  mid-issue. The current text contains no phase id, gate, or delivery
  vocabulary, so it already satisfies the acceptance criterion; the plan pins
  that with a test instead of a rename.

- **Throw from `renderAction` when the body contains a banned term.** Rejected.
  `outstanding` strings can carry git output, branch names, and agent ids
  supplied from outside this module; a false positive would abort the run loop
  and strand the issue rather than degrade a sentence. The checker is therefore
  a test-time invariant plus an exported function, not a runtime guard.

- **Keep a legacy `artifact: "join"` schema alongside the new literal.**
  Rejected. `R1.join` is the only consumer, its required path changes in the
  same commit, and join artifacts are never bound as inputs to a later step
  (`deriveBoundInputs` in `src/runLoop.ts:196-249` never reads `R1.join`
  submissions). A legacy literal would only ever match a file the coordinator no
  longer asks for, so it buys nothing and leaves two names for one thing.

- **Accept the old `.signals/issue-<n>/joined-<agent>.json` as a fallback read
  path for one release.** Rejected. `requiredPath` is what the action promises
  and what evidence checks; accepting a second path makes the promise
  ambiguous, and the failure it avoids is a single self-healing rejection round
  (see Risks).

- **Rename internal `R1.join` / `gate-1-join` / `join-published` to match.**
  Rejected: the issue requires the opposite. Those ids key coordinator state
  (`src/state.ts`), the journal, `src/analytics.ts` step attribution, and the
  published `docs/analytics.md` tables; renaming them would invalidate existing
  runtime state and analytics history for no agent-facing benefit.

- **Ban the word `action` from agent prose.** Rejected. The agent must be told
  to read action.md and to compare `actionId`; issue 88 objects to phase names
  and transitions, not to naming the file the agent actually reads.

- **Edit the repository's own root AGENTS.md overlay.** Rejected and forbidden. That file
  is a `skip-worktree` overlay written by `writeCloneAgentsProtocol`
  (`src/agentsProtocol.ts:57-100`). The source of truth is
  `templates/product/AGENTS.protocol.md`; editing the overlay would either be
  discarded or require clearing `skip-worktree`, which the protocol prohibits.

## Risks and Mitigations

- **An issue already at `R1.join` when the upgrade lands.** The agent has
  published `.signals/issue-<n>/joined-<agent>.json`, but the rebuilt order asks
  for `participation-ready-<agent>.json`, so evidence returns
  `required artifact … is missing` and the coordinator reissues. Mitigation: the
  path is rebuilt from `STEP_DEFINITIONS` on every verify
  (`src/runLoop.ts:1114,1171`), so the reissue carries the new path and the
  agent republishes — one wasted round, no stuck state. Operators who prefer a
  clean start can `coord wipe` the issue before upgrading. Issues past `R1.join`
  are unaffected because no later step binds the participation artifact.

- **The banned-term list produces false positives on legitimate content.** The
  riskiest entries are `\bjoin(ed|ing)?\b`, `\bphases?\b`, and `\bR[1-7]\b`,
  which could match a bound repository path, an agent id, or an issue title
  echoed into the correction block. Mitigation: the checker never runs at
  runtime (previous section), the seeded-inputs test renders real bound paths
  and agent ids so a systemic false positive shows up in CI rather than in
  production, and the word `cursor` is deliberately **not** banned because it is
  a valid agent id that appears in rendered input lists.

- **The banned-term list is too narrow and a future leak slips through.**
  Mitigation: the enforcement loop is keyed off `Object.keys(STEP_DEFINITIONS)`
  and the `Record<EvidenceId, string>` is exhaustive, so a new step or evidence
  id cannot compile without being covered; the positive-control assertions stop
  the list from silently degrading to a no-op regex.

- **`docs/analytics.md` and `docs/coord-driver.md` look like violations.** They
  are operator documentation and are explicitly out of scope; the checker is
  applied only to `renderAction` output, `renderNudgeText` output, the installed
  overlay, and the subject map. Mitigation: `docs/coord-driver.md` gains the
  paragraph stating that boundary, so a later reader does not "fix" the docs.

- **Version-bump gate.** `package.json` is `0.0.13` on both this branch and
  `origin/main`, so `pnpm check:fast` fails until the bump in item 9 is made.
  Mitigation: the bump is part of the change list, not an afterthought.

- **Two copies of the protocol block.** `templates/product/AGENTS.protocol.md`
  repeats its plans/reviews section, and the installed overlay therefore shows
  the delivery paragraph twice. Mitigation: item 6 updates both copies, and the
  new `test/install.test.ts` scan reads the whole rendered overlay, so a missed
  copy fails.

## Conclusion

The leak is confined to four generators — `src/steps.ts` task prose and its
`R1.join` required path, the `"join"` schema token in `src/orderScaffold.ts` and
`src/protocol.ts`, the `evidenceId`-derived `subject` and `join` rejection
strings in `src/evidence.ts`, and the `not nudged` footers in `src/action.ts`
and the two product templates. Fixing those, plus one new module holding the
banned-term list and the agent-facing subject map, satisfies both acceptance
criteria: no internal phase, gate, evidence, or delivery vocabulary reaches an
agent, and `src/state.ts`, the journal, `src/analytics.ts`, `src/cli.ts`, and the
operator documentation keep every internal name they have today. The rename is contained
because participation artifacts are never cited as later inputs, and the whole
rule is held in place by `test/agentLanguage.test.ts`, which iterates every
generated action type rather than spot-checking prose.

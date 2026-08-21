# Issue 88 plan: keep coordinator internals out of agent prompts

## Scope

Issue 88 removes internal coordinator vocabulary from every agent-visible
surface while leaving workflow IDs, journal events, operator logs, and analytics
unchanged. Agents must see only the current outcome, required artifact, exact
inputs, publication path, and completion signal—not phase IDs, gates, or
delivery mechanics.

### Agent-facing surfaces (in scope)

1. Generated `action.md` bodies from `renderAction` plus `STEP_DEFINITIONS.task`,
   artifact scaffolds, and correction `outstanding` lines.
2. Injected delivery text from `renderNudgeText` (keep outcome wording; do not
   mention delivery/retry mechanics).
3. Installed protocol prose in `templates/product/AGENTS.protocol.md` (clone
   overlay via `writeCloneAgentsProtocol`).
4. Opt-in product `templates/product/AGENTS.md` when it names internal phases
   (today: `R7 finalization`).
5. Agent-copied JSON schema tokens and required paths that encode the join phase
   name (`artifact: "join"`, `.signals/issue-<n>/joined-<agent>.json`).

### Operator / internal surfaces (out of scope; must remain)

- `WorkflowStepId` / `GateId` / `EvidenceId` values such as `R1.join`,
  `gate-1-join`, `join-published`.
- Journal types (`nudged`), lifecycle delivery enums, tmux/config field names,
  CLI verbose logs, analytics reports, and owner docs (`docs/`, `README.md`).

### Binding rename for the participation artifact

Rename only the agent-authored join evidence token and path to outcome language.
Keep internal step/evidence IDs:

| Surface | Current | New |
| --- | --- | --- |
| JSON `artifact` literal | `"join"` | `"participation-ready"` |
| Required path | `.signals/issue-<n>/joined-<agent>.json` | `.signals/issue-<n>/participation-ready-<agent>.json` |
| Task prose | “Publish the join artifact …” | “Publish the participation-readiness artifact …” |
| Correction strings | `invalid join artifact…`, `join baselineSha…` | matching participation-ready wording |

No `protocolVersion` bump: issue coordination artifacts are ephemeral and deleted
at finalization; in-flight issues are not required to accept both literals.

### Forbidden agent-facing patterns (test oracle)

Generated action bodies, scaffolds, protocol template text, and product AGENTS
template text must not match:

- internal phase IDs: `\bR[1-7]\.[a-z0-9-]+\b`
- gate IDs: `\bgate-[0-9]+-[a-z0-9-]+\b`
- delivery jargon: `\bnudge(?:d|s)?\b` (case-insensitive)
- phase-named join wording: `\bjoin artifact\b`, `"artifact": "join"`, path
  segment `joined-`

Ordinary task words such as “plan,” “review,” and “implement” remain allowed.

### Footer replacement (authoritative)

Replace the `action.md` / protocol re-read footer with:

> Before waiting for more input, re-read this file. If `actionId` has changed,
> execute the new instructions immediately; do not wait for another coordinator
> message.

## Exact File List to be changed or deleted

### Changed

- `package.json` — bump `0.0.13` → `0.0.14` for the non-main ship gate.
- `config.product.example.json` — bump installed `coordination.version` to
  `0.0.14`.
- `src/steps.ts` — rewrite `R1.join` task to participation-readiness language;
  change `requiredPath` to
  `.signals/issue-${issue}/participation-ready-${agent}.json`. Audit other
  `STEP_DEFINITIONS.task` strings and keep only outcome wording (no phase/gate/
  nudge terms).
- `src/action.ts` — replace the re-read footer with the authoritative text above;
  keep restricted front matter (`actionId`, `agent`, `requiredPath` only).
- `src/orderScaffold.ts` — emit `"artifact": "participation-ready"` for
  `R1.join`; keep other scaffolds unchanged unless a forbidden pattern appears.
- `src/protocol.ts` — change `joinArtifactSchema` literal from `"join"` to
  `"participation-ready"`; keep the TypeScript type name if useful internally.
- `src/evidence.ts` — validate the new literal/path; rewrite agent-visible
  outstanding strings that say “join artifact” / “join baselineSha” /
  “join automationDigest” into participation-ready wording. Leave
  `evidenceId === "join-published"` as the internal discriminator.
- `templates/product/AGENTS.protocol.md` — replace the nudge/delivery recovery
  paragraph with the same outcome-oriented re-read instructions (no “nudge”).
- `templates/product/AGENTS.md` — replace “R7 finalization” with outcome wording
  such as “Finalization deletes only those current-issue coordination paths.”
- `test/action.test.ts` — expect the new footer; keep asserting front matter
  never includes `stepId` / evidence / gate fields; add coverage that the
  rendered body has no forbidden patterns.
- `test/orderScaffold.test.ts` — expect `participation-ready` scaffold and path
  token absence of `"join"`.
- `test/protocol.test.ts` — accept only `"participation-ready"` for that
  artifact family.
- `test/evidence.test.ts` — update join fixtures/paths/messages to the new
  token and path.
- `test/runLoop.test.ts` — update required path, scaffold, and any body
  assertions for the renamed participation artifact.
- `test/cli.test.ts` — update path assertions for the participation-ready file.
- `test/integration.test.ts` — publish `participation-ready` evidence instead
  of `join`.
- `test/install.test.ts` — expect installed version `0.0.14`.

### Deleted

- None.

## Exact file list to be created

- `test/agentFacingLanguage.test.ts` — mechanical audit: for every
  `WorkflowStepId` in `STEP_DEFINITIONS`, build a representative `InternalOrder`
  (via `buildOrder` or direct render of `task` + `renderArtifactScaffold` +
  `renderAction`), plus read protocol/product AGENTS templates, and assert none
  of the forbidden patterns appear. Also assert the new footer text is present
  in `renderAction` output and in `AGENTS.protocol.md`. Assert
  `renderNudgeText` still contains only action id/digest/path instructions and
  no delivery jargon.

## Implementation Details

1. Treat “agent-facing” as anything an agent is instructed to read or copy:
   `action.md`, injected prompt text, AGENTS protocol/product templates, JSON
   scaffolds, required paths, and correction outstanding lines. Code comments,
   operator docs, journals, and internal IDs are not rewritten for this issue.
2. Rename only the join evidence token/path. Do not rename
   `implementation-ready`, ballots, or other outcome-named artifacts; they
   already describe work products rather than phase IDs.
3. Keep `EvidenceId` `join-published` and step id `R1.join` so machine, journal,
   analytics, and gate advancement stay stable.
4. Apply the footer replacement in both `src/action.ts` and
   `templates/product/AGENTS.protocol.md` so clone overlays and live actions
   agree.
5. When updating outstanding strings in `evidence.ts`, keep them actionable and
   specific; only remove phase/delivery jargon.
6. Do not change `renderNudgeText` wording unless a forbidden pattern is found;
   today’s text already names the action file, id, and digest without saying
   “nudge.”
7. Do not edit product `githooks/` to satisfy checks. Do not clear skip-worktree
   on clone `AGENTS.md` as part of this work; install overlay updates happen on
   the next coordinator install/sync.
8. Update `.plans/issue-1/workflow-algorithm.md` only if a reviewer requires
   design-doc path alignment; it is not agent-facing and is otherwise out of
   scope.
9. Bump package and example product config versions together so
   `pnpm check:fast`’s non-main version gate passes.

## Tests

Run focused tests while implementing:

```bash
pnpm vitest run --config vitest.config.ts test/agentFacingLanguage.test.ts test/action.test.ts test/orderScaffold.test.ts test/protocol.test.ts test/evidence.test.ts test/runLoop.test.ts test/cli.test.ts test/integration.test.ts test/install.test.ts
```

Run the repository pre-commit suite before committing:

```bash
pnpm check:fast
```

Run full coordinator acceptance before publication/final acceptance:

```bash
pnpm check
```

Tests must prove:

- Every workflow step’s rendered `action.md` lacks phase IDs, gate IDs, and
  nudge/join-phase jargon.
- `AGENTS.protocol.md` and product `AGENTS.md` lack those patterns.
- Join evidence uses `artifact: "participation-ready"` and the new path; old
  `"join"` / `joined-*.json` are rejected.
- Internal step advancement, evidence id `join-published`, journal `nudged`
  events, and operator phase logging still function in existing run-loop /
  integration coverage.
- Version assertions expect `0.0.14`.

## Alternatives Rejected

- **Rename internal step/gate IDs (`R1.join`, `gate-1-join`).** Rejected: the
  issue requires those IDs to remain for coordinator state, journals, and
  analytics; only agent-facing prose/tokens change.
- **Keep `artifact: "join"` and only rewrite English task text.** Rejected: the
  issue explicitly calls out agent-visible schema tokens and paths that encode
  phase jargon; agents copy those tokens verbatim.
- **Bump `protocolVersion` and dual-accept old/new join literals.** Rejected:
  unnecessary complexity for ephemeral issue artifacts deleted at finalization.
- **Rewrite operator docs and analytics to avoid “nudge”/phase names.**
  Rejected: acceptance criteria keep those terms for coordinator/owner surfaces.
- **Hide required paths behind opaque aliases.** Rejected: agents still need an
  exact publication path; renaming to outcome language is enough.
- **Rely on manual review instead of a mechanical language test.** Rejected:
  acceptance requires tests that inspect every generated action type.

## Risks and Mitigations

- **Risk: in-flight issues still write `joined-*.json` / `"join"`.** Mitigation:
  ephemeral issue sessions; document that issue 88 ships as a clean cutover.
  Validation fails closed with clear outstanding text.
- **Risk: over-broad forbidden regex blocks legitimate words.** Mitigation: match
  phase IDs, gate IDs, nudge stems, and join-phase tokens/paths—not the ordinary
  verbs plan/review/implement.
- **Risk: correction outstanding strings still leak jargon.** Mitigation: include
  evidence rejection messages in the agent-facing audit and rewrite join-family
  strings with the rename.
- **Risk: clone AGENTS overlays stay stale until reinstall.** Mitigation: change
  the template source of truth; coordinator install/sync refreshes overlays.
  Live `action.md` footer fixes apply immediately on new actions.
- **Risk: accidental behavior change in verification or machine transitions.**
  Mitigation: keep internal evidence/step IDs; extend existing evidence and
  integration tests rather than rewriting the state machine.
- **Risk: version bump forgotten.** Mitigation: update `package.json`,
  `config.product.example.json`, and install test together; `check:fast`
  enforces the ship gate.

## Conclusion

Sanitize every agent-visible instruction and copied token so agents never see
coordinator phase/delivery vocabulary, while preserving internal workflow IDs
and operator observability. The concrete cutover is outcome-oriented task/footer
prose plus renaming the join evidence literal and path to
`participation-ready`, locked in by a mechanical language audit over all
generated action types.

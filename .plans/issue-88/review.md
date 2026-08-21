# Issue 88 plan review

Bound plans reviewed:

- antigravity `8b7fd403a4d4441d88c68d8e3820184707832f01` at `.plans/issue-88/plan.md`
- cursor `036cecb07f6e56ad74374a0007bd0bf610b0bb28` at `.plans/issue-88/plan.md`
- codex `80c62df4da7871161c1ecfb77fb75354117c27e5` at `.plans/issue-88/plan.md`
- claude `1327fe2423d9144ab6b3ca955fac4a6c0786d069` at `.plans/issue-88/plan.md`

## Findings

### Antigravity — Alternatives Rejected rejects the schema/path rename the issue requires

**Plan claim:** Alternatives Rejected states changing JSON schema tokens such as
`artifact: "join"` is rejected because they are “schema tokens rather than
prompt prose” and renaming would break wire compatibility.

**Rule:** Issue 88 acceptance requires that agent-visible schema tokens and
paths that encode phase jargon be audited and renamed where needed, while only
internal workflow IDs may stay unchanged.

**Failure if followed:** Generated scaffolds keep `"artifact": "join"` and
`.signals/issue-<n>/joined-<agent>.json`. Agents still copy the phase name into
the required file, so the “no internal coordinator phase jargon in agent-facing
prose/tokens” criterion fails even after the task/footer reword.

**Correction:** Adopt the participation-readiness public contract (token + path
+ task + correction strings) used by the other three plans; keep `R1.join` /
`join-published` internal.

### Antigravity — Exact File List omits several agent-facing leak sites

**Plan claim:** Changed files are only `src/steps.ts`, `src/action.ts`,
`templates/product/AGENTS.protocol.md`, `package.json`, and `test/action.test.ts`.

**Rule:** Every generator that writes agent-readable instructions or tokens must
be in the change set: scaffolds, protocol schema, evidence outstanding text,
product AGENTS template, and tests that lock those surfaces.

**Failure if followed:** `orderScaffold.ts` / `protocol.ts` still emit `"join"`;
`evidence.ts` still returns `invalid join artifact…` into reissued actions;
`templates/product/AGENTS.md` still says `R7 finalization`; path stays
`joined-*.json`. Footer/task-only edits leave acceptance gaps.

**Correction:** Expand the file map to cover path, scaffold, schema, evidence
diagnostics, both product templates, and the full fixture/test update set.

### Cursor and Codex — pin-validation subjects still leak internal evidence IDs

**Plan claim:** Cursor Limits evidence rewrites to join-family strings
(`invalid join artifact`, baseline/digest messages). Codex likewise updates
“first-step” readiness errors and does not map `pinErrors` subjects.

**Rule:** Anything appended under `Correct these outstanding items:` is
agent-facing. Today `src/evidence.ts` `pinErrors` passes
`subject: \`${order.evidenceId} artifact\`` into `validatePhasePin`, so failure
details begin with tokens such as `implementation-pinned artifact` or
`revision-pinned artifact`.

**Failure if followed:** On the first pin-lineage rejection after join is
cleaned, the reissued `action.md` still contains internal evidence IDs. The
mechanical action-body audit can pass on happy-path renders and still miss the
acceptance criterion for correction text.

**Correction:** Follow Claude’s `agentFacingSubject(evidenceId)` (or equivalent)
for every `pinErrors` / pin-validation subject, and assert a failing pin case
produces outcome wording without the raw evidence id.

### Codex — exhaustive ban on the bare word “join” is broader than the issue allows

**Plan claim:** Tests section requires every generated consensus action to omit
the term “join” (alongside phase/gate/delivery jargon).

**Rule:** Issue 88 forbids presenting coordinator phase names and delivery
mechanics; ordinary task vocabulary may remain. The leak to remove is
phase-named join wording (`join artifact`, `"artifact": "join"`, `joined-`
paths), not every English occurrence of “join” if a future legitimate path or
rationale needs it.

**Failure if followed:** Implementers encode a blanket `\bjoin\b` ban. A later
bound path, agent id, or remediation sentence containing “join” fails CI even
though it is not coordinator phase vocabulary, pushing work toward brittle
escapes or silent weakenings of the oracle.

**Correction:** Ban phase-shaped forms (`\bjoin artifact\b`,
`"artifact": "join"`, path segment `joined-`, internal `R1.join` in rendered
text) rather than every `join` token; keep Claude/Cursor-style positive controls
for the real leaks.

### Claude — template dual-copy claim is false and weakens the install mitigation story

**Plan claim:** `templates/product/AGENTS.protocol.md` “repeats its
plans/reviews section,” so item 6 must update two copies; Risks treats a missed
second copy as the failure mode.

**Rule:** Plan claims that drive file edits must match the repository as
written; mitigations must point at the real source of truth.

**Failure if followed:** Implementers search the template for a second nudge
paragraph that does not exist (the template has one recovery paragraph). Effort
is spent on a phantom duplicate while the real risk—stale clone overlays until
reinstall, and product `AGENTS.md` still saying `R7 finalization`—is the one
that matters. The install scan still helps, but the plan’s stated dual-copy
mitigation does not.

**Correction:** Edit the single protocol template paragraph; rely on
`renderAgentsProtocolBlock` / install tests for the installed overlay, and keep
the product `AGENTS.md` R7 rewrite as a separate explicit edit.

### Claude — banned-term list forbids ordinary “phase”/“gate” words and bare `R[1-7]`

**Plan claim:** `AGENT_FACING_BANNED_TERMS` includes `\bgates?\b`, `\bphases?\b`,
`\bR[1-7]\b`, and `\bjoin(ed|ing)?\b` as always-illegal agent text.

**Rule:** The acceptance bar is no internal phase IDs, gate IDs, or delivery
jargon in agent-facing content. Ordinary English and outcome words are allowed;
tests must not invent a stricter product dialect than the issue states.

**Failure if followed:** A correction line or scaffold that legitimately says
“gates” in a product sense, or a compact “R6” round label without a dotted step
id, fails the shared checker. Maintainers then dilute the oracle, which also
threatens detection of real leaks (`R1.join`, `gate-1-join`, `nudge`).

**Correction:** Prefer dotted step IDs (`\bR[1-7]\.[a-z0-9-]+\b`), full gate ids
(`\bgate-[0-9]+-[a-z0-9-]+\b`), delivery stems, and join-phase token/path forms;
drop bare `phase`/`gate`/`R[1-7]` bans unless tied to those shapes.

## Conclusion

Antigravity is not implementable as written against issue 88: it explicitly
rejects the schema/path rename and omits most leak sites. Cursor and Codex have
the right public rename and footer/protocol direction, but both miss the
`pinErrors` evidence-id subject leak that re-enters agent prompts on
correction. Claude is the only plan that closes that correction-path leak and
builds a single language oracle, yet its dual-copy template claim is wrong and
its banned-term list is over-broad. Prefer Claude’s surface inventory and
subject map, Codex/Cursor’s cleaner cutover of the participation-ready
token/path, and a forbidden-pattern oracle scoped to phase/gate/delivery shapes
rather than blanket English bans.

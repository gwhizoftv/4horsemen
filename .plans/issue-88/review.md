# Plan review — issue 88: keep coordinator internals out of agent prompts

Plans reviewed:

- antigravity: `8b7fd403a4d4441d88c68d8e3820184707832f01` at `.plans/issue-88/plan.md`
- cursor: `036cecb07f6e56ad74374a0007bd0bf610b0bb28` at `.plans/issue-88/plan.md`
- codex: `80c62df4da7871161c1ecfb77fb75354117c27e5` at `.plans/issue-88/plan.md`
- claude: `1327fe2423d9144ab6b3ca955fac4a6c0786d069` at `.plans/issue-88/plan.md`

## Findings

### 1. All four plans leave the internal evidence id in retry instructions (`src/evidence.ts:211`)

**Claim.** antigravity `8b7fd403a4d4441d88c68d8e3820184707832f01` omits `src/evidence.ts`
from its change list entirely. cursor `036cecb07f6e56ad74374a0007bd0bf610b0bb28`
scopes that file to "outstanding strings that say 'join artifact' /
'join baselineSha' / 'join automationDigest'". codex
`80c62df4da7871161c1ecfb77fb75354117c27e5` scopes it to "parse, baseline, and
automation-digest failures" and states in Implementation Details item 4 "Update
all first-step errors". claude `1327fe2423d9144ab6b3ca955fac4a6c0786d069` is the
only plan that names line 211, and it is listed there for completeness of the
shared defect.

**Rule.** Every string that can reach an agent must be free of internal
coordinator vocabulary — not only the strings on the success path. Rejected
evidence is agent-facing: `src/runLoop.ts:832` passes `outstanding` into
`buildOrder`, and `src/runLoop.ts:307` renders it verbatim under
`Correct these outstanding items:` in the next `action.md`.

**Failure.** `src/evidence.ts:207-214` calls `mirror.validatePhasePin({ …, subject: \`${order.evidenceId} artifact\` })`,
and `src/pinValidation.ts:227-262` interpolates that `subject` into every
returned `details` string. An implementer publishes a pin that is not an
ancestor of the branch tip; `pinErrors` pushes the returned `details`; the
reissued action then contains

> - implementation-pinned artifact pins <sha>, which is not an ancestor of current origin tip …

`implementation-pinned` is an `EvidenceId` from `src/steps.ts:10-24`. Under the
antigravity, cursor, and codex plans as written, that text is unchanged, so
acceptance criterion 1 ("No internal coordinator phase/delivery jargon appears in
agent-facing prose") fails on the first rejected implementation or revision. The
leak is invisible to every proposed test in all four plans except claude's,
because each of the other exhaustive scans renders actions with an empty
`outstanding` list. The same path also fires for `revision-pinned` at
`src/evidence.ts:373-398` and for `finalization-verified` at
`src/evidence.ts:435-439`.

**Correction.** Replace the `subject` argument with an agent-facing phrase
resolved from an exhaustive `Record<EvidenceId, string>` (for example
`implementation-pinned → "the implementation signal"`), and render one action per
step with a non-empty `outstanding` list inside the exhaustive test so the
correction block is actually scanned.

### 2. antigravity keeps `"artifact": "join"` and `joined-<agent>.json`, which the issue names as in-scope

**Claim.** antigravity `8b7fd403a4d4441d88c68d8e3820184707832f01`, Alternatives
Rejected: "Changing JSON schema tokens in `src/protocol.ts`: Rejected because
internal protocol discriminators (like `artifact: "join"`) in structured JSON
signals are schema tokens rather than prompt prose, and altering them would break
wire compatibility with existing tools and signals."

**Rule.** The issue's expected behaviour is explicit: "Agent-visible schema
tokens and paths that currently expose phase-specific jargon are audited and
renamed where needed," and it lists "Join" alongside `R1.join` and gates as
coordinator vocabulary. A token an agent is instructed to copy verbatim into a
file it authors is agent-facing prose by construction, not an internal
discriminator.

**Failure.** `src/orderScaffold.ts:47-56` emits `"artifact": "join"` into the
`R1.join` action body, and `src/steps.ts:64` makes the agent create
`.signals/issue-<n>/joined-<agent>.json`. Following antigravity's plan, the very
first action every agent receives still reads `"artifact": "join"` and names a
`joined-` path, so acceptance criterion 1 fails on step one. The premise is also
factually wrong: nothing outside this repository consumes the token.
`joinArtifactSchema` has exactly two call sites (`src/protocol.ts:143` and
`src/evidence.ts:279`), join artifacts are never bound as inputs to a later step
(`deriveBoundInputs`, `src/runLoop.ts:196-249`, never reads `R1.join`
submissions), and the files are deleted at finalization — so there is no wire
compatibility to break.

**Correction.** Adopt the rename the other three plans specify: literal
`participation-ready` in `src/protocol.ts` and `src/orderScaffold.ts`, path
`.signals/issue-<n>/participation-ready-<agent>.json` in `src/steps.ts`, with
`R1.join`, `gate-1-join`, and `join-published` unchanged.

### 3. antigravity's exhaustive test cannot see the surface it is meant to police

**Claim.** antigravity `8b7fd403a4d4441d88c68d8e3820184707832f01`, `test/action.test.ts`
entry: "Add comprehensive test suite inspecting every workflow step in
`STEP_DEFINITIONS` across all profiles when rendered via `renderAction`."

**Rule.** A test that claims to inspect "every generated action type" must
render what the coordinator actually writes to `action.md`, which is the
assembled body, not the static task string.

**Failure.** `renderAction` (`src/action.ts:24-61`) interpolates
`order.task` as given. The scaffolds, the `Use protocolVersion 1…` preamble, and
the correction block are appended earlier, by `buildOrder` at
`src/runLoop.ts:307-360`, which composes
`${definition.task}${binding}${scaffold}${correction}`. A test that constructs an
`InternalOrder` with `task: STEP_DEFINITIONS[stepId].task` — the only source
antigravity's plan names — renders a body that never contains a JSON scaffold.
Since `"artifact": "join"` lives only in the scaffold, the suite passes green
while the leak antigravity declined to fix ships untested. The same blind spot
hides the `R2.plan` / `R3.review` / `R5.compare` heading scaffolds in
`src/orderScaffold.ts:129-175`, which antigravity's change list never audits.

**Correction.** Drive the scan through `buildOrder(paths, start, cursors, agent, stepId, round, actionId, outstanding)`
against a real runtime fixture, as cursor, codex, and claude all specify.

### 4. antigravity's change list omits three files its own text requires

**Claim.** antigravity `8b7fd403a4d4441d88c68d8e3820184707832f01` lists five
changed files and "None" created. Its Risks section nonetheless says "Audited
test references (`test/action.test.ts`, `test/install.test.ts`) and will update
them", and it bumps `package.json` to `0.0.14`.

**Rule.** `src/evidence.ts` extracts the approved file map from the selected
plan (`extractApprovedPaths`, `src/evidence.ts:125-138`) and rejects an
implementation that touches any path outside it
(`src/evidence.ts:330-336`: "implementation changes paths outside the approved
file map"). A file the implementer must edit and the plan does not name is not a
documentation gap; it is a hard rejection.

**Failure.** Three concrete cases. (a) `test/install.test.ts:125` asserts the
overlay contains ``If `actionId` in the front matter has changed``; antigravity
rewrites that paragraph in `templates/product/AGENTS.protocol.md`, so
`pnpm test:fast` fails, and `test/install.test.ts` is not in the file list.
(b) `test/cli.test.ts:100` and `test/install.test.ts:163` both hard-code
`"0.0.13"`, sourced from `package.json` via `packageVersion`
(`src/install.ts:106-109`, `src/cli.ts:775-777`); the bump to `0.0.14` fails both,
and neither file is listed. (c) `templates/product/AGENTS.md:41` reads "R7
finalization is deletion-only cleanup of exactly those paths" — an internal step
id in the guidance `coord install --write-product` writes into a product
repository — and that file is not listed either, so acceptance criterion 1 fails
even after the rest of the plan is implemented.

**Correction.** Add `templates/product/AGENTS.md`, `test/install.test.ts`, and
`test/cli.test.ts` to the changed list, with the specific assertions named.

### 5. cursor's footer rewrite breaks an assertion its change list does not cover

**Claim.** cursor `036cecb07f6e56ad74374a0007bd0bf610b0bb28`, Implementation
Details item 4: "Apply the footer replacement in both `src/action.ts` and
`templates/product/AGENTS.protocol.md`". Its `test/install.test.ts` entry reads,
in full: "expect installed version `0.0.14`".

**Rule.** A plan that changes a string must name every existing assertion on
that string, because `pnpm check:fast` is `verify.precommit` and must pass before
the implementation commit exists.

**Failure.** cursor's authoritative footer is "Before waiting for more input,
re-read this file. If `actionId` has changed, execute the new instructions
immediately; do not wait for another coordinator message." It drops the words
"in the front matter". `test/install.test.ts:125` asserts
``expect(agentsMd).toContain("If `actionId` in the front matter has changed")``
against the rendered overlay. Following cursor's plan as written, `pnpm test:fast`
fails on `test/install.test.ts`, and the only edit the plan authorises in that
file is the version number. Separately, `test/cli.test.ts:100` asserts `"0.0.13"`
and cursor's `test/cli.test.ts` entry covers only "path assertions for the
participation-ready file", so the version bump fails there too.

**Correction.** Either keep the phrase "in the front matter" in the template
footer, or add the `test/install.test.ts:125` and `test/cli.test.ts:100` edits to
the change list explicitly.

### 6. cursor and codex both assert a version gate on `config.product.example.json` that does not exist

**Claim.** cursor `036cecb07f6e56ad74374a0007bd0bf610b0bb28`: "Mitigation: update
`package.json`, `config.product.example.json`, and install test together;
`check:fast` enforces the ship gate." codex
`80c62df4da7871161c1ecfb77fb75354117c27e5`: "`config.product.example.json` — keep
the example's installed coordination version aligned at 0.0.14."

**Rule.** A plan must not attribute a requirement to a check that does not
impose it; a later reader uses the plan to decide what is load-bearing.

**Failure.** The only test that reads that file is
`test/verify-config.test.ts:204-205`, which asserts it "keeps
`config.product.example.json` parseable by the driver's own schema" — a schema
parse, with no assertion on `coordination.version`. The real gate is
`test/versionBump.test.ts:25-31`, which calls `checkVersionBump(process.cwd(), …)`
against `origin/main` and reads only `package.json`. An implementer who trusts
these plans will believe the example bump is required by `check:fast`; it is not,
and if a later change makes the two files disagree, nothing will catch it. The
edit is harmless, but its justification is wrong.

**Correction.** Keep the example bump if desired, but describe it as cosmetic
alignment and attribute the ship gate to `test/versionBump.test.ts` and
`package.json` only.

### 7. codex uses two spellings for one public token

**Claim.** codex `80c62df4da7871161c1ecfb77fb75354117c27e5`, Approach: "the
repository path pattern `.signals/issue-<n>/participation-ready-<agent>.json`,
and the JSON discriminator `participation-readiness`."

**Rule.** The public contract an agent transcribes should use one token for one
concept; the schema is `.strict()` and rejects near-misses without repair.

**Failure.** The agent reads a required path ending `participation-ready-claude.json`
and a scaffold containing `"artifact": "participation-readiness"`. A transcription
that carries the path spelling into the JSON is rejected by the strict literal in
`src/protocol.ts` with a zod error, costing a full rejection and reissue round for
a difference with no meaning. This is the same class of avoidable friction the
issue is trying to remove.

**Correction.** Use `participation-ready` for both the path segment and the
discriminator, as cursor and claude specify; keep "participation-readiness" for
English prose only.

### 8. claude's own banned-term list rejects a path claude's own plan does not rename

**Claim.** claude `1327fe2423d9144ab6b3ca955fac4a6c0786d069`, `src/agentLanguage.ts`
entry: banned term `evidence-id` — `/\b[a-z]+(?:-[a-z]+)*-(published|pinned|authorized|declared|verified)\b/` —
combined with an exhaustive scan over `Object.keys(STEP_DEFINITIONS)` and a
changed-file list that renames only the `R1.join` required path.

**Rule.** A mechanical checker must not flag a string the same plan leaves in
place; otherwise the plan cannot be implemented as written.

**Failure.** `src/steps.ts:135` defines the `R5.reviser-auth` required path as
`.signals/issue-${issue}/reviser-authorized.json`. `renderAction` puts that path
in both the front matter (`requiredPath:`) and the body. The proposed regex
matches `reviser-authorized`, so `findAgentLanguageViolations` returns a
violation and the new `test/agentLanguage.test.ts` fails on step
`R5.reviser-auth` — on the first run, before any leak exists. The plan is
internally inconsistent: it cannot go green.

**Correction.** Anchor the evidence-id pattern to the exact `EvidenceId` values
rather than a suffix shape — build it from the `Record<EvidenceId, string>` keys
as an alternation — which matches `implementation-pinned` and `join-published`
while leaving the outcome-named path `reviser-authorized.json` alone.

### 9. claude's change list names the version-assertion test files but not the edits

**Claim.** claude `1327fe2423d9144ab6b3ca955fac4a6c0786d069`, item 9 bumps
`package.json` to `0.0.14`; items 15 and 16 list `test/cli.test.ts` (line 332
required path only) and `test/install.test.ts` (add an overlay language scan
only).

**Rule.** Every edit needed for the plan's own named verification command to
pass must appear in the plan, not only the file that contains it.

**Failure.** `test/cli.test.ts:100` asserts the CLI prints `"0.0.13"` and
`test/install.test.ts:163` asserts `config.coordination?.version` is `"0.0.13"`;
both derive from `package.json` through `packageVersion`. An implementer who
performs exactly the edits claude enumerates bumps the version and leaves both
assertions at `0.0.13`, so `pnpm check:fast` — which the plan names as the
pre-commit gate — fails with two errors the plan never mentions. The file map is
wide enough to authorise the fix, so this is a completeness defect in the
instructions rather than a rejection risk.

**Correction.** Add `test/cli.test.ts:100` and `test/install.test.ts:163` to the
enumerated edits for item 9.

## Conclusion

codex `80c62df4da7871161c1ecfb77fb75354117c27e5` is the strongest plan: it is the
only one that identifies every agent-facing surface — task prose, required path,
JSON discriminator, strict schema, validation diagnostics, both product
templates, and the injected message — and the only one whose change list already
covers `test/tmux.test.ts`, `test/install.test.ts`, and the `test/cli.test.ts`
version assertion. Its remaining defects are finding 1 (shared with every plan)
and the cosmetic finding 7.

cursor `036cecb07f6e56ad74374a0007bd0bf610b0bb28` reaches the same technical
conclusions and adds the clearest statement of the in-scope / out-of-scope
boundary, but leaves two assertions failing (finding 5).

claude `1327fe2423d9144ab6b3ca955fac4a6c0786d069` is the only plan that catches
the `src/evidence.ts:211` leak, and it is the only one whose proposed test cannot
compile-and-pass as specified (finding 8).

antigravity `8b7fd403a4d4441d88c68d8e3820184707832f01` should not be selected as
written: it declines the rename the issue explicitly requires (finding 2) on a
premise the code contradicts, its exhaustive test cannot observe the surface it
polices (finding 3), and its file list is short by three files that its own
change makes mandatory (finding 4).

Recommended composition for whichever plan is selected: codex's surface
inventory and test placement, plus the `agentFacingSubject` fix from finding 1,
the single-token correction from finding 7, and the `EvidenceId`-alternation
correction from finding 8.

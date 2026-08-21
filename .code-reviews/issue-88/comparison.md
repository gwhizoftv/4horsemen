# Issue 88 implementation comparison

Bound implementation pins:

- cursor `2eb72a07ab9b02a575ab7483d21ca2fbb8dfa231`
- antigravity `4eadf9f357d593e3c6abf88ca4008ff61d74d525`
- claude `3662cc094cd9f12ec0a82f56e8d6a9e4da652536`
- codex `9b2c05b6dc4e8d6780492972e5b572fc4d299f82`

All four ship the shared cutover: `artifact: "participation-ready"`,
`.signals/issue-<n>/participation-ready-<agent>.json`, outcome-oriented join
task/footer prose, `agentFacingSubject` for pin-validation subjects, version
`0.0.14`, and a step-keyed language audit. They diverge on whether agent-visible
paths and templates still encode evidence/gate jargon, and on how strictly the
oracle bans those forms.

## Comparison

### Antigravity leaves “gate” in the installed product template

**File:** `templates/product/AGENTS.md:34` on
`4eadf9f357d593e3c6abf88ca4008ff61d74d525`

**Rule:** Agent-facing installed guidance must not use coordinator gate
vocabulary; a language oracle that bans `\bgates?\b` must either rewrite every
matching template line or the acceptance criterion fails.

**Failure:** The template still says checks “gate pull-request creation” while
`src/agentLanguage.ts:12` bans `gate-vocabulary`. The agentLanguage suite on
this pin scans the protocol overlay but not `templates/product/AGENTS.md`, so
`pnpm check:fast` can pass while every `--write-product` / clone overlay that
includes the product template still teaches agents the banned word.

**Test:** `expect(findAgentLanguageViolations(readFileSync("templates/product/AGENTS.md","utf8"))).toEqual([])`
fails until the sentence is rewritten to “must pass before pull-request
creation” (as on the cursor/claude/codex pins).

### Antigravity weakens the evidence-id ban to keep `reviser-authorized.json`

**File:** `src/agentLanguage.ts:16` and `src/steps.ts:128` on
`4eadf9f357d593e3c6abf88ca4008ff61d74d525`

**Rule:** Agent-visible required paths and copied tokens must not expose
internal evidence ids; if the oracle claims to ban evidence ids, it must catch
`reviser-authorized` or the path must be renamed to outcome language.

**Failure:** The evidence-id regex omits the `authorized` suffix, so
`.signals/issue-<n>/reviser-authorized.json` remains in `requiredPath` and is
printed into every reviser-auth `action.md` without tripping the checker.
Agents still see the internal evidence id as a filename.

**Test:** Render `R5.reviser-auth` via `buildOrder`/`renderAction` and assert
`findAgentLanguageViolations` is empty only after the path no longer contains
`reviser-authorized` (or the oracle matches that exact id).

### Codex keeps the evidence-id filename and special-cases only “artifact” prose

**File:** `src/steps.ts:128` and `src/agentLanguage.ts:21-25` on
`9b2c05b6dc4e8d6780492972e5b572fc4d299f82`

**Rule:** Same as above: the publication path is agent-facing. Exempting
`reviser-authorized` except when followed by the word `artifact` does not stop
the path from appearing in front matter / publication instructions.

**Failure:** `requiredPath` remains `.signals/issue-<n>/reviser-authorized.json`.
Generated actions still instruct agents to write a file whose name is the
internal evidence id, which is the leak class issue 88 called out for join and
which the selected plan extended to correction/path surfaces.

**Fix sketch:** Rename to an outcome path such as
`reviser-authorization.json` or `revision-authorization.json` (claude/cursor)
and ban the bare evidence id, not only the `… artifact` phrase.

### Claude’s evidence-id oracle is exact; cursor/claude rename the path

**Pins:** claude `3662cc094cd9f12ec0a82f56e8d6a9e4da652536`
(`src/agentLanguage.ts:56`, `src/steps.ts:128` → `reviser-authorization.json`);
cursor `2eb72a07ab9b02a575ab7483d21ca2fbb8dfa231`
(`src/steps.ts:128` → `revision-authorization.json`).

**Rule:** Prefer an exhaustive evidence-id alternation (or a renamed path) so
outcome artifact names like `implementation-ready` are not collateral damage
and required paths stay jargon-free.

**Observation:** Claude matches the selected plan’s intent most cleanly: exact
`EvidenceId` alternation plus a renamed path and a template that already says
checks “must pass before a pull request is created.” Cursor reaches the same
acceptance bar by renaming the path and fixing the gate sentence, with a
suffix-shaped evidence-id regex that forced the rename. Both are preferable to
antigravity/codex on this axis.

### Shared strengths (all four pins)

Each pin updates `src/protocol.ts` / `src/orderScaffold.ts` /
`src/steps.ts` join surfaces to `participation-ready`, rewrites the action
re-read footer without “nudge,” wires
`subject: agentFacingSubject(order.evidenceId)` in `src/evidence.ts`, bumps
`package.json` to `0.0.14`, and adds a `STEP_DEFINITIONS`-keyed language test.
Internal ids `R1.join`, `gate-1-join`, and `join-published` remain for
coordinator/analytics use.

## Verdict

Prefer **claude** `3662cc094cd9f12ec0a82f56e8d6a9e4da652536` or **cursor**
`2eb72a07ab9b02a575ab7483d21ca2fbb8dfa231`: both remove gate jargon from the
product template and stop shipping `reviser-authorized` as a required path.
**codex** `9b2c05b6dc4e8d6780492972e5b572fc4d299f82` is close but leaves that
path. **antigravity** `4eadf9f357d593e3c6abf88ca4008ff61d74d525` still leaks
“gate” in `AGENTS.md` and deliberately narrows the evidence-id ban around the
old filename.

# Issue 158 — plan review

Reviewed the coordinator-exported files at these exact pins:

- Cursor: `7505af067f6b4e672ed94585899d723569dc73bb`.
- Claude: `7d960d66c03aa5e40a411c7e2a73a414628c8df5`.
- Codex: `ffbd4c5e3a72384f09864201b475ab8786ad5b96`.
- Antigravity: `9600e6a6da17cb31f7d347498203978eb580ab22`.

All four paths are `.plans/issue-158/plan.md` at their respective pins. I also
verified the two owner-authored issue comments through GitHub; these artwork
instructions are not included in the coordinator's title/body-only issue
snapshot. No bound plan or product file was changed during this review.

## Findings

### 1. [P1] Cursor, Codex, and Antigravity plan the superseded visual deliverable

**Plan claims:** Cursor's file-creation list and Alternatives reject banner
assets and choose Mermaid; Codex's README outline item 2 and creation list
require Mermaid plus a new original SVG; Antigravity's file map, Reuse, and
Tests require Mermaid and reject static images.

**Rule:** The owner's supplied artwork and explicit instruction not to use
Mermaid must be honored. The owner supplied a
[hero banner](https://github.com/gwhizoftv/coordination/issues/158#issuecomment-6004633167)
on October 5 and a
[flowchart with the no-Mermaid instruction](https://github.com/gwhizoftv/coordination/issues/158#issuecomment-6008656761)
on October 6, before these planning actions.

**Failure:** All three plans produce a diagram the owner explicitly rejected
and omit the supplied artwork. Antigravity additionally makes the rejected
format a test requirement. Their exact file lists do not authorize the two
owner-provided image files, so an implementer cannot simply substitute Claude's
local-image approach without correcting scope. This applies to my own Codex
plan as well; its accurate workflow prose does not excuse the visual mismatch.

**Smallest correction:** Use the two owner-provided images, retain accessible
profile-accurate prose, and replace the Mermaid/custom-art requirements and
associated checks with local-image and asset-integrity checks.

### 2. [P1] Three plans mechanically authorize paths outside their stated scope

**Plan claims:** Claude says only two Markdown files and two images change;
Cursor says no source/tests/new documentation pages; Antigravity says only the
README, driver guide, and one existing test file change. However, their Tests,
Alternatives, introductory prose, and other non-Reuse sections backtick paths
that they intend only to reference or explicitly reject.

**Rule:** The mechanically derived approved file map must match the smallest
explicitly justified change set, not broaden it through incidental references.
The current `extractApprovedPaths` in `src/evidence.ts` scans backticked paths
throughout the plan except Reuse and Scope; directory entries approve their
descendants.

**Failure:** Running that existing extractor on the bound files gives these
unintended approvals, among others:

- Claude: `docs/` (the entire documentation subtree), `docs/vendor-quota.md`,
  `go.mod`, `Cargo.toml`, `SECURITY.md`, `CONTRIBUTING.md`, and even the Git
  configuration-key strings `coord.workspaceConfig` and `consensus.agentId`.
- Cursor: the rejected `docs/readme-deep-dive.md`,
  `test/support/workspaceFixture.ts`, `SECURITY.md`, and setup-guide changes
  that its explicit change list does not justify.
- Antigravity: the rejected `test/readme.test.ts`, `.png`, `.svg`,
  `CONTRIBUTING.md`, `SECURITY.md`, and `docs/setup-workspace.md`.

Consequently a later implementation could pass the file-scope gate while
changing unrelated documentation, policy files, or tests; Claude's `docs/`
entry is particularly broader than the claimed two-document edit. The Codex
plan extracts exactly its four listed files and has no such scope defect.

**Smallest correction:** Keep authorization paths in the exact file lists;
move read-only path citations to Reuse and Scope or use ordinary prose outside
those lists. Re-run the existing extractor and assert exact equality with the
intended file set before selection. This needs no parser/product change.

### 3. [P2] Claude and Antigravity leave contradictory recovery instructions at the destination

**Plan claims:** Claude requires verbatim relocation of the vendor-quota block
immediately after Delivery safety and unknown holds, explicitly excludes
rewriting its stale paragraph, and treats proximity as mitigation. Antigravity
also appends the resource-hold material without reconciling that paragraph.

**Rule:** Moving the README's authoritative operator detail into the guide
must leave one consistent description of supported recovery, rather than
making readers choose between contradictory instructions.

**Failure:** The resulting guide would still say at its current lines 666–669
that there is no vendor API polling or status-line installation and that the
feature belongs to a future issue, while the newly adjacent section instructs
operators to configure exactly those supported capabilities. Operators cannot
tell whether the documented quota binding and narrowly authorized automatic
resource-hold release actually exist. Merely placing the statements together
does not identify which one is authoritative.

**Smallest correction:** Replace or explicitly qualify the directly conflicting
historical paragraph with a pointer to the relocated current resource-hold
contract. Preserve the separate facts that nudge-loop/manual holds require
their own recovery and Claude native continuation alone does not clear holds.
This stays within the already proposed driver-guide file; Cursor and Codex
already plan this reconciliation.

### 4. [P2] Cursor explicitly preserves a false license statement

**Plan claim:** Risks and Mitigations says the license remains “planned MIT /
deferred file” as today.

**Rule:** The public-facing license description must agree with the license
actually shipped, independently of unfinished repository-visibility or private
security-reporting gates.

**Failure:** The baseline already contains an MIT `LICENSE` with the 2026
copyright notice. Following Cursor's instruction tells prospective users that
licensing remains incomplete even though that file exists, undermining the
open-source landing page and leaving an identified stale README claim intact.

**Smallest correction:** Link the existing MIT license; do not change its
contents or claim that unrelated release gates have passed. Claude and Codex
already make this distinction.

### 5. [P2] Antigravity requires an inaccurate workflow diagram verbatim

**Plan claim:** Reuse requires the issue's exact Mermaid diagram, and Risks
treats the supplied snippet as already verified.

**Rule:** Any workflow explanation must reflect the existing profile-specific
participants and publication policy, not turn an illustrative draft into a
behavioral contract.

**Failure:** Independently of the owner's no-Mermaid clarification, that exact
snippet says a selected agent implements in consensus mode and ends with a
ready-to-merge PR. `participantsForStep` in `src/steps.ts` instead gives every
active consensus agent the implementation step, then selects one revision
stream; the default policy leaves a draft PR unmerged. It also draws a final
check failure directly back to implementation, which the actual finalization
gate does not promise. Testing for its labels preserves these inaccuracies
instead of detecting them.

**Smallest correction:** Keep the owner's image as supplied, but accompany it
with the profile-accurate textual sequence and PR-policy qualification, as
Claude already proposes. Do not create a test that locks the illustrative
diagram's simplifications into documentation requirements.

## Conclusion

**Revise before implementation. Claude is the best starting point**, because
it alone incorporates the verified owner artwork/no-Mermaid clarification and
justifies both new image files. It still needs the exact-scope correction and
the recovery-guide reconciliation above. Preserve an explicit Requirements
heading when nesting prerequisites under Quick start: CONTRIBUTING currently
links to `README.md#requirements`, and its file is not intended to change.

Cursor, Codex, and Antigravity require the artwork correction before selection;
Cursor also requires the license correction. All plans otherwise stay centered
on the README issue rather than changing the interactive CLI. Relocating
unique operator prose into the existing driver guide is appropriate reuse.
Codex identifies existing source functions, tests, and fixtures most explicitly;
Claude and Cursor reasonably avoid new runtime tests for prose-only edits.
Antigravity does reuse the existing shipped-examples test file, but its
tagline/Mermaid-shape assertions would enforce superseded copy rather than
provide focused behavioral coverage; prefer image/link/structure review.

For the chosen implementation, run `pnpm check:fast` before commits and
`pnpm check` for the full acceptance suite, plus relative-link/fragment,
asset-integrity, and rendered-README checks. Passing fast runtime tests alone
does not establish that images render, fragments resolve, or only documentation
changed. No new dependencies, test fixtures, source abstractions, or change to
hooks is needed.

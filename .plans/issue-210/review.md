# Issue 210 plan review

Protocol version: 1. Reviewed the exact exported plans bound by action
`16e33db3-1e7b-4449-b42d-0cb05de5a7b0`:

- Cursor: `8cd4eddcec9193b82dbe8d5b417f827ed4ce1766`.
- Claude: `887e8e7d863211f266068c837674cb7a72f3dfe2`.
- Codex: `c284ace4ff9f7a5a5abb7269a220d173e8eacad5`.

## Findings

### 1. [P2] Cursor's prose expands the approved map beyond its two documentation files

**Plan claim/section:** The two Exact File List sections authorize only
`docs/repo-map.md` and `docs/issue-210-agent-cli-extension.md`, and Reuse and
Scope promises no runtime changes. However, Alternatives Rejected backticks
`scripts/` and `docs/setup-workspace.md` outside Reuse and Scope; other sections
also introduce file-shaped tokens.

**Rule:** A documentation-only plan must mechanically approve only its intended
documentation edits. The current extractor in `src/evidence.ts:146` scans
backticked paths throughout the plan after removing Reuse and Scope; negations
and an Alternatives heading do not exempt a path.

**Concrete failure:** Running the existing `extractApprovedPaths` on Cursor's
bound file returns six entries:
`docs/issue-210-agent-cli-extension.md`, `docs/repo-map.md`,
`docs/setup-workspace.md`, `documentation.paths`, `repo-map.md`, and `scripts/`.
The directory entry authorizes changes anywhere under the product scripts
tree, despite the two-file promise. Later file-map validation therefore cannot
enforce the intended documentation boundary.

**Smallest correction:** Put backticked research-only paths inside Reuse and
Scope, or remove their code formatting elsewhere. Assert that the extractor
returns exactly the two intended document paths before republishing.

### 2. [P2] Claude's exclusions and inventory authorize most of the product tree

**Plan claim/section:** Exact File List to be changed or deleted says “None”
and lists `src/**`, `scripts/**`, `githooks/**`, `templates/**` and `test/**` as
untouched. The created-file section then contains backticked inventory and
Muse references; Tests and Alternatives introduce more paths outside Reuse
and Scope.

**Rule:** The approved map must contain only the report this plan intends to
create. Backticked exclusions are still executable scope inputs to
`extractApprovedPaths`; the extractor does not interpret “stay untouched.”

**Concrete failure:** Evaluating Claude's bound plan produces 42 approved
entries, including `src/**`, `scripts/**`, `githooks/**`, `templates/**`,
`test/**`, `docs/`, `README.md`, `AGENTS.md`, and both example configuration
files. A later implementation can change source, hooks, tests or configuration
without failing the approved-path check, contrary to the one-document scope.

**Smallest correction:** Keep only the new report as a backticked file-map
path outside Reuse and Scope. Move research inventory into that excluded
section or remove path formatting from prose and exclusions; validate that the
resulting approved map has exactly one entry.

### 3. [P2] Claude's Muse evidence rule leaves documented integration contracts unassessed

**Plan claim/section:** The Muse facts block leaves hook execution and payload
shapes open. Tests item 3 permits a verified Muse statement only when supported
by `muse --version`, `muse --help`, or `muse export --help`, and requires
everything else to remain open. Risks repeats that hook support stays open.

**Rule:** The requested Muse assessment must investigate available primary
documentation for the integration seams. It must distinguish a documented
contract from an untested live behavior; lack of a help entry does not make a
documented contract unknowable.

**Concrete failure:** Following that evidence rule prevents the report from
mapping existing, documented hook installation and shell-guard contracts.
Meta's versioned [Muse hooks reference](https://meta-models.github.io/muse-code-sdk/1.4/guides/extend/hooks/)
documents the project hook file, JSON layout, lifecycle events, tool matching,
trust requirement and pre-tool denial response. Those directly inform coord's
hook installation, normalization and containment changes, but none is
established by the plan's three allowed help/version commands. The owner
would receive an incomplete future change map with those facts still open.

**Smallest correction:** Add versioned primary-documentation research and a
separate “documented; live behavior unverified” evidence category. Reserve
open questions for facts absent from both documentation and permitted local
observations. Live sessions or installation are not needed for this correction.

### Scope, reuse, new files and test assessment

All three plans correctly interpret the issue as an assessment and avoid
implementing Muse or a registry during this issue. Each justifies a standalone
report. Cursor's repo-map link and Codex's README link are reasonable, small
discoverability changes; Claude's single-file deliverable is also sufficient.
All reuse the existing launcher, lifecycle, setup, trust and telemetry code as
evidence and avoid unnecessary new runtime abstractions or dependencies.

All three appropriately propose no new behavior tests. Cursor and Claude use
manual source/citation checks and the installed hook checks; Codex additionally
names the existing `pnpm check:docs` script and explicitly distinguishes it
from factual inventory validation. They correctly acknowledge the new report
is outside the frozen documentation allowlist. Codex identifies concrete
existing test files and fixtures, separates minimum support from optional
capabilities, and includes primary Muse sources and migration constraints.
I found no blocking issue in the bound Codex plan.

### Validation performed for this review

Read all three bound files directly and inspected the current scope extractor.
Invoked the existing `extractApprovedPaths` helper on each exported plan to
investigate scope: Cursor returned six entries, Claude 42, and Codex exactly
`README.md` plus `docs/issue-210-agent-cli-analysis.md`. Checked Meta's versioned
hook reference on 2026-10-15 for finding 3. No product suite was run for this
coordination-evidence review, and no coordinator result is claimed.

## Conclusion

- **Cursor — revise:** narrow the mechanically extracted map to its two
  intended documentation files. Its research/deliverable scope is otherwise
  appropriate.
- **Claude — revise:** narrow the map to its one intended report and broaden
  the Muse evidence method to include primary documentation.
- **Codex — acceptable:** its extracted scope matches the two declared files,
  and its evidence and validation method covers the requested assessment.

Prefer the Codex plan as currently published. Either peer plan can become
acceptable with the specific corrections above; no product refactor or extra
test suite is needed to correct these plan findings.

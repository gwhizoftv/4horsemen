# Implementation Plan — Issue 158: Restructure README to be friendly and accessible for open source release

## Exact File List to be changed or deleted

- `README.md` (to be changed: restructure into an engaging, developer-friendly open-source landing page with a hero header, value propositions, GitHub-native Mermaid consensus workflow diagram, 3-step quickstart, product language table, and clean documentation index)
- `docs/coord-driver.md` (to be changed: receive the low-level vendor quota evidence and resource holds specification moved out of root `README.md`)
- `test/verify-config.test.ts` (to be changed: add test coverage verifying `README.md` open-source landing page structure, Mermaid diagram syntax, doc links, and removal of internal release checklist gates)

## Exact file list to be created

None. (No new production or test files are required; documentation verification is integrated directly into existing test suites.)

## Reuse and Scope

### Existing Artifacts and Code Reused
- `test/verify-config.test.ts`: Reuse `repoRoot`, `describe("shipped examples")`, `readFileSync`, and path resolution helpers to validate that `README.md` satisfies open-source formatting rules, contains valid relative documentation links, and excludes internal release gates.
- `docs/coord-driver.md`: Reuse existing operator guide sections, appending `## Vendor quota evidence and resource holds` to maintain full operational documentation for Claude status-line telemetry and Codex stdio socket helpers.
- `README.md`: Reuse core commands (1-line bootstrap script, `coord onboard`, `coord <issue>`, manual mode, owner controls) and supported language information, rewriting them with high clarity and eliminating internal release checklist clutter.
- Issue 158 specification: Reuse the exact GitHub-native Mermaid.js consensus workflow diagram from the issue specification, detailing the lifecycle from GitHub issue to ready-to-merge pull request.

### Scope Justification
- Zero new production files: The task is strictly documentation restructuring and operator guide consolidation.
- Zero new test files: Documentation checks belong within `test/verify-config.test.ts`, which already validates shipped examples, `CONTRIBUTING.md`, `SECURITY.md`, and `README.md` cleanliness.
- Smallest complete change: Focus only on restructuring `README.md`, moving low-level vendor quota mechanics to `docs/coord-driver.md`, and adding a focused test in `test/verify-config.test.ts`.

## Tests

### Proposed Test Additions
Extend `test/verify-config.test.ts` in the `describe("shipped examples")` block with a focused test case:
- `it("structures README.md as an accessible open-source landing page with Mermaid workflow and valid links")`:
  1. Asserts `README.md` begins with `# coord` and contains the primary value proposition / tagline (*"Multi-agent consensus engine and workflow driver for autonomous software development"*).
  2. Asserts `README.md` embeds the GitHub-native Mermaid consensus workflow diagram (````mermaid\nflowchart TD ... MultiAgentTeam ... ConsensusLoop ... VerificationGate````).
  3. Asserts key developer-facing sections are present:
     - `## How it works` (or `## How It Works`)
     - `## Key value propositions` (or `## Why coord`)
     - `## Quick start` (or `## Quick Start`)
     - `## Requirements` (preserving `#requirements` anchor referenced by `CONTRIBUTING.md:24`)
     - `## Supported languages` (or `## Product language support`)
     - `## Documentation`
  4. Asserts internal release gate checklist notes (such as references to `issue #139` or internal release gates) are completely removed from `README.md`.
  5. Asserts all relative markdown links in `README.md` (e.g., `docs/coord-driver.md`, `docs/setup-workspace.md`, `CONTRIBUTING.md`, `SECURITY.md`) resolve to actual existing files on disk.

### Test Failure and Pass Criteria
- **Fails before change:** The test fails against current `README.md` because `README.md` contains references to `issue #139`, lacks the Mermaid consensus diagram, and does not have the structured open-source landing page sections.
- **Passes after change:** The test passes cleanly once `README.md` is updated and `test/verify-config.test.ts` is in place.

## Alternatives Rejected

1. **Static raster or SVG banner images:**
   - *Rejected:* Adding external or repo-tracked static graphic assets (e.g. `.png` or `.svg`) bloats git history and can break when rendered across light/dark modes. The GitHub-native Mermaid.js flowchart renders seamlessly in GitHub, adapts to themes, and stays maintainable in plain text.
2. **Discarding low-level vendor quota and socket helper details entirely:**
   - *Rejected:* Completely deleting the Claude status-line tee mechanics and Codex stdio socket specifications would lose critical operational reference material for operators configuring quota telemetry. Relocating this technical reference to `docs/coord-driver.md` maintains documentation depth without cluttering the landing page.
3. **Creating a new dedicated test file (e.g., `test/readme.test.ts`):**
   - *Rejected:* `test/verify-config.test.ts` already hosts shipped example and release-readiness doc checks. Adding another test file introduces unnecessary test file proliferation.
4. **Keeping the internal release checklist for issue #139 in the root README:**
   - *Rejected:* Issue #158 explicitly identifies internal release gate notes as inappropriate for a public open-source front door.

## Risks and Mitigations

1. **Breaking external or cross-document anchors:**
   - *Risk:* `CONTRIBUTING.md:24` references `[requirements](README.md#requirements)`. Modifying section headers could break this link.
   - *Mitigation:* Preserve the exact heading `## Requirements` so that the `#requirements` slug remains stable. The test in `test/verify-config.test.ts` will verify that `CONTRIBUTING.md` anchor references continue to resolve.
2. **Forbidden machine paths or private repository phrasing:**
   - *Risk:* Accidental inclusion of local filesystem paths (`/Volumes/`, `/Users/`) or phrases matching `repo is private` will fail `test/verify-config.test.ts`.
   - *Mitigation:* Ensure only generic paths (e.g., `/path/to/my-repo`, `~/.local/bin`) are used and verify with `pnpm check:fast`.
3. **Mermaid rendering syntax incompatibilities:**
   - *Risk:* Malformed Mermaid syntax could cause GitHub to render an error box instead of a flowchart.
   - *Mitigation:* Use the exact, verified Mermaid code provided in Issue #158.

## Conclusion

By restructuring `README.md` into an open-source landing page, embedding the native Mermaid consensus lifecycle diagram, presenting a frictionless 3-step quickstart, relocating internal socket/quota diagnostics to `docs/coord-driver.md`, and reinforcing documentation integrity via `test/verify-config.test.ts`, this plan fulfills all requirements of Issue #158 with minimal, focused changes.

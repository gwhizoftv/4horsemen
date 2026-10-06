# Plan Review — Issue 158: Restructure README for open source release

## Findings

### Finding 1: Disregarding owner directives on workflow flowchart and hero banner (Cursor `7505af06`, Codex `ffbd4c5e`, Antigravity `9600e6a`)
- **Plan claim or section:** Cursor (Sections "Exact file list to be created" / "Alternatives Rejected"), Codex (Section 2 "How it works" / "Alternatives Rejected"), and Antigravity (Sections "Tests" / "Alternatives Rejected") propose using a GitHub-native Mermaid.js flowchart in `README.md` for the consensus loop, and either omit the hero banner entirely or invent an SVG banner (`docs/assets/coord-banner.svg`), rejecting raster images.
- **Rule that must hold:** Authoritative instructions provided by the repository owner on the issue override initial issue descriptions. In comments on issue #158 (issuecomment-6004633167 and issuecomment-6008656761), the owner provided specific image assets for both the top banner (`coord-banner.jpg`) and the workflow flowchart (`coord-workflow.jpg`), explicitly directing: *"Here is the flowchart diageran, do not use Mermaid"*.
- **Concrete failure:** If Cursor's, Codex's, or Antigravity's plan is followed as written, the README will embed a Mermaid diagram and omit the owner's banner graphic, directly violating the owner's explicit directive not to use Mermaid and discarding the owner's supplied artwork.
- **Smallest correction:** Adopt the approach in Claude's plan (`7d960d66`): create `docs/images/coord-banner.jpg` and `docs/images/coord-workflow.jpg` using the owner-supplied assets, embed them in `README.md`, and omit the Mermaid code block.

### Finding 2: Unnecessary scope expansion to `docs/setup-workspace.md` (Codex `ffbd4c5e`)
- **Plan claim or section:** Codex Section "Exact File List to be changed or deleted" lists `docs/setup-workspace.md` for modification to preserve maintainer release-readiness checklist notes removed from the README.
- **Rule that must hold:** Implementation must stay strictly within the issue scope and avoid unnecessary modifications to stable documentation. `docs/setup-workspace.md` and `SECURITY.md` already contain comprehensive setup instructions and pre-release notes; issue #158 only calls for removing internal checklist noise from the root README landing page.
- **Concrete failure:** Modifying `docs/setup-workspace.md` unnecessarily expands the file map and increases review surface for material that is already sufficiently covered in the existing documentation tree.
- **Smallest correction:** Remove `docs/setup-workspace.md` from the file list to be changed, limiting edits to `README.md`, `docs/coord-driver.md`, and the new image assets under `docs/images/`.

### Finding 3: Brittle marketing copy and Mermaid assertions in test suite (Antigravity `9600e6a`)
- **Plan claim or section:** Antigravity Section "Tests" proposes adding assertions in `test/verify-config.test.ts` to assert specific headings, marketing taglines, and Mermaid syntax tokens in `README.md`.
- **Rule that must hold:** Automated test suites must verify executable logic and system invariants rather than volatile landing-page prose. Furthermore, asserting Mermaid tokens (`flowchart TD`) directly conflicts with the owner's instruction not to use Mermaid.
- **Concrete failure:** The test will fail immediately when the owner's workflow diagram image is used instead of Mermaid, and adding regex checks on marketing text introduces permanent test churn for future documentation edits.
- **Smallest correction:** Drop automated test additions in `test/verify-config.test.ts`. Rely on existing `pnpm check:fast` to ensure no executable regressions, and verify doc links and image targets using repository link checks as proposed by Claude and Cursor.

### Finding 4: Ambiguous inclusion of `CONTRIBUTING.md` in file modification list (Cursor `7505af06`)
- **Plan claim or section:** Cursor Section "Exact File List to be changed or deleted" lists `CONTRIBUTING.md` as a file to be changed if the anchor moves.
- **Rule that must hold:** The file map must contain only files that will definitely be changed. `CONTRIBUTING.md` references `README.md#requirements`, which is preserved by retaining the `## Requirements` section in `README.md`.
- **Concrete failure:** Listing `CONTRIBUTING.md` in the exact file list creates ambiguity about whether product contribution policy will be modified.
- **Smallest correction:** Retain `## Requirements` in `README.md` and remove `CONTRIBUTING.md` from the exact file list to be changed.

### Finding 5: Dynamic subshell command substitution in download instructions (Claude `7d960d66`)
- **Plan claim or section:** Claude Section "Exact file list to be created" prescribes downloading the images using `curl -fsSL -H "Authorization: token $(gh auth token)" <source> -o <path>`.
- **Rule that must hold:** Terminal automation policies prohibit dynamic command substitution subshells like `$(gh auth token)`.
- **Concrete failure:** If executed verbatim in an automated terminal hook or tool that enforces subshell bans, the command will be rejected by pre-tool hooks or shims.
- **Smallest correction:** Resolve the auth token beforehand or pass the token value directly without using `$()` command substitution.

## Conclusion

- **Cursor (`7505af067f6b4e672ed94585899d723569dc73bb`):** Offers a thorough understanding of documentation thinning and relocation to `docs/coord-driver.md`. However, it missed the owner's explicit comments on issue #158, incorrectly relies on Mermaid, rejects the owner's banner graphic, and lists `CONTRIBUTING.md` conditionally in the change map.
- **Codex (`ffbd4c5e3a72384f09864201b475ab8786ad5b96`):** Provides thoughtful technical analysis of workflow accuracy, PR policy, and qualifications. However, it missed the owner's comments, proposed generating a new SVG banner and Mermaid diagram (violating the owner's directive), and unnecessarily expanded scope to `docs/setup-workspace.md`.
- **Antigravity (`9600e6a6da17cb31f7d347498203978eb580ab22`):** Correctly identified key landing page sections, but missed the owner's issue comments, proposed Mermaid, and introduced brittle test assertions in `test/verify-config.test.ts`.
- **Claude (`7d960d66c03aa5e40a411c7e2a73a414628c8df5`):** The only plan that tracked the owner's authoritative comments on issue #158. It correctly adopts the owner's supplied hero banner and workflow diagram JPEGs, respects the owner's directive not to use Mermaid, cleanly relocates the unique vendor-quota and `coord next` prose into `docs/coord-driver.md`, keeps the change surface minimal, and avoids brittle test churn.

**Verdict:** Select **Claude's plan (`7d960d66c03aa5e40a411c7e2a73a414628c8df5`)** as the winning implementation plan. The implementer should execute asset downloads without using dynamic subshell syntax.

# Code Review — Issue 158

## Comparison

This review compares the four bound implementation pins:
- cursor: `73fd76fe0bdd4b10bf8b562f6b8533fcac7fa6a9`
- codex: `b76f4ed44679df78d107d1de66142a6983dc8f20`
- antigravity: `a907f2fc2f5ac5aedd7cf2ef8b295acfe61ffb04`
- claude: `083a7d3189003733302049c1f317df9d0c84a2fa`

All four implementations successfully converged on the architecture established by the approved plan:
1. Replaced the internal specification dump in `README.md` with an open-source landing page featuring the owner-supplied banner and workflow flowchart JPEGs, accurate consensus lifecycle steps, five key value propositions, a 3-step quickstart, supported language matrix, and a clean documentation index.
2. Committed the exact owner-provided artwork at `docs/images/coord-banner.jpg` and `docs/images/coord-workflow.jpg` matching authoritative sha256 digests.
3. Preserved operator reference documentation by relocating the unique vendor-quota evidence and `coord next` passages to `docs/coord-driver.md`.
4. Maintained the `## Requirements` section heading to ensure incoming links from `CONTRIBUTING.md:24` continue to resolve.

### Finding 1: Incorrect Implementation Commit Pin and Mixed Signal in Cursor (`73fd76fe0bdd4b10bf8b562f6b8533fcac7fa6a9`)

- **File path and line number:** `.signals/issue-158/implementation-ready-cursor.json:8`
- **Rule that must hold:** An implementation-ready signal must pin the commit containing the product deliverables (`implementationCommitSha`), and product commits should remain decoupled from coordination signal artifacts.
- **Concrete failure:** Cursor pinned `ea29042984adce68678c49d23a77b320a1ec1595` in its signal JSON, which is Cursor's plan review commit, not an implementation commit. If the pinned commit is checked out, none of the restructured README content, driver guide updates, or image assets exist. In addition, Cursor committed the signal JSON directly into its product commit `73fd76fe0bdd4b10bf8b562f6b8533fcac7fa6a9`, conflating product code with coordination evidence.
- **Smallest illustrative test:**
  ```sh
  # Verifying that the pinned commit contains the required product changes:
  git cat-file -e ea29042984adce68678c49d23a77b320a1ec1595:docs/images/coord-banner.jpg
  # Fails with exit code 128: fatal: path 'docs/images/coord-banner.jpg' does not exist in 'ea29042984adce68678c49d23a77b320a1ec1595'
  ```
- **Fix sketch:** Separate product changes from signal artifacts, and ensure `implementationCommitSha` in the signal JSON matches the 40-character SHA of the product commit.

### Comparison of Clean Implementations: Claude, Codex, and Antigravity

- **Claude (`083a7d3189003733302049c1f317df9d0c84a2fa`):**
  - Exceptionally clean and concise README structure (153 lines).
  - Uses responsive image width (`width="100%"`) and descriptive alt text.
  - Accurately details the 7 lifecycle steps of the consensus loop and distinguishes profiles with clear links.
  - Relocated vendor quota section and `coord next` into `docs/coord-driver.md` with seamless reconciliation of the historical unknown-hold note.
  - Clean separation between product commit and coordination signal.

- **Codex (`b76f4ed44679df78d107d1de66142a6983dc8f20`):**
  - Highly accurate, nuanced prose explaining that the flowchart is a high-level overview and explicitly qualifying sandbox isolation.
  - Minor visual drawback: Sets a fixed `width="880"` on the hero banner instead of full responsive width (`100%`).
  - Thorough documentation index and complete relocation of operator details to `docs/coord-driver.md`.
  - Clean separation between product commit and coordination signal.

- **Antigravity (`a907f2fc2f5ac5aedd7cf2ef8b295acfe61ffb04`):**
  - Fully implements the approved plan outline with high clarity.
  - Includes responsive image presentation, clean badges, and comprehensive documentation index.
  - Verified all local relative links and image targets.
  - Preserves full operator documentation in `docs/coord-driver.md`.
  - Clean product commit pinned by signal.

### Scope, Reuse, and Check Acceptance

All four implementations remained strictly within the approved file map (`README.md`, `docs/coord-driver.md`, and `docs/images/*.jpg`). No unnecessary files or code refactors were introduced. All four pass repository checks.

**Recommendation:** Claude's pin (`083a7d3189003733302049c1f317df9d0c84a2fa`) and Antigravity's pin (`a907f2fc2f5ac5aedd7cf2ef8b295acfe61ffb04`) represent the cleanest, most responsive implementations of the approved plan.

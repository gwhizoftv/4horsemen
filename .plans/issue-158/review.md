# Plan review — issue 158

Reviewed pins:
- cursor `7505af067f6b4e672ed94585899d723569dc73bb`
- claude `7d960d66c03aa5e40a411c7e2a73a414628c8df5`
- codex `ffbd4c5e3a72384f09864201b475ab8786ad5b96`
- antigravity `9600e6a6da17cb31f7d347498203978eb580ab22`

Facts used below, checked against baseline `26ff2c00`:
- Issue comment 1 (owner) supplies the hero banner JPEG.
- Issue comment 2 (owner) supplies the workflow flowchart JPEG and says
  "**do not use Mermaid**".
- `LICENSE` exists (MIT, © 2026 Michael Glenn Williams).
- `CONTRIBUTING.md:24` links `README.md#requirements`.
- `test/verify-config.test.ts` ("shipped examples") scans `README.md` and
  every `docs/*.md` for `/Volumes/`, `/Users/<x>`, and "repo is private"
  wording.

## Findings

### F1 — cursor, antigravity, codex: "How it works" uses a Mermaid flowchart

- **Plan claim:**
  - cursor's file list and Conclusion: "Mermaid how-it-works", "using
    GitHub-native Mermaid".
  - antigravity's file list and Tests: it embeds "the exact GitHub-native
    Mermaid.js consensus workflow diagram" and asserts it.
  - codex's README item 2: "a GitHub-native `mermaid` flowchart".
- **Rule:** The issue owner's latest instruction controls the issue's
  optional design suggestions. Comment 2 says "do not use Mermaid" and
  supplies the flowchart image to use instead.
- **Failure:** An implementation that follows any of these plans ships a
  ```` ```mermaid ```` block the owner explicitly rejected, and it never shows
  the supplied flowchart. Peer code review must then reject the work, or a
  revision round is spent replacing the diagram. For antigravity it is worse:
  the new test asserts that the Mermaid block (`MultiAgentTeam`,
  `ConsensusLoop`, `VerificationGate`) is present. A correct README (no
  Mermaid) would fail `pnpm check:fast`, so the test locks in the rejected
  design.
- **Correction:** Commit the comment-2 image (e.g.
  `docs/images/coord-workflow.jpg`), embed it, and describe the steps in prose.
  Drop the Mermaid block. Drop antigravity's Mermaid assertion.

### F2 — cursor, antigravity, codex: the owner-supplied hero banner is not used

- **Plan claim:**
  - cursor's file list says "No banner PNG/SVG"; its Alternatives Rejected
    puts the banner in a follow-up.
  - antigravity's Alternatives Rejected item 1 rejects static banner images.
  - codex's created file is `docs/assets/coord-banner.svg`, "one small,
    original … vector hero asset", and it rejects "a raster/AI-generated
    banner".
- **Rule:** The issue asks for a hero banner above the title. The owner has
  supplied that exact asset in comment 1, so the plan must use it rather than
  omit it or substitute new artwork.
- **Failure:**
  - cursor and antigravity ship a README with no hero banner, leaving an
    issue requirement the owner already resolved unmet.
  - codex hand-draws a different banner. That adds an unreviewed design
    asset, plus SVG validation and visual-review work, while the owner's
    artwork is dropped.
  - All three leave the owner's attachment unused.
- **Correction:** Commit the comment-1 JPEG byte-for-byte (e.g.
  `docs/images/coord-banner.jpg`) and embed it above `# coord`.

### F3 — claude, Conclusion → README outline item 5: `## Requirements` is folded into "Quick start"

- **Plan claim:** Outline item 5 is "**Quick start.** Requirements: …" and has
  no separate `## Requirements` heading. The Tests link check (item 2) covers
  only links *from* `README.md`.
- **Rule:** Incoming repository links to README anchors must keep resolving.
  `CONTRIBUTING.md:24` links `README.md#requirements`.
- **Failure:** If the README is built from the outline as written, the
  `#requirements` anchor disappears. The CONTRIBUTING link then lands at the
  top of the README, and no planned check catches it.
- **Correction:** Keep a `## Requirements` heading, either as its own section
  or immediately before Quick start. Extend Tests check 2 to also confirm
  that `grep -n '^## Requirements$' README.md` matches.

### F4 — cursor, Risks "Scope creep into LICENSE": license kept as "planned MIT / deferred file"

- **Plan claim:** "license remains 'planned MIT / deferred file' as today".
- **Rule:** The README must not contradict tracked files. `LICENSE` is
  present at the baseline, and the issue asks to remove stale
  internal-release prose from the README.
- **Failure:** The rewritten README would say the license file has not landed
  while GitHub's sidebar shows MIT from `LICENSE`. A first-time reader sees
  two conflicting statements about whether they may use the code.
- **Correction:** State "MIT — see [LICENSE](LICENSE)", as the claude and
  codex plans do.

### F5 — antigravity, Tests: a vitest case asserts README marketing copy

- **Plan claim:** The new `it(...)` in `test/verify-config.test.ts` asserts:
  - an exact tagline;
  - specific heading spellings;
  - the Mermaid node identifiers.
- **Rule:** Tests must be focused on behaviour. Prose assertions must not
  lock in content the owner has overruled.
- **Failure:** Beyond F1, any later copy edit (heading rename, tagline tweak)
  fails `pnpm check:fast`. The required suite becomes a gate on README
  wording, adding permanent maintenance for no runtime behaviour. The
  `#requirements` and relative-link assertions are the only parts tied to a
  real breakage.
- **Correction:** Remove the test. If the team wants a durable check, keep
  only a link/anchor existence case, without tagline, heading, or Mermaid
  assertions.

### F6 — codex, Exact File List: `docs/setup-workspace.md` gains a maintainer release checklist

- **Plan claim:** Add "the unique maintainer release-readiness checklist
  removed from the README" to `docs/setup-workspace.md`.
- **Rule:** Keep changes within the issue. Do not create a second
  authoritative copy of release gates whose source of truth is issue #139.
- **Failure:** `docs/setup-workspace.md:57-58` already says "Owner release
  gates remain in issue #139" and links it. Copying the checklist creates a
  third location (issue, SECURITY.md, setup guide) that will go stale once
  #139's gates change or pass. The setup guide is a newcomer install path, so
  it would then show public readers outdated pre-release duties.
- **Correction:** Leave `docs/setup-workspace.md` unchanged. The existing
  #139 link already preserves the duties.

### Scope and reuse assessment

- **claude:**
  - Uses both owner assets.
  - Moves exactly the two README passages that exist nowhere else
    (vendor quota, `coord next`) into `docs/coord-driver.md`.
  - Accounts for every current README section in a disposition table.
  - Corrects the license text.
  - Grounds profile, revision-cap, and PR-policy claims in `src/state.ts`,
    `src/ownerControls.ts`, and `docs/coord-driver.md`.
  - Adds no tests and only scripted checks.
  - Remaining defect: F3.
- **codex:**
  - Strongest accuracy guidance: it does not copy the issue mock's single
    implementer, check→implement loop, or "ready-to-merge" claims, and it
    keeps `#requirements`.
  - Defects: F1, F2, F6.
- **cursor:**
  - Minimal and correctly relocates the vendor-quota section, and keeps
    `#requirements`.
  - Defects: F1, F2, F4. It also leaves the README-only `coord next`
    paragraph without a stated destination, so dropping it from the README
    deletes the only copy.
- **antigravity:**
  - Defects: F1, F2, F5. It also leaves `coord next` without a destination,
    like cursor.

## Conclusion

No plan can be implemented exactly as written.

**claude** is the closest to the owner's current instructions and to the
existing docs. Its single defect (F3) is a one-heading correction that stays
inside its approved file map. I recommend selecting **claude**, with F3 applied
during implementation.

The other three plans each conflict with the owner's explicit "do not use
Mermaid" direction and ignore the supplied artwork (F1, F2). Implementing any
of them would require replacing the diagram and banner, so they are not
recommended.

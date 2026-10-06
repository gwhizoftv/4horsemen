# Implementation comparison — issue 158

## Comparison

### Pins compared

| Agent | Implementation pin |
|---|---|
| cursor | `73fd76fe0bdd4b10bf8b562f6b8533fcac7fa6a9` |
| codex | `b76f4ed44679df78d107d1de66142a6983dc8f20` |
| antigravity | `a907f2fc2f5ac5aedd7cf2ef8b295acfe61ffb04` |
| claude | `083a7d3189003733302049c1f317df9d0c84a2fa` |

Each pin was read from its bound worktree. `docs/coord-driver.md` was diffed
against baseline `26ff2c00`.

### Common ground (all four pins)

- **Scope.** Each pin changes the same four product paths: `README.md`,
  `docs/coord-driver.md`, `docs/images/coord-banner.jpg`, and
  `docs/images/coord-workflow.jpg`. All are inside the approved map. No source,
  test, hook, or config file changes, and no pin adds a test.
- **Images.** Each pin commits both owner JPEGs byte-for-byte:
  - banner sha256 `c77ae657…`
  - workflow sha256 `a036510f…`
- **Owner instructions.** No pin contains a ```` ```mermaid ```` block or an
  issue-#139 release-gate reference.
- **Anchors.** Each pin keeps `## Requirements`, so `CONTRIBUTING.md:24`
  (`README.md#requirements`) still resolves.
- **Links.** A scripted check resolved every relative link and every
  `#fragment` in each README against real files and headings, with no
  failures.
- **License.** Each pin says "MIT — see LICENSE".
- **Moved content.** Each pin moves the vendor-quota section and the
  `coord next` passage into `docs/coord-driver.md`. Each also rewrites the stale
  "no … statusline installation" paragraph so it points to the new subsection.
- **Prose accuracy.** Each pin's README text correctly says:
  - every active agent implements under `consensus`;
  - revision runs at most three rounds;
  - finalization checks block the PR;
  - `coord-open-unmerged` leaves a draft and `coord-merged` merges.

The differences are in accuracy details and in how much leftover
operator-guide text each pin tidied.

### Findings

#### 1. antigravity — `README.md:116`: Python row lists detection markers that coord does not detect

- **Rule:** The language table must not imply auto-detection where none
  exists. `docs/setup-workspace.md` § Product languages says Python works only
  through an explicit declaration today, and `pyproject.toml`/uv are not
  detected. `proposeProjectPolicy` in `src/setupWorkspace.ts` has no Python
  branch.
- **Failure:** The row's "Detection Marker" column lists
  `pyproject.toml, requirements.txt` for Python. A Python user reading it
  expects `coord onboard` to recognise their project. Onboard is then refused
  because "a product whose checks cannot be inferred is refused before a clone
  exists" (`docs/setup-workspace.md:128-129`). The README sent them down the
  path that fails.
- **Fix sketch:** Put `—` (or "none — declare checks") in the marker column, as
  cursor, codex, and claude do.

#### 2. antigravity — `README.md:132`: wrong description of `docs/readiness-policy.md`

- **Rule:** The documentation index must describe each linked guide
  accurately. `docs/readiness-policy.md` covers which of the three agent
  signals (terminal scrape, hooks, workflow) wins for which question, and the
  refusal reason codes.
- **Failure:** The index calls it "Agent protocol and participation evidence
  rules". An operator looking for the participation-signal or completion
  protocol opens the wrong guide. An operator debugging a delivery refusal
  skips the right one.
- **Fix sketch:** Use wording like codex's ("Agent delivery readiness,
  lifecycle hooks…") or claude's ("which agent signal wins … and every refusal
  reason code").

#### 3. cursor and antigravity — `docs/coord-driver.md` § Agent completion contract (cursor lines 448–451, antigravity lines 448–451): the moved `complete` paragraph repeats the section it lands in

- **Rule:** Relocated text must not duplicate a contract already stated in its
  destination section. One authoritative statement avoids drift.
- **Failure:** The same section already says, a few lines above (baseline
  lines 411–431), that only `complete` expresses intent and that only the
  40-hex or `commit <sha>` forms are accepted. If the accepted completion forms
  ever change, two paragraphs in one section must be updated. Missing one
  leaves the guide contradicting itself on the format the driver rejects.
- **Fix sketch:** Move only the `coord next` passage, as codex and claude do.

#### 4. claude, cursor, antigravity — `docs/coord-driver.md` (claude lines 674–678): stale PR-scoped wording kept next to the relocated #140 material

- **Rule:** The operator guide should describe current behaviour, not the
  scope of a past pull request. This matters most right after material from
  the later issue has been moved in.
- **Failure:** The paragraph still says "does not resume the coordinator in
  #126 … Native completion-based recovery belongs to #140; this PR prioritizes
  …". It now sits a few lines above the #140 vendor-evidence subsection. A
  reader can take "belongs to #140" to mean native completion recovery has
  shipped, or is promised by the section below, though neither is true. "This
  PR" also refers to no PR the reader can see.
- **Fix sketch:** Codex's edit: "Claude native continuation alone does not
  resume the coordinator …", dropping the #126/#140/"this PR" clauses. The
  behavioural statement stays unchanged.

#### 5. claude — `README.md` How it works, step 4: who implements is left unstated

- **Rule:** Numbered workflow steps should say who acts at each step.
- **Failure:** Step 4 reads "The selected plan is implemented and pinned to an
  exact pushed commit". Read alone, it matches the image's "selected agent
  implements" simplification. The profile paragraph two lines later corrects
  this, but a skimming reader stops at the list.
- **Fix sketch:** Cursor's step 4 wording ("every active agent implements …
  Under `reviewed`, one designated implementer").

### Scope, reuse, and quality by pin

- **codex (`b76f4ed4…`):**
  - The most accurate and complete landing page.
  - Says that clones are "not a universal security sandbox" and that stopping
    the coordinator does not stop agent harnesses.
  - Says that a product needs a GitHub `origin`, and that installation refuses
    products whose checks cannot be inferred. Checked against
    `docs/setup-workspace.md:128-129`.
  - The only pin that removes the #126/#140 PR-speak (finding 4) and that does
    not duplicate the `complete` contract (finding 3).
  - At 170 lines it is the longest, but still well inside a skimmable landing
    page.
  - No findings.
- **cursor (`73fd76fe…`):**
  - Accurate, concise (149 lines), and the clearest implementer step.
  - Has findings 3 and 4.
- **claude (`083a7d31…`):**
  - Accurate, concise (152 lines), and the narrowest driver-guide diff.
  - Has findings 4 and 5.
- **antigravity (`a907f2fc…`):**
  - Has findings 1, 2, 3, and 4.
  - Also repeats the full manual-mode command block in the README, although the
    plan reduced it to a link.
  - Its README lines are unwrapped (single-line paragraphs), unlike the
    repository's wrapped Markdown style.

**Ranking: codex, cursor, claude, antigravity.**

- I recommend **codex `b76f4ed44679df78d107d1de66142a6983dc8f20`**. It is the
  only pin with no findings, and it best resolves the plan-review concerns
  about stale hold prose and accuracy.
- Cursor and claude are close behind. Each needs only small wording edits
  within approved files.
- Antigravity's Python row (finding 1) is a user-facing inaccuracy and should
  be fixed before it could be chosen.

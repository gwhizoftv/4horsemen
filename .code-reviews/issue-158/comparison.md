# Issue 158 — implementation comparison

Bound implementation pins (cite all):

- cursor `73fd76fe0bdd4b10bf8b562f6b8533fcac7fa6a9`
- codex `b76f4ed44679df78d107d1de66142a6983dc8f20`
- antigravity `a907f2fc2f5ac5aedd7cf2ef8b295acfe61ffb04`
- claude `083a7d3189003733302049c1f317df9d0c84a2fa`

## Comparison

All four implementations satisfy the selected plan's hard deliverables: owner
JPEG banner and flowchart at `docs/images/` with the expected sha256 values
(`c77ae657…` / `a036510f…`), no Mermaid and no issue-#139 release-checklist
prose in `README.md`, a stable `## Requirements` heading for
`CONTRIBUTING.md#requirements`, MIT/`LICENSE` wording, and relocation of the
README-only vendor-quota and `coord next` passages into
`docs/coord-driver.md`. None change TypeScript, hooks, or tests. Scope and
reuse are therefore aligned with the docs-only plan across the board.

### Shared strengths

- Visual contract: every pin embeds `docs/images/coord-banner.jpg` above
  `# coord` and `docs/images/coord-workflow.jpg` under How it works, matching
  owner comments 1–2.
- Operator continuity: each pin appends vendor-quota under Owner controls and
  `coord next` under Agent completion contract, and each replaces the old
  “no statusline installation” claim with a pointer or qualified wording so
  the guide is no longer self-contradictory.
- Landing-page shape: hero, workflow, value props, requirements, quick start,
  languages, docs index, development, license — without Mermaid.

### Differences that matter

1. **claude `083a7d3189003733302049c1f317df9d0c84a2fa` — `README.md:34-35`.**
   Step 4 says only “The selected plan is implemented and pinned…”. Rule: under
   `consensus`, prose must not repeat the flowchart’s single-implementer
   simplification (`participantsForStep` gives every active agent the
   implement step). Failure: a newcomer reading the numbered list alone
   believes one agent codes while peers only review, contradicting the profile
   paragraph two steps later (`README.md:45-48`) and the selected plan’s
   accuracy list. Fix sketch: say every active agent implements under
   `consensus` (as cursor/codex/antigravity already do). Test cannot express
   marketing accuracy; prefer the one-line prose fix.

2. **antigravity `a907f2fc2f5ac5aedd7cf2ef8b295acfe61ffb04` — `README.md:116`.**
   The Python row lists `pyproject.toml`, `requirements.txt` under “Detection
   Marker” while the policy column says `--declare`. Rule: Python has no
   auto-detection; markers that look like Go/Rust detection rows mis-teach
   onboard behavior. Failure: readers expect `coord onboard` to pick up
   `pyproject.toml` the way it picks up `go.mod`. Smallest fix: mark detection
   as “none / declare only”, matching setup-guide facts. Cursor and Claude
   avoid inventing Python path markers; Codex correctly says “no
   auto-detection yet”.

3. **antigravity `a907f2fc2f5ac5aedd7cf2ef8b295acfe61ffb04` — `README.md:92-104`.**
   A full “Owner-driven manual mode” subsection with commands is restored on
   the landing page. Rule: the selected disposition keeps manual mode as one
   sentence plus a docs link so the front page stays a newcomer path. Failure:
   the README re-accumulates operator surface the issue asked to thin.
   Prefer Claude/Codex/Cursor’s single-line link to
   `docs/coord-driver.md#owner-driven-manual-lifecycle`.

4. **cursor `73fd76fe0bdd4b10bf8b562f6b8533fcac7fa6a9` vs
   codex `b76f4ed44679df78d107d1de66142a6983dc8f20`.**
   Both state profile-accurate consensus implementation and draft vs
   `coord-merged` PR policy. Codex’s How it works (`README.md:23-43`) is the
   clearest about all-agent implement → compare → one reviser → owner
   escalation at the revision limit, and it explicitly disclaims “universal
   security sandbox” (`README.md:60-61`). Cursor is slightly shorter and still
   accurate (`README.md:33-42`). Neither introduces unnecessary files.

5. **claude outline vs Platforms.** Claude folds macOS/tmux/Windows notes into
   Requirements (`README.md:74-75`) instead of a separate `## Platforms`
   section. That is editorial, not incorrect; cursor/codex/antigravity keep an
   explicit Platforms heading closer to the plan outline.

### Verdict for selection

Prefer **codex `b76f4ed44679df78d107d1de66142a6983dc8f20`** for the most
accurate consensus/PR-policy prose without the Python-table or manual-mode
regressions. **cursor `73fd76fe0bdd4b10bf8b562f6b8533fcac7fa6a9`** is a close
second (accurate implementer wording, slightly less nuance on escalation).
**claude `083a7d3189003733302049c1f317df9d0c84a2fa`** matches the selected
plan’s structure and asset disposition but needs the consensus-implementer
sentence fixed before it is safer than codex/cursor. **antigravity
`a907f2fc2f5ac5aedd7cf2ef8b295acfe61ffb04`** meets the visual/relocation bar
but re-thickens the README and muddies Python detection.

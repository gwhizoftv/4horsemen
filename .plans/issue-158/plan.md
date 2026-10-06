# Issue 158: Restructure README for open-source landing

## Exact File List to be changed or deleted

- `README.md` — rewrite from dense operator dump into the issue blueprint landing page: hero/tagline, Mermaid how-it-works, value props, three-step quick start, product-language table, short requirements, documentation index, and brief development/license pointers. Remove root-README release-gate checklist prose (issue #139), the full vendor-quota/socket-style diagnostics block, and the long advanced-install / interactive-hotkey / quota essays; replace those with links into existing docs.
- `docs/coord-driver.md` — append (or extend the existing owner-controls / holds material with) the unique **Vendor quota evidence and resource holds** prose currently only in `README.md` (Claude status-line tee, Codex `codexQuota` binding, Cursor/Antigravity notes), so thinning the README does not delete the only copy of that operator contract. Add a short cross-link from any advanced-install summary that stays in the driver guide.
- `CONTRIBUTING.md` — keep the existing `[requirements](README.md#requirements)` link working by retaining a `## Requirements` heading in the rewritten README; change this file only if the anchor must move (prefer keeping the heading so this path stays unchanged).

## Exact file list to be created

- None for product/docs assets. No banner PNG/SVG, no screencast, no new `docs/*.md` page — Mermaid in `README.md` supplies the visual workflow without new binary maintenance. (This plan file is the coordination artifact for the planning action, not an implementation deliverable.)

## Reuse and Scope

Reuse, do not reinvent:

- Existing install/onboard/run command shapes already documented in `README.md` (`scripts/bootstrap.sh`, `coord onboard`, `coord N`, `coord manual` / `coord detach manual`).
- Product-language facts already maintained in `docs/setup-workspace.md` (Go/Rust/Node/Make auto-detect; Python via `--declare`) — README table is a summary that links there for detection precedence and Python declaration detail.
- Operator depth already in `docs/coord-driver.md` (runtime topology, owner controls, holds, recovery, profiles, tmux) and `docs/setup-workspace.md` (multi-product / nested layouts).
- Issue #158’s recommended Mermaid flowchart as the README diagram source, adapted only for factual accuracy against the real consensus loop (plan → plan review/ballot → implement → peer code review → revision rounds → toolchain checks → PR). Do not invent new workflow stages.
- Existing `CONTRIBUTING.md` and `SECURITY.md` as the documentation-index targets.

New work is limited to markdown restructuring and relocating unique README-only quota prose into `docs/coord-driver.md`. No TypeScript, hooks, config, workflow YAML, package metadata, tests, or new dependencies. No GenAI banner asset and no terminal screencast in this issue (issue marks screencast as follow-up; banner is optional and would add binary/review debt without changing behavior).

## Tests

Documentation-only change: there is no product behavior to unit-test, and existing suites only use disposable fixture `README.md` strings under temporary product trees (`test/support/workspaceFixture.ts` and similar) — they do not assert this repository’s landing page.

Validation for the implementation commit:

1. `pnpm check:fast` — must remain green (lint, typecheck, fast tests); named so implementers do not invent a doc-only escape hatch.
2. Manual README acceptance checklist (record in the PR body, not as new vitest):
   - Required sections present in order: hero (`# coord` + tagline + agent support line + one-paragraph overview), How it works (fenced `mermaid`), Key value propositions, Quick start (install → onboard → run), Product languages (table), Requirements (keeps `#requirements`), Documentation index (links to `docs/coord-driver.md`, `docs/setup-workspace.md`, `CONTRIBUTING.md`, `SECURITY.md`), plus short Development / License pointers without re-homing release-gate checklist text.
   - Root README contains no issue-#139 release-checklist narrative and no Claude tee / Codex `codexQuota` procedure blocks (those live under `docs/coord-driver.md` after the move).
   - Relative markdown links resolve; `CONTRIBUTING.md`’s `README.md#requirements` still lands on a heading.

No new test file. Prefer zero new cases over a brittle string-snapshot of marketing copy.

## Alternatives Rejected

- **Ship a GenAI/header banner PNG in this PR.** Issue suggests it as hybrid polish; rejected for scope — binary asset review, licensing, and light/dark maintenance without changing discoverability once Mermaid is present. Follow-up if desired.
- **Add an animated terminal screencast (`vhs` / asciinema).** Explicitly marked follow-up in the issue; out of scope here.
- **Create a new `docs/readme-deep-dive.md` (or similar) for relocated prose.** Rejected — `docs/coord-driver.md` is already the operator guide named by the issue’s documentation index; a third doc splits authority.
- **Delete vendor-quota detail without relocating it.** Rejected — that block is currently README-only; dropping it would silently remove the Claude tee / Codex binding contract from the tree.
- **Leave advanced install, hotkeys, and quota essays in the README and only prepend a hero.** Rejected — fails the issue’s problem statement (landing page vs internal engineering dump).
- **Add a vitest that greps README headings.** Rejected — high churn for marketing structure; manual checklist + `pnpm check:fast` is enough for docs-only work.

## Risks and Mitigations

- **Accuracy drift in the Mermaid diagram vs real workflow.** Mitigation: base the diagram on issue #158’s draft, then cross-check stage names against `docs/coord-driver.md` / current happy-path wording before publish; prefer plain stage labels over decorative claims.
- **Loss of operator detail when thinning README.** Mitigation: move the unique vendor-quota section into `docs/coord-driver.md` in the same commit as the README rewrite; README links to that guide for holds/quota depth.
- **Broken deep links** (`README.md#requirements` from `CONTRIBUTING.md`). Mitigation: keep a `## Requirements` heading (or update `CONTRIBUTING.md` in the same change if the heading must rename).
- **Outdated claim in `docs/coord-driver.md` that vendor-specific evidence is “tracked separately” / absent.** Mitigation: when relocating README quota prose, reconcile that paragraph so the driver guide does not contradict the moved contract.
- **Scope creep into LICENSE / public-release gates (#139).** Mitigation: license remains “planned MIT / deferred file” as today; SECURITY.md and setup docs keep their own #139 notes — this issue only stops repeating release-checklist language in the root README.

## Conclusion

Rewrite `README.md` into the six-part open-source landing structure from issue #158, using GitHub-native Mermaid for the consensus workflow and linking out for operator depth. Relocate README-only vendor-quota evidence into `docs/coord-driver.md` so documentation is not deleted. Defer banner artwork and terminal screencast. Validate with `pnpm check:fast` plus a short manual link/section checklist — no new automated tests.

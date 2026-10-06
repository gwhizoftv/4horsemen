# Plan review — issue 158

Bound plans reviewed:

- cursor `7505af067f6b4e672ed94585899d723569dc73bb`
- claude `7d960d66c03aa5e40a411c7e2a73a414628c8df5`
- codex `ffbd4c5e3a72384f09864201b475ab8786ad5b96`
- antigravity `9600e6a6da17cb31f7d347498203978eb580ab22`

Owner comments on issue #158 (authoritative over the original Mermaid blueprint): comment 1 supplies the hero JPEG; comment 2 supplies the flowchart JPEG and states **"do not use Mermaid"**.

## Findings

1. **cursor plan — Alternatives Rejected / Reuse and Scope (Mermaid-only, no banner).** The plan rejects a header banner and chooses GitHub-native Mermaid as the sole visual. Rule: issue comments from the owner supersede the issue body's earlier Mermaid recommendation; comment 2 forbids Mermaid and comment 1 supplies the required hero graphic. Failure if followed: the implementation ships Mermaid and omits both owner-supplied JPEGs, violating the owner's explicit artwork and diagram instructions. Correction: commit the owner assets (as Claude's plan does) and drop Mermaid.

2. **cursor plan — Risks / Conclusion (LICENSE still "deferred").** The plan says license remains "planned MIT / deferred file". Rule: README claims must match the repository baseline. Failure if followed: the rewritten README keeps a false deferred-LICENSE statement while `LICENSE` already exists (MIT, © 2026 Michael Glenn Williams). Correction: link `LICENSE` and state MIT, as Claude and Codex plans do.

3. **cursor plan — Exact File List / Reuse (quota-only relocation).** The plan moves only the vendor-quota block into `docs/coord-driver.md`. Rule: unique README-only operator prose must not be deleted without a new home. Failure if followed: the README "Development" `coord next --issue` / `COORD_AGENT=…` passage (absent from `docs/coord-driver.md` today) disappears from the tree. Correction: also relocate `coord next` into `## Agent completion contract` (Claude/Codex).

4. **cursor plan — Exact File List (`CONTRIBUTING.md` conditional).** The plan lists `CONTRIBUTING.md` as "change only if the anchor must move". Rule: the implementation file map must state exact intended edits, not optional maybe-paths. Failure if followed: reviewers cannot tell whether a `CONTRIBUTING.md` diff is in or out of scope, and an implementer may either skip a needed anchor fix or expand the map quietly. Correction: keep `## Requirements` and omit `CONTRIBUTING.md` from the change list (preferred), or list a concrete edit.

5. **claude plan — Risks (leave contradictory hold prose).** The plan moves current vendor-quota/status-line documentation under Owner controls but explicitly leaves the nearby Delivery-safety sentence claiming "no … statusline installation or …" as out of scope. Rule: a single operator guide must not assert both that status-line/quota support does not exist and that it does. Failure if followed: `docs/coord-driver.md` contradicts itself in adjacent subsections, and operators cannot tell which contract is live. Correction: in the same already-mapped file, replace or qualify that historical sentence with a one-line pointer to the new vendor-quota subsection (Codex's reconcile step).

6. **codex plan — Exact file list to be created / How it works (original SVG + Mermaid).** The plan creates `docs/assets/coord-banner.svg` and embeds a Mermaid flowchart. Rule: use the owner-supplied banner and flowchart; do not use Mermaid (issue comments 1–2). Failure if followed: the PR invents a third visual language, rejects the owner's JPEGs, and ships Mermaid against an explicit ban. Correction: commit the two owner JPEGs under a docs image path and describe the flow in prose beside the flowchart image.

7. **codex plan — Tests (`pnpm check` as implementation acceptance).** The plan requires full `pnpm check` (including e2e) for a docs-and-asset change that touches no executable behavior. Rule: propose the fewest focused checks that actually gate the change; do not expand acceptance to unrelated suites without need. Failure if followed: implementation is blocked on e2e cost/flakes that cannot fail for README/SVG edits, delaying a docs-only ship. Correction: keep `pnpm check:fast` as the required automated gate; treat full `pnpm check` as optional coordinator/PR policy, not a plan-mandated product proof for this file map.

8. **antigravity plan — Tests / Risks (lock issue Mermaid into vitest).** The plan extends `test/verify-config.test.ts` to require a Mermaid `flowchart TD` with `MultiAgentTeam` / `ConsensusLoop` / `VerificationGate`, and Risks says to use the issue's Mermaid verbatim. Rule: owner comment 2 forbids Mermaid; workflow claims must match `participantsForStep` / profile behavior in `src/steps.ts` (consensus implementations are all active agents, not one "selected agent"; finalization failures do not auto-loop to independent implementation as the issue sketch draws). Failure if followed: CI enforces a banned, inaccurate diagram and churns on every wording tweak. Correction: no Mermaid; use owner flowchart bytes; if any automated check exists, assert only durable facts (no `#139` release-checklist in README, `#requirements` preserved, local links resolve)—not marketing section titles or diagram source.

9. **antigravity plan — Exact File List (missed unique prose and LICENSE).** The plan changes `README.md`, `docs/coord-driver.md` (quota only), and `test/verify-config.test.ts`. Rule: thin the landing page without deleting unique docs, and correct stale LICENSE claims. Failure if followed: `coord next` documentation is lost; README may keep or omit license incorrectly relative to the existing `LICENSE` file; owner images are never added. Correction: adopt Claude's disposition table (quota + `coord next` moves, owner JPEGs, MIT link) and drop the brittle README structure test.

## Conclusion

Only **claude `7d960d66c03aa5e40a411c7e2a73a414628c8df5`** incorporates the owner's binding comments (commit both JPEGs; no Mermaid), keeps the change documentation-scoped, justifies the only new files (the two images), relocates both unique README passages (`vendor quota` and `coord next`), and avoids brittle vitest copy checks. Accept that plan after fixing Finding 5 (reconcile the stale "no statusline installation" sentence in the same `docs/coord-driver.md` edit).

Reject as written: **cursor** (Mermaid-only, stale LICENSE, incomplete relocation), **codex** (invented SVG + Mermaid against owner assets/ban; over-heavy e2e acceptance), and **antigravity** (Mermaid-in-CI with the inaccurate issue sketch; missing assets/`coord next`/LICENSE corrections).

# Issue 139 plan review

Reviewed bound plans:

- cursor `1b668bfd64034dacdd0d6b0f7fb4c1dfd930e5a4`
- claude `432794d656297a115bc044eecacbaa108fd30c8b`
- codex `c4096d1d8aff38b17e298ca0c43816a0335235ff`

Issue #139 asks for an in-repo public-release baseline (license, scrub, public
install docs, CONTRIBUTING/SECURITY, honest language support) while leaving
visibility flip, hosting moves, history rewrite, npm publish, and Python
auto-detect as owner decisions or follow-ups.

## Findings

### 1. Cursor — `.gitignore` omits editor `tags` the issue asks to keep untracked

**Plan claim:** Cursor Exact File List and Out of scope never mention
`.gitignore`. Workstream B in the issue asks to confirm editor `tags` (and
related local harness/store dirs) stay untracked/gitignored.

**Rule:** A plan that claims to cover the sanitize-before-public checklist must
list every tracked-file change needed for that checklist. Paths that are only
ignored via a clone-local `.git/info/exclude` are not ignored for strangers.

**Concrete failure:** The repo-root `.gitignore` today has no `tags` rule. After
following Cursor's file list alone, a fresh public clone where someone runs
ctags still shows `tags` as untracked noise, so the "confirm … editor tags …
stay … gitignored" item remains false while the PR claims sanitize work is done.

**Smallest correction:** Add `/tags` to `.gitignore` (Claude). Optionally also
ignore `.pnpm-store/` and accidental root `coord-runtime/` / `completes/` as
Codex lists, without deleting historical `.plans/` / `.code-reviews/`.

### 2. Cursor — automated tests do not gate the public-install scrub

**Plan claim:** Cursor Tests only extend `shipped examples` so
`config.product.example.json` string leaves lack `/Volumes/`.

**Rule:** Proposed tests must fail before the change and pass after it for the
behaviors the plan ships when a cheap assertion exists. Private-install wording
and personal paths in primary docs are part of the issue success criteria, not
optional prose.

**Concrete failure:** An implementer (or a later regression) can leave or
restore `README.md` / `docs/setup-workspace.md` / `scripts/bootstrap.sh` text
matching “repository is private”, or leave `/Volumes/` in `docs/analytics.md`,
and Cursor's named suite still passes. Only the example JSON is guarded.

**Smallest correction:** Adopt Claude's single hygiene case in
`test/verify-config.test.ts` (community files exist; `package.json` `license`
is `MIT` if that field is added; scan README, `docs/*.md`, example configs, and
`scripts/bootstrap.sh` for `/Volumes/`, `/Users/[A-Za-z]`, and
`/repository is private/i`), or at least Codex's coordination-path asserts plus
an explicit README/bootstrap private-wording assert.

### 3. Codex — LICENSE may be omitted from the preparation PR

**Plan claim:** Codex Exact file list to be created makes `LICENSE` conditional:
if copyright/ownership is unanswered, “land the other preparation separately and
keep this file and the public release blocked.”

**Rule:** Issue success criteria require `LICENSE` (and SECURITY) present for
the public baseline. The planning action's selected MIT choice is the
in-protocol decision unless the owner overrides it; the implementer must not
leave the required root file out of the file map that the PR is supposed to
land.

**Concrete failure:** Following Codex as written, an implementer who treats
attribution as still “unanswered” ships the docs/scrub PR without `LICENSE`.
The checklist item “LICENSE and SECURITY present” stays unchecked while the
branch claims Workstream A is underway, and review/comparison cannot treat
license presence as done.

**Smallest correction:** Create root `LICENSE` with standard MIT text and
`Copyright (c) 2026 gwhizoftv` in the same PR (Claude/Cursor), matching current
GitHub ownership. Record any later legal-name swap as a one-file follow-up, not
as permission to skip the file.

### 4. Codex — new `docs/public-release.md` duplicates the issue checklist

**Plan claim:** Codex creates `docs/public-release.md` as a durable owner
checklist for legal/hosting decisions, audits, visibility authorization, and
cold smoke, arguing the GitHub issue is temporary.

**Rule:** Every new file must be justified; paths cited only as reuse do not
expand the change set. Prefer extending existing docs over a third checklist
when the issue body already enumerates the same owner gates.

**Concrete failure:** After merge, operators have two living checklists (issue
#139 and `docs/public-release.md`) that will drift. Implementers must invent
which doc is authoritative for Workstream E, and the PR grows a permanent
product doc that is not required by the issue success criteria.

**Smallest correction:** Drop `docs/public-release.md`. Keep owner-only gates in
the issue (and briefly in Risks / SECURITY.md where reporting readiness is
mentioned). Do not treat a merged prep PR as a completed public release (Codex
Conclusion already states this—keep that sentence without the extra file).

### 5. Claude — strongest in-repo plan; no blocking defect found

Claude's file map matches the issue's suggested order (LICENSE, scrub,
public-first README/setup/bootstrap help, CONTRIBUTING, SECURITY, language
section), reuses `proposeProjectPolicy` and the existing `shipped examples`
block, justifies each new root community file, adds `package.json` `"license":
"MIT"` without flipping `"private": true`, adds `/tags` to `.gitignore`,
documents `--declare` via `coord install` (not `onboard`), and proposes one
focused hygiene test that fails on today's tree. No separate finding against
Claude: follow its map, and fold in Codex's accurate note that `coord onboard`
does not accept `--declare` (already true in Claude's install-based example).

## Conclusion

Prefer **claude `432794d656297a115bc044eecacbaa108fd30c8b`** as the
implementation base: it is the smallest complete in-repo coverage of issue
#139's agent-landable work with a real regression gate.

Do not implement Cursor as-is without findings 1–2 (gitignore + broader hygiene
test). Do not implement Codex as-is without findings 3–4 (always ship MIT
`LICENSE` in the prep PR; omit `docs/public-release.md`). Visibility flip,
secret/history audit, private-vulnerability-reporting enablement, hosting
moves, npm publish, and Python auto-detect remain owner/follow-up work under
all three plans.

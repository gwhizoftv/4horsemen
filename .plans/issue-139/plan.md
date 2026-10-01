# Issue 139: Open-source release checklist and multi-language product support

Prepare this repository for a public GitHub release: legal baseline, public
install docs, scrub of machine-specific examples, honest language-support docs,
and community files. Visibility flip remains a maintainer step after the PR
lands and a cold-path smoke test passes.

## Exact File List to be changed or deleted

- `README.md` — replace private-first happy path with public clone / optional
  `curl -fsSL …/scripts/bootstrap.sh | sh`; state that `gh` is required for
  product remotes, not for installing coordination; list hard dependencies
  (Node 26 + pnpm 11 for coordination, Git + `gh` for products, tmux, at least
  one agent harness; note macOS Terminal assumptions for owner UI); add a short
  **Product languages** section (Go/Rust auto via `Cargo.toml`/`go.mod`; Node
  via `package.json`; Make via `Makefile`; Python and other languages via
  `--declare`, with a minimal Python JSON example); keep existing onboard/`coord N`
  narrative otherwise intact.
- `docs/setup-workspace.md` — rewrite **Bootstrap once** so public install is
  the default path and private-clone/`gh repo clone` is optional/legacy; drop
  “this private repository” wording; add a short subsection on product-language
  policy proposal vs `--declare` (point at `proposeProjectPolicy` behavior and
  `config.product.example.json`).
- `docs/analytics.md` — replace absolute `/Volumes/4TB-SOURCE/...` path
  citations in the issue-76 narrative and the `coord analytics --coord-root`
  example with portable placeholders (`/path/to/coord-runtime/...`); keep the
  historical measurement content.
- `config.product.example.json` — replace `coordination.installRoot`,
  `cliEntry`, `productRoot`, and `cloneRoot` absolute personal paths with
  portable placeholders (e.g. `/path/to/coordination`, `/path/to/myserver`,
  `/path/to/clone-root`); leave the Go verify/checks example unchanged.
- `scripts/bootstrap.sh` — keep default
  `COORD_SOURCE`/`--source` URL
  `https://github.com/gwhizoftv/coordination.git` (hosting stays under
  `gwhizoftv/` for this cut); rewrite header and `--help` text so public
  curl|sh / git URL is the primary story and private local `--source` is the
  alternate; no install-behavior change.
- `test/verify-config.test.ts` — extend the existing `shipped examples` suite
  so `config.product.example.json` fails if any string value matches
  `/Volumes/` (or other absolute personal-machine prefixes the scrub targets).

## Exact file list to be created

- `LICENSE` — MIT license text; copyright holder `gwhizoftv` (matches current
  GitHub owner; no org move in this issue).
- `CONTRIBUTING.md` — how to develop this repo: `pnpm install --frozen-lockfile`,
  `pnpm check:fast` before commits, `pnpm check` for full acceptance, branch /
  PR expectations (work on `issue-<n>/<agent>` or `<agent>/<name>`, never commit
  on `main`), and a pointer that `AGENTS.md` is the agent operating protocol
  while this file is for human contributors.
- `SECURITY.md` — how to report vulnerabilities privately (GitHub Security
  Advisories / private vulnerability reporting for `gwhizoftv/coordination`);
  no public issue disclosure for security bugs.
- `.plans/issue-139/plan.md` — this plan.

## Reuse and Scope

Reuse (read/call; do not rewrite for this issue):

- `proposeProjectPolicy` in `src/setupWorkspace.ts` — existing Cargo / Go /
  Node / Make detection; document it, do not extend with Python heuristics here.
- `coordinatorConfigSchema` and the existing
  `shipped examples` / `installer proposals` tests in
  `test/verify-config.test.ts` — keep schema parse coverage; add the path-scrub
  assertion next to it.
- `test/bootstrap.test.ts` — behavior unchanged; rely on it to catch accidental
  bootstrap regressions if comments-only edits are wrong.
- `config.product.example.json` as the canonical Go `--declare`-style example
  already referenced from README.

Justify every new file:

- `LICENSE` — required legal baseline; no existing license file.
- `CONTRIBUTING.md` — human contributor entry point distinct from agent
  protocol in `AGENTS.md`.
- `SECURITY.md` — required community baseline for public repos; no existing
  reporting path.
- `.plans/issue-139/plan.md` — required coordinator artifact for this action.

Out of scope for this implementation (explicit non-goals / follow-ups):

- Flipping GitHub visibility (`gh repo edit … --visibility public`) — maintainer
  after merge + cold-path smoke.
- Python (or Poetry/uv/Hatch) auto-detection in `proposeProjectPolicy`.
- `CODE_OF_CONDUCT.md`, issue/PR templates, npm publish, claiming `@coord` on
  npm, org move, history rewrite.
- Changing `"private": true` in `package.json` (remain GitHub-distributed).
- Editing `AGENTS.md` — this clone keeps `skip-worktree` on that path; do not
  clear the bit. Any scrub of the tracked `/Volumes/...` runtime example there
  is an owner follow-up outside this PR.
- Leaving historical `.plans/` / `.code-reviews/` alone as design history.
- No version bump on the issue branch.

## Tests

Run `pnpm check:fast` before commit (lint, typecheck, fast tests). Coordinator
acceptance remains `pnpm check`.

Focused automated coverage (extend existing file; no new test file):

- In `test/verify-config.test.ts` `shipped examples`: keep the schema parse
  assertion; add that every string leaf under `coordination` (and preferably
  the whole example JSON) does not contain `/Volumes/` so a regression of the
  personal-path scrub fails the suite.
- Existing `proposeProjectPolicy` Go/Cargo cases in the same file already
  document auto-detect; do not add Python detection tests (feature not in
  scope).
- No new bootstrap behavioral tests unless `scripts/bootstrap.sh` logic
  changes (planned change is commentary/`--help` only).

Manual acceptance (maintainer, after merge / before or immediately after
visibility flip — not automated in this PR):

- Cold clone or `curl -fsSL <public-raw-bootstrap> | sh` without private `gh`
  auth to this repo → `coord doctor` against a sample product succeeds or fails
  clearly.

## Alternatives Rejected

- Apache-2.0 instead of MIT — MIT matches the issue’s primary recommendation and
  keeps the legal surface smaller for a tooling repo; Apache is fine later if
  ownership needs patent grant pedantry.
- Adding Python auto-detect in the same PR — valuable follow-up, but the issue
  marks it optional and states Python already works via `--declare`; bundling it
  expands scope past the public-release checklist.
- New `docs/product-languages.md` — README + `docs/setup-workspace.md` already
  cover install/declare; a third page is speculative until content outgrows two
  short sections.
- `CODE_OF_CONDUCT.md` / issue templates in the first cut — optional in the
  issue; defer to keep the PR reviewable.
- Setting `"private": false` / publishing to npm — issue recommends staying
  GitHub-distributed until an intentional publish plan exists.
- Moving the default remote to a new org — hosting-identity decision stays
  `gwhizoftv/coordination` for this cut; docs use that URL consistently.
- Rewriting git history to scrub paths — prefer cleaning current tracked files;
  no secrets found that force a rewrite for this checklist.
- Clearing `skip-worktree` on `AGENTS.md` to scrub its path example — protocol
  forbids that repair path; escalate to owner instead.

## Risks and Mitigations

- Public docs land while the repo is still private — raw curl still 404s until
  visibility flips; mitigate by sequencing: merge docs/files first, then
  maintainer smoke + flip; README may note public raw URL works after the repo
  is public.
- Softening bootstrap help while default URL stays `gwhizoftv/...` — correct for
  this hosting decision; if the org moves later, update default + docs together.
- Example-config path scrub breaks a brittle test that expected absolute
  Volumes paths — only the shipped-example suite asserts parseability today;
  update that suite in the same commit.
- Over-scrubbing `docs/analytics.md` could erase the issue-76 measurement
  story — replace only machine paths/commands with placeholders; keep numbers
  and phase tables.
- License copyright naming wrong for relicensability — use current GitHub owner
  `gwhizoftv`; owner confirms before flip if legal name must differ.

## Conclusion

This issue ships the smallest public-release baseline: MIT `LICENSE`,
`CONTRIBUTING.md`, `SECURITY.md`, public-first README/setup docs, scrubbed
example and analytics paths, softened bootstrap messaging, and a regression
test that keeps personal `/Volumes/` paths out of the shipped example config.
Go/Rust/Make/Node support is documented as-is; Python stays `--declare` until a
follow-up. Repo visibility flip and cold-path smoke remain maintainer steps
after merge—not part of the code change.

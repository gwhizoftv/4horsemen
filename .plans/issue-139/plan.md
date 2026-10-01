# Issue 139 — open-source release checklist and multi-language support docs

Issue #139 is a tracking checklist. This plan covers the in-repo work an agent
can land in one PR: legal baseline files, scrubbing machine-specific paths,
public install wording, contributor/security docs, and an honest
product-language support section. Owner-only decisions and live-repository
operations stay with the owner (see Scope below).

## Exact File List to be changed or deleted

- `README.md`
  - Rewrite "Happy path" for a public repository. The stranger path becomes
    `curl -fsSL https://raw.githubusercontent.com/gwhizoftv/coordination/main/scripts/bootstrap.sh | sh`,
    with `git clone https://github.com/gwhizoftv/coordination.git <dir>` plus
    `sh <dir>/scripts/bootstrap.sh --source <dir>` as the inspect-first
    alternative. Remove "**This repository is private**" and the `gh auth` /
    `gh auth setup-git` / `gh repo clone` install lines. Keep one sentence saying
    that a private fork installs with `--source <local clone>`.
  - Requirements: state that Node 26 + pnpm 11 are needed **to run
    coordination**, not as a product language. State that `gh` is needed for
    the **product** remote, not for installing coordination. Note that the
    owner UI opens macOS Terminal windows and that tmux works on other
    platforms without them. This uses the existing wording in
    `docs/coord-driver.md` ("On macOS, `coord start` … opens one Terminal.app
    window").
  - Add a "Product languages" section. Go and Rust policy is proposed
    automatically from `go.mod` / `Cargo.toml`, and Node (pnpm/yarn/npm) and
    `make` are also detected. Python has no detection yet and works through
    `--declare`. Any language works when its commands can be written as `argv`
    arrays. Link to the new section in `docs/setup-workspace.md`.
  - Add a short "License" section linking `LICENSE`, `CONTRIBUTING.md`, and
    `SECURITY.md`.
- `docs/setup-workspace.md`
  - "Bootstrap once": replace the private-first block (lines 28–56) with the same
    public `curl | sh` / clone-then-`--source` paths as the README. Keep the
    paragraphs on bootstrap behaviour and ownership metadata unchanged. Reword
    the last paragraph so the local `--source` path is described as being for
    private forks.
  - Under "What runs, and whose it is", add a subsection "Product languages".
    It contains the detection table (cargo → go → pnpm/yarn/npm → make → none,
    first match wins) matching `proposeProjectPolicy` in
    `src/setupWorkspace.ts`. It also contains the Python declaration example
    from the issue body and the matching `coord install … --declare <file>`
    line. It closes with the caveats: doctor's `toolchain` finding needs each
    `argv[0]` on PATH, mixed-language monorepos need a hand-written declaration,
    and the Node requirement covers coordination itself.
- `config.product.example.json`
  - Replace `/Volumes/4TB-SOURCE/REPOS/coord/...` in `coordination.installRoot`,
    `cliEntry`, `productRoot`, and `cloneRoot` with portable placeholders:
    `/home/you/.local/share/coordination`,
    `/home/you/.local/share/coordination/dist/main.js`,
    `/home/you/src/myserver`, and `/home/you/src`. The values stay strings, so
    `installStampSchema` (`z.string().min(1)`) still parses them.
- `docs/analytics.md`
  - Line 18: replace `/Volumes/4TB-SOURCE/REPOS/coord/coord-runtime/issue-76/`
    with `<coord-root>/issue-76/`.
  - Line 127: replace the `--coord-root /Volumes/...` value with
    `/path/to/coord-runtime`.
- `scripts/bootstrap.sh`
  - Header comment and `--help` text: drop the "Private repos … will 404"
    wording. Describe `curl -fsSL <raw-url> | sh` as the default, with
    `--source <local clone>` for private forks or offline installs. The
    `COORD_SOURCE` default URL stays as it is: it is already parameterized
    (`COORD_SOURCE` / `--source`), and changing it depends on the owner's
    hosting decision.
- `package.json`
  - Add `"license": "MIT"`. `"private": true` and the name `@coord/coordination`
    stay unchanged. The issue recommends GitHub distribution until there is an
    npm plan. No version bump (AGENTS.md: the bump is checked only on the PR
    into `main`).
- `.gitignore`
  - Add `/tags`. The editor tags file is currently ignored only by this clone's
    `.git/info/exclude`, so a fresh clone would show it as untracked.
- `test/verify-config.test.ts`
  - Add one case to the existing `describe("shipped examples")` block (see
    Tests).

No file is deleted. `.plans/` and `.code-reviews/` stay as design history. This
PR does not move or remove them, because the issue leaves their fate to the
owner.

## Exact file list to be created

- `LICENSE` — MIT license text. The copyright line is
  `Copyright (c) 2026 gwhizoftv`, matching the current GitHub owner. MIT is the
  issue's first recommendation and needs no NOTICE file. The owner confirms or
  swaps the license at plan review (see Risks).
- `CONTRIBUTING.md` — covers `nvm use 26`, `pnpm install --frozen-lockfile`,
  `pnpm check:fast` before every commit, and `pnpm check` for full acceptance.
  It asks for branches off `main` with PRs into `main`, and for no version bump
  on ordinary branches. It explains that `AGENTS.md` is the agent operating
  protocol and that human contributors follow this file instead.
- `SECURITY.md` — supported versions (latest `main` / latest `0.0.x` tag) and a
  private reporting path: GitHub private vulnerability reporting ("Report a
  vulnerability" on the Security tab). It asks reporters not to open public
  issues. It lists what is in scope: hooks, bootstrap, and the runtime-state
  boundary.

Each new file is a community-baseline file named in the issue's success
criteria ("LICENSE and SECURITY present") or Workstream C (`CONTRIBUTING.md`).
No existing file can hold them, because GitHub detects them by their root
filenames. `CODE_OF_CONDUCT.md` and issue/PR templates are optional in the issue
and are left out.

## Reuse and Scope

Reuse:

- `proposeProjectPolicy` in `src/setupWorkspace.ts` is the source of truth for
  the documented detection order and proposals. It is documented only, not
  changed.
- `workspaceDeclarationSchema` in `src/state.ts` already accepts any `toolchain`
  string with `verify` / `checks` / critical paths, so the Python `--declare`
  example needs no code change.
- The existing `describe("shipped examples")` test in
  `test/verify-config.test.ts`, together with `repoRoot` from
  `test/support/workspaceFixture.ts`, already parses
  `config.product.example.json` with `coordinatorConfigSchema`. That test keeps
  guarding the placeholder rewrite, and the new hygiene case joins the same
  block.
- `test/bootstrap.test.ts` already exercises `--source`, `--root`, the
  `COORD_INSTALL_ROOT` override, and refusal paths. Bootstrap behaviour does not
  change (only comments and help text), so that file needs no new case.
- The existing doctor `toolchain` finding (docs/setup-workspace.md table row 16)
  is cited as the PATH caveat; it already exists.

Out of scope (owner decisions or live-repository operations, not files in this
PR):

- The license choice itself, if the owner prefers Apache-2.0.
- Hosting identity (`gwhizoftv/` vs a neutral org), and therefore the
  `COORD_SOURCE` default.
- Secret and history scanning, and any history rewrite.
- The visibility flip, the cold-path smoke test after it, and enabling
  Discussions, Dependabot, branch protection, or private vulnerability
  reporting.
- Governance (Workstream D) beyond the one `AGENTS.md`-vs-contributor
  paragraph in `CONTRIBUTING.md`.
- npm publishing.
- Python auto-detection in `proposeProjectPolicy`. The issue calls it an
  optional follow-up, not a prerequisite.

## Tests

One new case joins `describe("shipped examples")` in
`test/verify-config.test.ts`:

- `it("ships the public baseline without machine-specific paths or private-install wording")`
  - Asserts that `LICENSE`, `CONTRIBUTING.md`, and `SECURITY.md` exist at
    `repoRoot`, and that `package.json` has `license === "MIT"`.
  - Reads `README.md`, every `docs/*.md`, `config.example.json`,
    `config.product.example.json`, and `scripts/bootstrap.sh`. For each file,
    asserts no match for `/\/Volumes\/|\/Users\/[A-Za-z]/` and none for
    `/repository is private/i`.
  - Fails before the change: `LICENSE` is missing,
    `config.product.example.json` and `docs/analytics.md` contain `/Volumes/`,
    and `README.md` says "This repository is private".
  - Passes after the change.

The existing case in the same block,
`keeps config.product.example.json parseable by the driver's own schema`, must
keep passing after the placeholder rewrite.

Commands:

- `pnpm check:fast` before the commit (`verify.precommit`).
- `pnpm check` (build + check:fast + e2e) as the coordinator's acceptance run.
- Manual, documentation-only: `sh scripts/bootstrap.sh --help` shows no
  private-repository wording.

## Alternatives Rejected

- **Apache-2.0 instead of MIT.** It is equally acceptable to the issue, but it
  adds NOTICE and patent-clause handling that this project does not otherwise
  need. MIT is the issue's first recommendation and the smaller file. The owner
  can still swap it at review.
- **Change the `COORD_SOURCE` default to a neutral org now.** That org does not
  exist, so the default would break bootstrap until the owner decides on
  hosting. The default is already overridable.
- **Implement Python detection in `proposeProjectPolicy`.** The issue lists it
  as an optional follow-up. Documenting `--declare` meets the success criterion
  ("Python declare-or-enhance") with no behaviour change.
- **A separate `docs/languages.md` page.** The verification tier and
  `--declare` docs already live in `docs/setup-workspace.md` ("What runs, and
  whose it is"). A subsection there avoids a new file that would duplicate that
  context.
- **Delete or relocate `.plans/` and `.code-reviews/`.** The issue leaves this
  to the owner, and removing design history is not reversible from the public
  narrative once flipped. It is left unchanged.
- **A shell-script test asserting bootstrap help text.** The hygiene test
  already scans `scripts/bootstrap.sh` for the private wording, so a second test
  would duplicate it.

## Risks and Mitigations

- **The owner wants a different license or copyright holder.** `LICENSE` and the
  `package.json` `license` field are the only two places that name it, and the
  test asserts the field. Plan review is the decision point, and a swap touches
  those two files plus one test literal.
- **README describes a public `curl | sh` path before the repo is public.** It
  will 404 until the visibility flip. Mitigation: both README and setup docs
  keep the clone-then-`--source` path for private forks. The flip and cold-path
  smoke test stay owner steps in the issue (Workstream E).
- **The hygiene regex is too broad or too narrow.** It scans only the
  public-facing install and example files listed above, not `.plans/`,
  `.code-reviews/`, `src/`, or `test/`. Historical artifacts and test fixtures
  can legitimately contain paths. `/Users/[A-Za-z]` avoids matching ordinary
  prose.
- **Documented detection order drifts from code.** The table cites
  `proposeProjectPolicy` by name and mirrors its `if` order (`Cargo.toml`,
  `go.mod`, `package.json`, `Makefile`). This PR does not change the code.
- **Placeholder paths in `config.product.example.json` break the schema test.**
  The fields are plain non-empty strings, and the existing
  `coordinatorConfigSchema.safeParse` test catches any regression.
- **Secrets in history.** This PR does not scan history. Secret and history
  scanning stays an explicit owner checklist item before the flip.

## Conclusion

This PR lands the in-repo part of #139's suggested order, steps 1–5:

1. The MIT `LICENSE` and the `package.json` license field.
2. Personal paths scrubbed from the example config and analytics doc.
3. Public-first install wording in the README, setup docs, and bootstrap help.
4. `CONTRIBUTING.md` and `SECURITY.md`.
5. An honest product-language section: Go and Rust auto-detected, Node and
   make detected, Python via `--declare`, any language via `argv`.

One focused hygiene test in the existing `shipped examples` block guards the
result. No runtime behaviour changes. The license confirmation, hosting
identity, history and secret scan, visibility flip, governance, npm, and Python
auto-detection remain owner decisions or follow-up issues.

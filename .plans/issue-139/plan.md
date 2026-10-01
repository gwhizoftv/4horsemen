# Issue 139 — public-release preparation

Protocol version: 1. Authority: the coordinator's issue-139 GitHub issue snapshot,
baseline `845d28d091c530926fa4ab59d615654b56ac2977`, and planning action
`8c5d388f-364e-4d68-a8e8-333e4f68df88`.

This is a release-preparation PR, not authorization to publish private content.
The issue explicitly permits multiple PRs before visibility changes. Deliver the
portable install path, community documentation, and accurate language guidance;
retain an explicit release checklist for owner decisions and live acceptance.

## Exact File List to be changed or deleted

- `README.md`: replace private-first bootstrap instructions with an HTTPS Git
  clone followed by `sh <clone>/scripts/bootstrap.sh --source <clone>`; explain
  that anonymous upstream access becomes available only after release. Keep
  authenticated private/fork installs as an alternative, not a prerequisite.
  Separate driver requirements (Node 26, pnpm 11, Git) from product GitHub access
  (`gh`), tmux, configured harnesses and product tools. Use an explicit single
  agent/solo onboarding example so a stranger need not have all four default
  harnesses installed. Link contribution, security and release guidance; state
  Go/Rust auto-proposal and Python explicit-declaration support prominently.
- `docs/setup-workspace.md`: align bootstrap commands with README; explain
  `COORD_SOURCE`/`--source` and retain private-source instructions in a secondary
  section. Add the language table and a complete valid JSON Python declaration
  plus `coord install --product /path/to/app --coord-root /path/to/coord-runtime
  --agents codex --profile solo --declare /path/to/declaration.json`, followed
  by doctor with the same product/runtime. Do not advertise `--declare` on
  `onboard`, which does not expose it. Explain detector precedence, no Python
  inference, argv execution, PATH/virtualenv requirements, and the distinct
  hook/finalization tiers. Describe macOS Terminal integration separately from
  CLI/tmux operation; do not promise an untested Windows or Linux support tier.
- `scripts/bootstrap.sh`: update comments/help to describe public HTTPS install
  first and authenticated private sources second. Retain the working canonical
  URL `https://github.com/gwhizoftv/coordination.git` and existing `COORD_SOURCE`
  and `--source` precedence. Do not invent an unowned organization or change
  clone/update/ownership/safety behavior.
- `config.product.example.json`: replace its four `/Volumes/...` install, CLI,
  product and clone paths with consistent absolute `/path/to/...` placeholders.
  Keep this a schema-valid Go example; explain that installation stamps are
  generated, not credentials or values to copy into a real workspace.
- `docs/analytics.md`: neutralize the concrete historical runtime location and
  command example, retaining the historical measurements and their limitations.
- `.gitignore`: add narrowly scoped ignore rules for `.pnpm-store/`, root editor
  `tags`, and accidental root `coord-runtime/` and `completes/` directories.
  Preserve all existing harness/build ignores; runtime remains external, and
  ignoring a path is not a substitute for verifying it is untracked.
- `test/verify-config.test.ts`: extend the existing shipped-example schema test
  to reject personal absolute paths in the example's coordination path fields.
  Reuse schema parsing rather than creating a second config validator.

No tracked files are deleted. No changes to `src/**`, `githooks/**`, agent
templates, `AGENTS.md`, dependencies, package name, or version are needed.
Keep `package.json` private: GitHub distribution is not npm publication.

## Exact file list to be created

- `CONTRIBUTING.md`: human contribution entry point, prerequisites, locked
  install and verification commands, normal topic-branch PRs, maintainer review
  and merge authority, focused tests, and the distinction between optional
  coordination-driven development and the agent operating protocol in
  `AGENTS.md`. Do not require external contributors to run the multi-agent loop.
- `SECURITY.md`: private vulnerability-reporting instructions using GitHub
  private reporting only after the owner enables and verifies that channel, or
  an owner-approved alternative contact. Never invent an email address or
  direct reporters to disclose vulnerabilities in public issues. If no private
  channel is confirmed, explicitly mark this release prerequisite unresolved;
  do not claim the project has operational private reporting.
- `LICENSE`: use MIT, selected by the owner during this planning action;
  conditional on owner confirmation of copyright holder/year
  and ownership/relicensability of tracked code, templates, protocol text and
  docs. Use the complete standard MIT text with confirmed attribution; never
  commit a placeholder license or assert rights on the owner's behalf. If
  unanswered, land the other preparation separately and keep this file and the
  public release blocked.
- `docs/public-release.md`: durable owner checklist covering legal/hosting
  decisions, private reporting, tracked/history and GitHub-content review,
  release evidence, cold-install procedure and explicit visibility authorization.
  This is necessary because several issue requirements are operational gates,
  not source-code changes, and must survive the temporary planning artifact.

No other files, new abstractions, dependencies or test fixture modules are
introduced. `.plans/issue-139/plan.md` is this action's protocol artifact, not a
new permanent product document.

## Reuse and Scope

Reuse `scripts/bootstrap.sh` unchanged operationally: it already accepts public
HTTPS Git URLs, requires no `gh`, builds a full checkout, tracks ownership and
refuses unsafe updates. Reuse `test/bootstrap.test.ts`'s `BootstrapFixture`,
`fixture` and `bootstrap` coverage for locked install/build, clean fast-forward,
dirty refusal, pre-existing checkout ownership and foreign launcher refusal;
do not duplicate those tests for a prose-only change.

Document the actual `proposeProjectPolicy` and `ProjectPolicyProposal` in
`src/setupWorkspace.ts`. Its order is Cargo, Go, Node, then recognized Makefile
targets. Rust proposes `cargo check --all-targets` before commit and `cargo test`
before push/finalization. Go proposes `go vet ./...`, `go test ./...`, then
`go build ./...` and `go test ./...` for finalization. Node uses existing scripts;
Make uses `check`/`test` where present. An unknown tree gets no invented policy.
Reuse `buildWorkspaceConfig`'s declaration override and existing config command
types/schema: Python's example declares ruff/pytest commands, both verification
lists, finalization checks, and `src/`, `tests/`, `pyproject.toml`, `uv.lock`
critical paths explicitly. Missing verify fails closed; empty verify is an
intentional operator opt-out. Detection runs at install, not inside hooks.

Reuse `test/verify-config.test.ts`'s existing non-Node proposal and command-order
tests and schema-valid shipped-example test. Existing installer and doctor
tests reuse `makeProduct`, `writeDeclaration`, `passingVerify`, `declaredChecks`
and `repoRoot` from `test/support/workspaceFixture.ts`; they already cover
non-Node installation, missing checks, missing verify and missing executables.
The implementation need not run real Go/Rust/Python compilers to test these
unchanged policies. Do not add Python detection or a plugin architecture.

Keep past `.plans/` and `.code-reviews/` as historical evidence, not the public
getting-started path; include them and all published refs in the release audit.
Do not delete other issues' artifacts or rewrite history. A detected secret
requires owner notification, credential rotation and a separately authorized
remediation plan before publication. A history note may retain a clearly marked
historical path; primary operational examples may not.

## Tests

1. Extend only the existing `shipped examples` case in
   `test/verify-config.test.ts`: after schema validation, assert that installRoot,
   cliEntry, productRoot and cloneRoot do not contain `/Volumes/` or `/Users/`.
   These assertions fail on the current example and pass on the portable one.
   Keep the CLI path consistent with installRoot. No redundant detector tests
   are needed for documented behavior already covered by existing tests.
2. Run `pnpm exec vitest run --config vitest.config.ts test/verify-config.test.ts
   test/bootstrap.test.ts test/install.test.ts test/doctor.test.ts` as the focused
   regression suite. Run `sh -n scripts/bootstrap.sh` and
   `sh scripts/bootstrap.sh --help`; manually check the public-first help and
   private-source alternative, preserving both source overrides.
3. Run `pnpm check:fast` before every commit. Run full `pnpm check` for the
   implementation's final acceptance; hooks alone do not establish acceptance.
   No issue-branch version bump is required.
4. Review changed documentation links and copy/paste commands. Run
   `git grep -n -E '/Volumes/|/Users/' -- README.md docs config.product.example.json
   scripts/bootstrap.sh`; primary install/examples must have no personal paths.
   Confirm ignore matching with `git check-ignore .pnpm-store/probe tags
   coord-runtime/probe completes/probe`. Use `git ls-files` to verify generated
   builds, local harness directories and real runtime/product files are absent
   from the tracked tree. Do not mistake ignored files for removed history.
5. In `docs/public-release.md`, specify a release-owner audit of all tracked
   files plus recent history (at least `git log -n 100 -p --all`, with broader
   review of every ref to be exposed), credential-pattern/private-URL scanning,
   and manual false-positive review. Also review issues, PRs, attachments,
   releases, Actions logs/artifacts and any published coordination evidence.
   Record scope and unresolved findings, not a blanket claim of no secrets.
   Findings stay in private owner records; no raw secret values in this PR.
6. Two-stage cold-path acceptance: before visibility, exercise bootstrap using
   a sanitized local source in an isolated home/workspace to validate install,
   onboard and doctor mechanics. This is not proof of anonymous public access.
   After explicit owner authorization to change visibility, repeat from the
   actual HTTPS URL in a throwaway user/VM with no coordination GitHub
   credentials, global Git helpers, URL rewrites, or cached clone. Run the
   documented clone/bootstrap commands with real Node 26/pnpm 11; run
   `coord --help`; onboard a disposable product with one installed harness
   (`coord onboard /path/to/sample --agents codex --profile solo`); then
   `coord doctor --product /path/to/sample`. Record URL, commit, platform,
   tool versions and exit codes. Authenticate `gh` only for the sample product
   if needed, with no private access to coordination. Missing tools must produce
   actionable diagnostics; after supplying them require doctor success.
   Verify public README/bootstrap URLs and the private-reporting entry point.
   Announce only after that smoke succeeds. Keep disposable state outside source
   trees; local agent scratch evidence belongs under `.codex/tmp/`.

## Alternatives Rejected

- Adding Python heuristics or ecosystem plugins: optional follow-up, not a
  release requirement; explicit argv declarations already solve Python use.
- Publishing npm/removing `private`, renaming the scope or moving to an invented
  organization: outside the first release and dependent on owner decisions.
- A new source-selection abstraction: `COORD_SOURCE` and `--source` already
  parameterize bootstrap; retain a real canonical upstream default.
- Anonymous `curl | sh` as the sole entry point: a clone-and-inspect path is
  sufficient and easier to verify; private forks still need authenticated Git.
- Mass deletion of historical evidence, forced history rewriting or changing
  hook bodies to pass checks: unnecessary and not authorized.
- New language-doc/test files: extend setup documentation and the existing
  shipped-example test instead; reserve new files for community/release needs.

## Risks and Mitigations

- The owner selected MIT; attribution and ownership remain owner decisions.
  Do not fabricate a copyright holder. Unresolved
  decisions block LICENSE/public release, not honest preparation work.
- Keep the current hosting identity by default for working links, subject to
  owner confirmation before release. A transfer requires updating all canonical
  URLs and rerunning the live smoke before announcing.
- GitHub private reporting availability is a live setting, not created by
  SECURITY.md. Owner must enable and verify it or provide a working private
  alternative before marking security readiness complete.
- Public access cannot be proven while the only source remains private.
  Distinguish preflight from the authorized visibility operation and immediate
  post-change anonymous smoke. No automated action in this plan changes repo
  visibility, permissions, security settings, branches or GitHub content.
- macOS Terminal integration is conditional in `src/tmux.ts`; documentation
  must separate that feature from tmux/CLI operation and state what was actually
  tested rather than inventing official platform/harness guarantees.
- Config JSON does not expand shell `~` or `$HOME`. Use absolute placeholders
  in the sample and explain replacement; prefer generated real install stamps.
- Ignore patterns protect future accidental adds only. Audit existing tracked
  files/history and all refs before the owner exposes them. If audit findings
  require edits outside this exact file list, revise the plan rather than making
  unreviewed scope changes.

## Conclusion

Prepare public-first documentation, portable examples, minimal hygiene and
community entry points without changing the working driver or verification
semantics. Retain private npm posture and current canonical source. Implement
LICENSE only on confirmed legal/ownership decisions, and make security-channel
verification, content review, visibility authorization and the real anonymous
cold smoke explicit owner release gates. A merged preparation PR alone must
never be reported as a completed public release.

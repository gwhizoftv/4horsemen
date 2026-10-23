# Issue 248: upgrade the toolchain with explicit compatibility limits

Protocol version: 1. Baseline: 6f9c66678a814ae3b461edc545e226474ec128d8.
This plan uses the coordinator's issue snapshot and incorporates the owner's
request to check the latest available tools. Version observations below were
made on 2026-10-22 PDT (2026-10-23 UTC). They are planning evidence, not claims
that upgrades or product verification have already run.

## Exact File List to be changed or deleted

| File | Exact intended change |
| --- | --- |
| `package.json` | Pin packageManager to pnpm@12.15.0. Raise dependency ranges to zod ^4.6.7, typescript-eslint ^8.72.0, @types/node ^26.6.5, and vitest ^4.1.12. Retain all other dependency ranges, scripts, the Node >=26 engine floor, and the application version. |
| `pnpm-lock.yaml` | Regenerate with pnpm 12.15.0 for those four dependency changes and their required transitive/peer resolutions; retain the existing graph wherever resolution permits. Never hand-edit integrity hashes. |
| `.nvmrc` | Select Node 26.12.1 for development and CI without changing the driver's supported Node major. |
| `.github/workflows/version-bump-on-merge.yml` | Use node-version-file pointing to .nvmrc. Upgrade pnpm/action-setup from v4 to v6.1.0, which explicitly adds pnpm 12 support; omit its duplicate version input so it reads packageManager. Preserve checkout, triggers, permissions, concurrency, release publication, and bump behavior. |
| `README.md` | Update the driver's pnpm requirement and development commands to pnpm 12; link to the existing setup guide for the tested patch versions and upgrade procedure. |
| `CONTRIBUTING.md` | Update pnpm requirements and use the checked-in Node selection with nvm use, rather than selecting an unpinned Node 26 release. |
| `docs/setup-workspace.md` | Update pnpm requirements throughout; document the dated tool/dependency decision tables below, exact installation/upgrade steps, PATH verification, and the separately recorded host-tool results. |
| `scripts/bootstrap.sh` | Change the missing-tool diagnostic to require Node 26 and pnpm 12. Preserve its existing checkout, runtime selection, frozen installation, and build behavior. |
| `test/bootstrap.test.ts` | Update the existing missing-tools assertion for the new pnpm requirement, reusing its fixture and refusal test. |
| `test/workflows.test.ts` | Extend the existing Workflow step type with uses/with fields and add one toolchain-source assertion: release CI reads .nvmrc, and pnpm setup reads the manifest without a second version override. Reuse the existing YAML parser. |

No files are deleted. These ten files are the complete product-change map.
Any compatibility failure requiring another file needs the coordinator's plan
amendment process before that file becomes part of the implementation.

## Exact file list to be created

None. The existing setup guide holds upgrade instructions and version evidence;
the existing test files hold the two relevant assertions. This planning artifact
is coordination evidence, not a new product module or test harness.

## Reuse and Scope

The repository already selects pnpm 11.10.0, Node >=26, and a Node 26 CI runtime.
The issue's pnpm 10.8.1 report therefore describes a different invocation from
the present project-aware command: this session returned pnpm 11.10.0 from
/opt/homebrew/bin/pnpm. Record both the executable path and effective version
when upgrading; an unqualified global version does not prove the project pin.

Reuse the current `package.json` scripts, the single-package workspace and
esbuild build allowance in `pnpm-workspace.yaml`, the three existing Vitest
configurations, and the current ESLint configuration. No new dependency,
override, abstraction, installer, runtime schema, or production function is
needed. Do not change the product's Git hooks to make an upgrade pass.

Reuse `fixture()`, `BootstrapFixture`, and `bootstrap()` in
`test/bootstrap.test.ts`; reuse `parse()` and the `Workflow` type in
`test/workflows.test.ts`. For regression coverage, reuse the Zod schema and
serialization cases in `test/state.test.ts` for `coordinatorConfigSchema`,
`startStateSchema`, and `cursorsStateSchema` from `src/state.ts`. Reuse the
`fetchGitHubIssue` and `fetchGitHubDefaultBranch` cases in
`test/githubIssue.test.ts`, and `withGitHubAccount` / `verifyGitHubAccess` with
`fakeRunner` in `test/githubAuth.test.ts`. Existing wrapper/bootstrap coverage
exercises `scripts/lib/node-runtime.sh`; that selector and its minimum remain
unchanged. Existing workspace/integration tests and
`test/support/workspaceFixture.ts` already provide local repositories, process
runners, and build setup; no additional fixtures are justified.

### Latest command-line tools and decisions

| Tool | Observed here | Latest stable checked | Decision |
| --- | --- | --- | --- |
| pnpm | 11.10.0 effective in this clone | 12.15.0; maintained 11 line also has 11.28.8 | Target 12.15.0 with exact project pin, compatible CI setup action, and regenerated lockfile. |
| GitHub CLI | 2.102.0 | 2.103.0 | Target 2.103.0 through Homebrew, with read-only issue/auth/PR smoke checks. |
| Node | 26.7.0, from nvm | 26.12.1 Current; latest LTS is 24.22.1 | Target 26.12.1 using the existing nvm installation. Node 24 is below this project's supported floor. |
| npm | 11.19.0 | 12.2.1 | No independent upgrade: this project uses pnpm. Node 26.12.1 bundles npm 11.20.0; document that distinction. |
| Git | Apple Git 2.50.1, /usr/bin/git | Homebrew Git 2.56.0 | Record as an optional host upgrade for an idle workflow; replacing the active Git provider is not necessary for this package update. |
| tmux | 3.7b | 3.8 | Record as an optional host upgrade after agent sessions finish; do not restart the active server. |
| Homebrew | 7.0.8 | 7.0.10 | Refresh with brew update as part of the selected host upgrade; do not upgrade every formula. |

Sources: [pnpm releases](https://github.com/pnpm/pnpm/releases),
[pnpm installation and pin behavior](https://pnpm.io/installation),
[gh 2.103.0](https://github.com/cli/cli/releases/tag/v2.103.0),
[Node release index](https://nodejs.org/dist/index.json),
[Node 26.12.1 security release](https://nodejs.org/en/blog/release/v26.12.1),
[npm registry metadata](https://registry.npmjs.org/npm/latest),
[Homebrew Git](https://formulae.brew.sh/api/formula/git.json),
[Homebrew tmux](https://formulae.brew.sh/api/formula/tmux.json), and
[Homebrew 7.0.10](https://github.com/Homebrew/brew/releases/tag/7.0.10).

pnpm 12 changes executable distribution, workspace-setting validation and peer
resolution. Inspection found only the recognized packages/allowBuilds workspace
settings and registry dependencies here. Its release notes explicitly preserve
frozen installs of existing lockfiles. This supports selecting it as a candidate;
clean installation and the complete verification gates must still prove this
repository works. CI must upgrade its setup action along with the package pin:
[pnpm/action-setup v6.1.0](https://github.com/pnpm/action-setup/releases/tag/v6.1.0)
specifically adds pnpm 12 support. Keep the existing setup-node and checkout
actions for this bounded change. Their latest releases were also checked:
[setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0) and
[checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1);
those major action migrations need their own runner/authentication assessment.

### All direct dependencies

Current means the baseline lockfile resolution, not an assumption that the
issue's reported missing packages are installed. Targets are exact candidate
resolutions; retain the project's caret-range style in the manifest.

| Package | Current | Latest | Selected target / reason |
| --- | --- | --- | --- |
| zod | 4.4.3 | 4.6.7 | 4.6.7, same-major update; existing runtime-schema tests are the gate. |
| typescript-eslint | 8.66.0 | 8.72.0 | 8.72.0, supports the retained TypeScript 5.9 and ESLint 9. |
| @types/node | 24.13.3 | 26.6.5 | 26.6.5, align types with the already-required Node 26 runtime; compile source and tests. |
| vitest | 4.1.11 | 5.0.5 | 4.1.12, latest stable 4.x; defer 5.x's changed mocking and runner behavior. |
| js-yaml | 4.3.2 | 5.5.0 | Retain 4.3.2, the latest 4.x; a major parser change affects workspace declarations and workflow parsing and is not established safe by this plan. |
| @types/js-yaml | 4.0.9 | 4.0.9 | Already current for the retained parser. |
| eslint | 9.39.5 | 10.13.0 | Retain for this bounded upgrade; major migration is a documented outstanding support risk, not a claim of current support. |
| @eslint/js | 9.39.5 | 10.0.1 | Retain with ESLint 9; latest requires ESLint 10. |
| typescript | 5.9.3 | 7.0.2 | Retain 5.9.3. Latest typescript-eslint requires TypeScript >=4.8.4 and <6.1.0, excluding 7.x. |

All latest and same-major targets were read directly from the npm registry.
Relevant exact metadata: [typescript-eslint 8.72.0](https://registry.npmjs.org/typescript-eslint/8.72.0),
[Zod 4.6.7](https://registry.npmjs.org/zod/4.6.7),
[@types/node 26.6.5](https://registry.npmjs.org/@types%2fnode/26.6.5),
[Vitest 4.1.12](https://registry.npmjs.org/vitest/4.1.12),
[ESLint 10.13.0](https://registry.npmjs.org/eslint/10.13.0),
[@eslint/js 10.0.1](https://registry.npmjs.org/@eslint%2fjs/10.0.1),
[TypeScript 7.0.2](https://registry.npmjs.org/typescript/7.0.2),
[js-yaml 5.5.0](https://registry.npmjs.org/js-yaml/5.5.0), and
[@types/js-yaml](https://registry.npmjs.org/@types%2fjs-yaml/latest).

The ESLint deferral has a concrete scope reason: its updated recommended rules
include preserve-caught-error, while existing error wrappers in `src/state.ts`
and `src/githubIssue.ts` throw new errors without causes. Migrating that policy
requires a source-change review rather than disabling checks to make versions
look current. ESLint 9 is EOL, as stated in the
[support policy](https://eslint.org/version-support/); this remains visible in
the upgrade guide and final report. The [ESLint migration guide](https://eslint.org/docs/latest/use/migrate-to-10.0.0)
and [Vitest 5 migration guide](https://vitest.dev/guide/migration/) explain the
respective behavior changes. TypeScript 6 is within the parser's peer interval,
but is still a compiler-major migration and is not needed to fix this issue.

### Implementation and host execution order

1. Reconfirm the explicit targets exist and record Node/pnpm/gh paths and
   versions. Use the frozen target versions in this plan; do not silently move
   to a newer major because a latest tag changes during implementation.
2. Select Node 26.12.1 with nvm, retaining the old installation and leaving nvm's
   default alias alone. Set the project pnpm pin to 12.15.0 and install that
   version through the existing package-manager mechanism. Confirm the effective
   project version before changing dependency resolutions. Do not run a blanket
   update-latest operation or disable peer/engine checks.
3. Upgrade only the four selected direct dependencies. Use explicit versions
   with pnpm add / pnpm add -D (or equivalently targeted pnpm update); generate
   the lockfile with pnpm itself. Update CI, documentation, and the existing
   assertions together. Preserve the existing esbuild build permission.
4. Perform the install and focused verification below, then publish product
   work using the action's normal hooks and evidence requirements. If an upgrade
   needs source edits outside the map, request the exact amendment or report
   that candidate as incompatible; never broaden the map or hide a failure.
5. Execute shared host changes once, by the designated implementation/owner
   path, not independently in every agent clone. The gh procedure is brew update,
   brew info gh, then brew upgrade gh after confirming the formula still targets
   2.103.0. Verify gh --version and its resolved executable, then the read-only
   smoke commands below. Do not alter authentication settings or opt into the
   new expiring-token preview as part of an executable upgrade.
6. For the global pnpm launcher, brew info pnpm then brew upgrade pnpm is
   appropriate if its formula still targets 12.15.0; recheck the version inside
   this project afterward. The manifest pin remains authoritative. Node is
   nvm-managed here: use nvm install 26.12.1 and nvm use 26.12.1, not brew upgrade
   node. Document successful host changes separately from repository commits.
   If host writes are unavailable, report that operational step as pending.
   Optional Git/tmux upgrades remain deferred until the workflow is idle.

This action publishes the plan only. It does not perform any of those host
mutations, dependency installations, or product edits during planning.

## Tests

Use the existing test inventory rather than inventing package-version unit
tests. One new workflow assertion verifies that CI consumes the repository's
toolchain declarations; it fails on the baseline's inline Node/pnpm versions
and passes when CI uses the files. Update the existing bootstrap missing-tool
expectation to pnpm 12; that expectation fails against the old diagnostic.

During implementation, with the selected runtime and package manager:

- Confirm `node --version`, `pnpm --version`, and `pnpm list --depth 0` match the
  selected versions. Record any peer/engine/deprecation warnings explicitly.
- Run `pnpm install --frozen-lockfile --strict-peer-dependencies` from a clean
  dependency installation using the candidate files. A fresh install is the
  meaningful package-manager migration check; do not rely on stale node_modules.
  Check that it leaves manifest/lockfile bytes unchanged using before/after
  SHA-256 hashes, without forbidden clone status/diff commands.
- Run `pnpm test:fast test/workflows.test.ts test/state.test.ts test/githubIssue.test.ts test/githubAuth.test.ts`
  and `pnpm test:system test/bootstrap.test.ts test/wrapper.test.ts` while
  developing, to investigate toolchain, schema, and subprocess regressions.
- Let the product precommit hook own `pnpm check:fast` (lint, source and test
  typechecking, fast tests, system tests), and the prepush hook own
  `pnpm test:e2e` in local verification mode. Do not manually duplicate these
  suites immediately before the hooks. Run `pnpm build` once for the candidate
  if it is not already covered by the applicable verification execution.
- The repository's complete acceptance command is `pnpm check`: build,
  check:fast, and e2e. The coordinator owns its final configured checks at the
  approved pin. If later actions put candidate verification under coordinator
  ownership, cite its recorded results instead of rerunning its suites.
- After the gh host upgrade, run `gh auth status`,
  `gh issue view 248 --repo gwhizoftv/4horsemen --json number,title,url`, and
  `gh pr list --repo gwhizoftv/4horsemen --limit 1 --json number,url`.
  These validate existing auth and the JSON interfaces without creating issues,
  PRs, releases, or printing credentials.

Planning validation is limited to source/config inspection, version metadata,
the action digest, and artifact headings/file-map checks. No product test result
is claimed for this plan. Local tests do not execute GitHub Actions remotely;
the actual release workflow remains subject to CI validation after merge.

## Alternatives Rejected

- Updating every dependency to latest: TypeScript 7 violates the latest
  typescript-eslint peer constraint, and the parser/linter/test-runner majors
  introduce separate behavior changes. Same-major releases are not assumed safe
  either; installation, compilation, and regression gates remain required.
- Only updating Homebrew pnpm: the existing project and CI pins would still
  select 11.10.0. Both repository declarations and effective execution matter.
- Stopping at pnpm 11.28.8 without assessing 12: the owner requested latest-tool
  research, and supported pnpm 12 installation/CI paths are now available.
- Independently installing npm 12, moving Node back to LTS 24, upgrading every
  Homebrew formula, or restarting live tmux sessions: none is required for the
  selected repository toolchain and each expands operational impact.
- Creating a tool-version checker framework, new test fixtures, or a standalone
  upgrade script: existing package metadata, setup docs, and tests suffice.

## Risks and Mitigations

- pnpm 12 has stricter settings and different resolution internals. Use its
  supported setup action, preserve the build allowlist, inspect lockfile
  resolutions, and prove a clean frozen installation with strict peers before
  accepting the candidate.
- New Node types or Zod behavior can reveal real type/schema failures. Keep the
  existing test gates and supported runtime floor; do not suppress diagnostics
  or change production behavior under this dependency-only scope.
- ESLint 9 remains unsupported. Explicitly retain that outstanding migration
  in the setup guide and final evidence, with its concrete source-change
  implications. This plan does not describe all installed packages as current
  or claim to resolve every advisory. Remaining major updates need a reviewed
  migration; no audit-fix-force operation belongs in this implementation.
- Multiple agents share host tools. Perform host mutation once, retain the old
  nvm runtime, and record the resolved executable and version. Never substitute
  brew upgrade node for this machine's nvm setup. Do not change the active Git
  provider or kill/restart tmux to obtain a new version during coordination.
- Registry/formula versions may move after this observation. Revalidate the
  named target, publish the actual result, and reassess a different target;
  never report a planned version as an installed one.
- The application version is managed on merge. Retain it unchanged, and keep
  dependency/CI updates separate from release-number management.

## Conclusion

Implement a bounded, reproducible upgrade to pnpm 12.15.0, Node 26.12.1,
gh 2.103.0, and the four selected dependency updates, with CI/bootstrap/docs
aligned and the existing verification gates intact. Publish the latest-version
inventory and explicit deferrals so the owner can distinguish completed
upgrades, pending host operations, and major migrations requiring separate work.

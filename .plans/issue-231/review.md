# Issue 231 plan review (claude)

Reviewed pins:

- cursor `3f3c127cc93244ef39a390b73c06ba7e69147739`
- codex `26a6740a64f13199c35922922a8062af82f77976`
- claude `70d11af63f38cb21dfd791fc3a0ca92f55eda87a`

I read each plan from its bound input file. I checked the facts below against
the baseline tree: `src/install.ts`, `src/cli.ts`, `src/githubIssue.ts`,
`src/githubAuth.ts`, `vitest.config.ts`, `test/onboard.test.ts`,
`test/cli.test.ts`, `test/doctor.test.ts`, and the shared workspace fixture. I
ran no product suite; this review is coordination evidence only.

All three plans agree on the core of the fix, and it is correct. The single
`baseBranch` value that `install()` already passes to `buildWorkspaceConfig`,
`configureCloneIdentity` (`consensus.sharedBranch`), `ensureAgentClone` and
`writeAgentLauncher` is the only thing that needs to change. It should come
from `gh api repos/<owner>/<repo>` → `default_branch`, an explicit
`--base-branch` should win, and `onboard` should gain that flag. The plans
differ on three points: where discovery runs (CLI or `install()`), what happens
when the lookup fails, and how much test and doc surface they add.

## Findings

### Cursor plan

**C1 — Exact File List, `src/install.ts`: "a small sync `gh` adapter used only here, or an injectable `resolveDefaultBranch` seam".**
Rule: a plan must commit to one design, so that its file list and tests can be
checked against the implementation. It must also reuse the existing
account-bound gh path, `withGitHubAccount`, rather than re-implement it.
Failure: the two options touch different surfaces. The "sync adapter" needs a
new synchronous copy of the `gh auth token --user` + `withoutAmbientTokens` +
`GH_TOKEN` logic inside `install()`, which is currently gh-free. That duplicates
the async logic in `withGitHubAccount`/`resolveGitHubToken`. The "seam" option
changes `InstallOptions` and every test caller. A reviewer cannot tell which one
the approved file map authorizes, and the sync option creates a second token
path that can drift from the first.
Correction: pick one. Discovering in the async CLI layer, where
`verifyInstallAccount` already runs with the injected `processRunner`, reuses
`withGitHubAccount` and leaves `install()` synchronous and offline.

**C2 — Exact File List / Risks: discovery inside `install()`, with an error thrown on any failed lookup for a github.com origin.**
Rule: the file list must name every existing test file that the change breaks.
Failure: several existing tests call `install()`/`onboard()` directly on
fixtures whose origin is rewritten to a fake GitHub URL:

- `test/onboard.test.ts` at the dry-run `install({...})`, the `onboard(options)`
  under a restricted `PATH` with no `gh`, and the "does not publish the owner
  locator" / "keeps a valid locator" cases;
- `test/doctor.test.ts` (origin `https://github.com/example/myserver.git`, two
  `install({...})` calls).

The CLI install tests in `test/cli.test.ts` use the same fake origin and inject
no runner. Under this plan every one of these calls either reaches real GitHub
or throws: `gh` is missing under the restricted `PATH`, and the repository is
missing or unauthorized otherwise. The plan lists neither `test/doctor.test.ts`
nor `test/cli.test.ts`, so following it as written fails `pnpm check:fast`, or
needs files outside the approved map.
Correction: list every affected test file with the stub each needs, or move
discovery to the CLI so direct `install()` callers are unaffected.

**C3 — Tests: "`pnpm vitest run test/githubIssue.test.ts test/onboard.test.ts`".**
Rule: plans must name commands that actually run.
Failure: `vitest.config.ts` (the default config) excludes `test/onboard.test.ts`;
it runs only under `vitest.system.config.ts`. That command therefore never
executes the onboard regression the plan relies on, and the developer sees only
the `githubIssue` cases pass.
Correction: `pnpm exec vitest run --config vitest.system.config.ts test/onboard.test.ts`.

**C4 — Tests: "`file://` / non-github origin keeps `main`" and "`baseBranch: "develop"` ignores the API value".**
Rule: a regression fixture must be able to reach the asserted state.
Failure: the `product()` fixture in `test/onboard.test.ts` has only a `main`
branch. An explicit `develop` fails the existing `refs/heads/<branch>`
preflight ("has no 'develop' branch") before any config is written. The test
cannot assert the override unless it also creates that branch, and the plan does
not say so.
Correction: create the override branch (local plus `refs/remotes/origin/…`) in
the fixture, or assert the override with a branch that already exists.

### Codex plan

**X1 — Tests: four grouped regression families across four test files.**
The families are: a metadata table of origin forms, an error table of six input
classes, onboarding with no local branch and with a feature-branch HEAD, a
re-onboard with a working-branch clone, CLI routing for override × command, the
`--origin` flag, an ambient-token conflict, failure-leaves-bytes-unchanged,
dry-run, and installer preflight.
Rule: the action requires the fewest focused tests that fail before and pass
after the change.
Failure: several of these pass before the change, so they are not regressions
for this issue:

- clone working-branch preservation, which `syncAgentClone` already guarantees;
- the ambient-token isolation that `withGitHubAccount` already provides and
  `test/githubAuth.test.ts` already covers;
- failure-leaves-config-unchanged.

Including them roughly triples the system-test surface in the slowest suites
(`test/cli.test.ts`, `test/onboard.test.ts`, `test/install.test.ts` all run
under `vitest.system.config.ts`) without adding coverage of the new behaviour.
Correction: keep one helper unit case (success plus failure), one onboard
end-to-end case for a non-main default, and one override assertion. Drop the
cases that already pass at baseline.

**X2 — Exact File List item 3: replace the local-branch preflight with "local branch commit or `refs/remotes/origin/<branch>`", and add Git branch-name validation; item 8, `docs/setup-workspace.md`.**
Rule: keep within the issue, and justify scope beyond it.
Failure: the issue asks only to discover and persist the default branch. The
preflight relaxation also changes behaviour for an explicit `--base-branch`
that exists only as a tracking ref, which is a separate install-policy change.
It brings its own tests (the install.test.ts preflight family) and a docs
section. It is defensible, but the plan justifies it with a scenario: an owner
on a feature branch with no local default branch. The issue does not report
that scenario. As written, the plan widens the approved map to eight files when
four would solve the issue.
Correction: either keep the existing `refs/heads/<branch>` preflight, whose
error is already actionable, or split the relaxation into a follow-up.

**X3 — Reuse and Scope: "GitHub lookup failure is an error … owners choosing a different shared branch pass the override on subsequent setup runs too."**
Rule: setup must not need network access it did not need before, unless the
issue requires it. Onboarding without a selected account is offline at
baseline.
Failure: with this design, an owner who re-onboards offline, or with `gh`
uninstalled, can no longer refresh hooks or launchers. That includes the
existing restricted-`PATH` onboard test scenario. Today that works. The plan
mitigates this with "pass `--base-branch`", but a workspace whose correct
branch is already saved in `config.json` gets a hard failure where a warning
plus the saved value would be correct.
This is a design trade-off, not a correctness bug. Codex's concern about
silently wiring `main` is valid, so a fallback has to be loud: an explicit
stderr warning naming `--base-branch`, as in the claude plan. If the group
prefers a hard failure, the plan already updates the affected tests.

### Claude plan (self-review)

**S1 — Exact File List, `src/cli.ts` `discoverBaseBranch` / `src/githubIssue.ts` `fetchGitHubDefaultBranch`: no timeout on the `gh api` call.**
Rule: a network call on the setup path must be bounded, as the token lookup
already is (`TOKEN_LOOKUP_TIMEOUT_MS = 30_000` in `src/githubAuth.ts`).
Failure: on a stalled network or a hung gh, `coord onboard` blocks indefinitely
before printing anything. The warning-and-fallback path never triggers, because
the runner never returns.
Correction: give `fetchGitHubDefaultBranch` the `ProcessRunner` options
parameter and pass `{ timeoutMs: 30_000 }`, as codex's plan does. A timeout
then turns into the existing fallback warning.

**S2 — Risks: "an ambient `gh api` does not prompt".**
Rule: a risk claim must be backed by a mechanism.
Failure: nothing in the plan sets `GH_PROMPT_DISABLED` on the ambient
(no-account) path. The claim rests on gh's current behaviour, not on code this
change controls.
Correction: none required for correctness, because S1's timeout bounds it
anyway. Drop the claim or rely on the timeout.

No other defects found. The claude plan:

- keeps `install()` synchronous and offline;
- reuses `withGitHubAccount`, `githubRepositoryFromOrigin` and
  `readPreviousConfig`;
- names every test file it must touch (`test/githubIssue.test.ts`,
  `test/onboard.test.ts`, `test/cli.test.ts`);
- uses the correct Vitest tiers;
- adds two regression cases, both of which fail at baseline.

## Conclusion

- **Cursor:** revise. C1 leaves the design undecided. C2 omits test files that
  the plan as written would break, so the approved map cannot be followed
  without expanding it. C3 names a command that skips the key regression test.
- **Codex:** acceptable in its core design, which is the same CLI-layer
  discovery as the claude plan, but over-scoped (X1, X2). Its hard-fail policy
  (X3) is a defensible alternative, not a defect.
- **Claude:** acceptable with the S1 correction (a 30-second bound on the
  lookup).

I recommend the claude plan with S1 applied as the selected plan. Codex's plan
reduced to the four-file core would be an equivalent second choice.

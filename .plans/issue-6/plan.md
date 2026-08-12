# Issue 6 plan — Claude

Simplify coordination bootstrap and onboard (`coord N` from GitHub issues).

## Context

Issue 6 changes the operator surface only. Every step, gate, evidence
predicate, pin rule, and finalization invariant in `src/steps.ts`,
`src/evidence.ts`, `src/pinValidation.ts`, and `src/finalization.ts` is
untouched, and so are `githooks/**`, `src/hookSync.ts`, `src/hookPolicy.ts`,
`src/runLoop.ts`, `src/mirror.ts`, and `src/tmux.ts`. The change must be
reviewable as "how work starts", not "how work is verified".

Binding decisions taken as fixed: the product's tracked tree stays unchanged and
human developers of the product get nothing; the install root stays a real
coordination checkout because hook shims exec canonical bodies out of it;
`coord install` keeps every advanced flag; agents keep authoring their own plans
on their own branches.

Baseline: `main` at `f9d0084`.

## Six changes

**1. The product→runtime pointer is two git-config keys, not a registry.**
Agent clones already carry `coord.workspaceConfig` pointing at the absolute
config path (`src/hookPolicy.ts:21`, set by `configureCloneIdentity`). `onboard`
writes that same key plus a new `coord.coordRoot` into the **product** clone,
through the same `localConfigSet` helper. Resolution is then two lines: use
`--config`/`--coord-root` when given, otherwise read the two keys from the git
worktree at `--product` or at the cwd. It works from the product, from any agent
clone, and for any `--coord-root`; it needs no new file, no new schema, no
global state, and no disambiguation rules. `.git/config` is untracked and
per-clone, so `git status` in the product stays empty and other people's clones
are unaffected. This is the one new kind of write this issue makes to the
product clone, and `clearCloneIdentity` already knows how to remove such keys.

**2. One layout function, not four.** Keep `workspaceConfigPath(coordRoot,
project)` and its name, so no call site in `install`, `uninstall`, `doctor`, or
the tests changes. Its body becomes three clauses: return the nested path when
`<coord-root>/workspaces/<project>/config.json` already exists (never relocate
an existing install); return the nested path when a **flat** config exists for a
different project (the multi-product case); otherwise return
`<coord-root>/config.json`. One rule serves reads and writes, fresh installs get
flat, and existing installs keep working with no migration.

**3. The digest binds `config` + the GitHub issue; `digestPaths` defaults to
`[]`.** `automationDigestMaterial` gains the issue snapshot as a second built-in
source. `digestPaths` relaxes from `.min(1)` to `.default([])` rather than being
deleted, so a product that wants a spec file hashed keeps the option and
fail-closed still holds for anything declared. The snapshot is canonical JSON of
`{ repository, number, title, body }` — issue content only, so re-hashing the
persisted file reproduces the digest. Fetch provenance goes to the journal.

The digest is computed before `issue-N/` may exist, so the bytes are built in
memory, hashed, and written to `<coord-root>/issue-N/issue.json` right after
`createIssueRuntime`, inside the existing try block whose `rmSync` already
cleans up a failed start. Hashed bytes and persisted bytes are the same string
by construction.

`gh issue view N --repo <r> --json number,title,body` runs through the
`ProcessRunner` that `start` already injects for `git ls-remote`
(`src/cli.ts:444`), so faking it in tests needs no new injection point. A
non-github.com origin, a missing `gh`, and a 404 each fail with their own
remediation, the last one naming `gh issue create`. **Accepted consequence:** a
product whose origin is not github.com can no longer start. That is what R5
specifies, and building an `--issue-snapshot` escape for it is scope this issue
did not ask for.

**4. `coord N` starts or resumes.** `start` refuses when `issue-N/` exists
(`src/cli.ts:440`), so a literal "start then run" would fail on the second
invocation, including after `Ctrl-C`. `coord N` starts when the runtime is
absent and resumes when it is present, then runs either way. The explicit
`coord start N` keeps its refusal exactly as it is.

**5. `profile` moves into the workspace config**, defaulted to `consensus` and
written from `--profile`. Without this, `coord N` cannot avoid a required flag.
It also fixes the existing oddity that `install --profile` only affects printed
prose (`src/install.ts:371`) while the real decision is retyped at every start.

**6. `bootstrap.sh` is POSIX `sh` with three flags.** `--root` (also
`COORD_INSTALL_ROOT`, default `~/.local/share/coordination`), `--no-path`, and
`--source <url|path>` defaulting to the GitHub URL — `--source` exists so the
tests and in-tree developers can point at a local checkout, and it is what makes
R8's bootstrap tests possible without a network. `--no-build` skips the build so
those tests do not pay for `pnpm install` twice per case. The installed
`~/.local/bin/coord` is a four-line heredoc that execs `node <root>/dist/main.js`
and does **not** build; the repo-root `./coord` rebuilds stale sources because it
is a developer tool, but an installed root must not require `pnpm` at runtime.
A missing `dist/main.js` says "re-run bootstrap.sh".

No metadata file is added to the install root. R1's "metadata so agent shims can
use `coord.installRoot` / doctor stamps" is already satisfied: the install stamp
records `installRoot`, `cliEntry`, `version`, `commit`, and `canonicalDigest`
(`src/state.ts:105-132`), and `cli.ts` derives its own root from
`import.meta.url` (`src/cli.ts:73`), which is already correct for an installed
checkout. A stamp file would also make that checkout dirty, which
`bootstrap.sh` then refuses to update.

## R6 needs no code

`R2.plan` already requires `.plans/issue-<n>/plan.md` at the agent's pushed
commit (`src/steps.ts:63-69`), `pinValidation` scopes agent branch writes to
`.plans/issue-<n>/**` and its siblings (`src/pinValidation.ts:162-171`), and
`verifyFinalization` makes those paths deletion-only after consensus
(`src/finalization.ts:122`). What R6 needs is for the docs to stop describing a
*different* `plan.md` — the owner's pre-start digest file — under coord-root.
That name collision is most of why the current flow confuses; change 3 removes
it, leaving exactly one `plan.md` in the system, the agent's.

## File map

**New (3):**

1. `scripts/bootstrap.sh` — POSIX `sh`, executable, ~130 lines. Arg parse;
   `git`/`node`/`pnpm` presence with one hint each; clone when the root is
   missing, else verify it is a worktree of `--source`, refuse a dirty tree,
   refuse a non-fast-forward, otherwise `fetch` + `merge --ff-only`; build
   unless `--no-build`; write the wrapper (mode 755) unless `--no-path`, warning
   when `~/.local/bin` is off `PATH`; print the `coord onboard` next step.
2. `test/bootstrap.test.ts` — R8: fresh install, idempotent re-run, dirty
   refusal leaving the checkout unchanged, non-fast-forward refusal, wrapper
   written/skipped, each missing-tool hint. Driven with `--source <fixture>
   --no-build --no-path`.
3. `test/onboard.test.ts` — R8: no-flags onboard leaves the product's
   `git status` empty, writes flat `<coord-root>/config.json` with no
   `workspaces/`, runs doctor, records the two product keys, exits non-zero when
   doctor fails, is a no-op on a second run, and leaves a human clone of the
   product with no hooks.

**Modified (11):**

4. `src/setupWorkspace.ts` — `workspaceConfigPath` gains the three clauses of
   change 2; `workspaceDirectory` becomes its `dirname`; `buildWorkspaceConfig`
   takes `profile`.
5. `src/state.ts` — `digestPaths` `.min(1)` → `.default([])`; add
   `profile: workflowProfileSchema.default("consensus")`. Two lines; no runtime
   state schema change, since `automationDigestSources` already accepts
   arbitrary ids.
6. `src/paths.ts` — add `issueSnapshot` to `IssueRuntimePaths`.
7. `src/install.ts` — `onboard()` lives here beside `install()` (~35 lines:
   defaults, `install` with `writeProduct/vendor/bootstrap` all false, write the
   two product keys, run `doctor`, return its exit code); guard the
   workspace-directory removal so it never removes the coord-root itself when
   the two are the same path; clear the product keys on uninstall; rewrite the
   "Next steps" block to `gh issue create` → `coord <n>`.
8. `src/cli.ts` — `automationDigestMaterial` takes the snapshot; a ~15-line
   `resolveRuntime` shared by `start`, `run`, and the numeric form; the
   `onboard` command; `start` gets optional `--profile`/`--config`/
   `--coord-root` and the issue fetch; `/^[0-9]+$/` dispatches to `coord N`;
   `help` rewritten. `doctor` is left alone — `onboard` runs it for you.
9. `README.md` — bootstrap → onboard → `gh issue create` → `coord N`; the flag
   tables move to `docs/setup-workspace.md`.
10. `docs/setup-workspace.md` — bootstrap section; flat-vs-nested; **delete**
    "Place each issue's owner-authored plan at …" and replace it with the
    issue-snapshot model.
11. `docs/coord-driver.md` — `digestPaths` becomes "optional extra hashed
    inputs"; document `config` + `github-issue`, `issue.json` in the topology,
    and the flagless start commands.
12. `config.example.json`, `config.product.example.json` — drop the
    `digestPaths` entry, add `profile`.
13. `test/cli.test.ts`, `test/install.test.ts`, `test/doctor.test.ts`,
    `test/support/workspaceFixture.ts` — flat default and issue-seeded digest;
    **add** the R8 nested-compatibility case (a pre-existing
    `workspaces/<project>/config.json` still resolves for start, doctor, and
    uninstall) and the R8 case that start seeds the digest from issue content
    with no `plan.md` anywhere.

## Simplifications

- `digestPaths: []` makes the "Digest source … is missing" failure
  (`src/cli.ts:179`) unreachable on a default install, and retires the
  `<coord-root>/workspaces/<project>/.plans/` directory that existed only to
  satisfy it.
- One `resolveRuntime` replaces the hand-rolled flag derivation in `start` and
  `run`; `context()` (`src/cli.ts:122`) folds into it.
- `--profile` leaves the daily command line.
- **Proposed, owner may veto:** delete `scripts/fresh-issue.sh`. It creates
  `.plans/`, `.signals/`, `.code-reviews/` and prints `issue-N:<baseline>`.
  `start` now produces the session id and agents create the directories when
  they publish; nothing in `src/`, `githooks/`, `templates/`, or the docs
  references it.
- **Proposed, owner may veto:** delete `--bootstrap-coordination` and
  `bootstrapCoordination()` (`src/install.ts:145-160`); `bootstrap.sh` owns that
  job on the correct side of the boundary. The `bootstrapped` stamp field stays
  — `installStampSchema` is `.strict()`, so removing it would make existing
  configs unparseable — and remains permanently `false`.
- `ownsInstallRoot` stays `false` even though `bootstrap.sh` genuinely creates
  the checkout. One install root serves every onboarded product, so letting one
  product's `uninstall --delete-coordination` remove it would re-open exactly
  what issue 4's R17 closed. Removing a bootstrapped install is
  `rm -rf ~/.local/share/coordination ~/.local/bin/coord`, documented.

## Requirement trace

| Req | Lands in | Verified by |
| --- | --- | --- |
| R1 | `scripts/bootstrap.sh` | `test/bootstrap.test.ts` |
| R2 | `onboard()` in `src/install.ts`, `onboard` command | `test/onboard.test.ts` |
| R3 | `workspaceConfigPath` clauses | `test/onboard.test.ts` (flat), `test/install.test.ts` + `test/doctor.test.ts` (nested) |
| R4 | product git-config keys, `resolveRuntime`, numeric dispatch | `test/cli.test.ts` |
| R5 | issue fetch, `paths.issueSnapshot`, `digestPaths` default | `test/cli.test.ts` |
| R6 | docs only — already enforced by `src/steps.ts` | existing `test/evidence.test.ts` |
| R7 | `README.md`, `docs/*.md`, examples, `help` | doc review; `help` asserted in `test/cli.test.ts` |
| R8 | the three test files above | `pnpm check` |

The four-agent canary in `test/integration.test.ts` changes only where it
builds a config, and must otherwise pass unchanged — that is the check that the
protocol was not disturbed.

## Sequencing

Four commits, each green under `pnpm check:fast`:

1. `workspaceConfigPath` clauses + `profile` in the config + nested-compat test.
   No behaviour change for existing installs.
2. Issue-seeded digest and `digestPaths: []`.
3. Product keys, `resolveRuntime`, `onboard`, numeric dispatch, tests.
4. `bootstrap.sh` + its tests; then docs, examples, and help, with the two
   proposed deletions last so they revert independently.

## Risks

- **Flat/nested ambiguity during migration.** Contained by "never relocate an
  existing nested install" and by the uninstall guard, which is the only place
  the ambiguity could delete data.
- **`gh` becomes a start-time dependency** for every product, not just
  `prPolicy: coord-open-unmerged` (`src/runLoop.ts:58-92`). Non-github.com
  origins can no longer start; see change 3.
- **Docs are the largest surface by line count and the least checkable.** `help`
  is asserted in tests; the Markdown gets read end-to-end before review.

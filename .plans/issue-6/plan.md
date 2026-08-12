# Issue 6 plan — Claude

Simplify coordination bootstrap and onboard (`coord N` from GitHub issues).

## Context and binding decisions

Issue 6 does not change the workflow protocol. Every step, gate, evidence
predicate, pin rule, and finalization invariant in `src/steps.ts`,
`src/evidence.ts`, `src/pinValidation.ts`, and `src/finalization.ts` stays
exactly as issue 1 built it and issue 4 installed it. What changes is the
**operator surface**: how coordination gets onto a machine, how a product gets
wired once, where the workspace config lives, what the start-time digest binds
to, and how a day's work begins.

Binding decisions taken from the issue text and treated as fixed:

1. **Governing rule unchanged.** Coordination constrains agents and the owner
   control plane. The product's tracked tree stays byte-for-byte unchanged by
   default, human developers of the product get no hooks and no Node
   requirement, and `onboard` inherits that default from `install` rather than
   relaxing it.
2. **The install root remains a real coordination checkout.** Agent hook shims
   exec canonical bodies out of `coord.installRoot`; a PATH-only binary is not
   sufficient. `bootstrap.sh` produces that checkout; it does not vendor
   anything into a product.
3. **The GitHub issue is the work statement.** `coord start N` fetches issue N
   and materialises the snapshot itself. The owner never hand-authors
   `<coord-root>/.plans/issue-N/plan.md` before a start.
4. **Agent plans stay agent-authored, on agent branches.** `R2.plan` already
   requires `.plans/issue-<n>/plan.md` at the agent's pushed commit
   (`src/steps.ts:68`). R6 is therefore a documentation requirement, not a code
   one — see "R6 is already implemented" below.
5. **`coord install` survives.** Every advanced flag keeps working; `onboard` is
   a defaulting front end over it, not a replacement.

Baseline for this plan: `main` at `f9d0084` (issue 4 / PR #5 merged).

---

## Design decisions

Five decisions carry the whole change. Each one is stated with the alternative
it displaces, because the alternatives are the obvious ones and the reasons for
rejecting them are the substance of the plan.

### D1 — Product→runtime pointer: one registry file, not four discovery rules

`coord 42` must find the product's config and coord-root with no flags, and
`coord start 42 --product <path>` must do the same (R4). Four mechanisms are
available: explicit flags, a key in the product clone's `.git/config`, a
`<parent>/coord-runtime` naming convention, and a machine-level registry.

**Decision: explicit flags, then a registry, then nothing.** Onboard writes one
entry to `$XDG_STATE_HOME/coordination/products.json` (default
`~/.local/state/coordination/products.json`); every runtime-resolving command
reads it. Resolution order:

1. `--config` / `--coord-root` given explicitly → used verbatim (unchanged
   behaviour, unchanged containment checks).
2. `--product <path>` → the registry entry whose `productRoot` realpath matches.
3. No `--product`, and the cwd is inside a git worktree that is a registered
   product **or one of its agent clones** → that entry.
4. No `--product`, exactly one entry in the registry → that entry.
5. Otherwise → error listing every registered product and the `--product` flag
   that disambiguates.

Rejected: writing `coord.coordRoot` into the product clone's `.git/config`. It
is a second source of truth for the same fact, it only works when the command
runs from that specific clone, and the registry is needed anyway for rule 4.
Rejected: the `<parent>/coord-runtime` convention as a *resolution* rule. It is
a good default for `onboard` (R2 mandates it) but a bad inference at start time,
because guessing a coord-root and then writing state into it is exactly the
class of mistake `--coord-root` was made explicit to prevent.

The registry never weakens safety: `resolveSafeCoordRoot` still validates
containment against every agent root before the first write, and the registry is
owner-written by `onboard`, not agent-writable. The help text's claim that
"--coord-root must always be explicit" is rewritten to state what is actually
load-bearing — containment validation, not typing.

Self-healing: an entry whose `configPath` no longer exists is reported with the
`coord onboard` line that repairs it, and `coord uninstall` removes its entry.

### D2 — Layout: resolve both, write flat

`workspaceConfigPath()` (`src/setupWorkspace.ts:70`) hardcodes
`<coord-root>/workspaces/<project>/config.json`. R3 wants flat as the happy path
with nested still resolvable.

**Decision: split read-resolution from write-selection.**

- Read: `resolveWorkspaceConfig(coordRoot, project?)` returns the flat path
  `<coord-root>/config.json` when it exists and its `project` matches the
  request (or no project was requested), otherwise the nested path when that
  exists, otherwise a "not installed" result carrying the path that *would* be
  written. Flat wins on ties, which can only happen mid-migration.
- Write: `chooseWorkspaceConfigPath(coordRoot, project)` returns nested if a
  nested config for this project already exists (never silently relocate an
  existing install), or if a flat config for a *different* project holds the
  slot (that is the multi-product case); flat otherwise.

This keeps every existing install working with no migration step, makes the
fresh single-product case flat, and puts the multi-product rule in one function
instead of scattering `existsSync` checks through install, uninstall, doctor,
and onboard.

One hazard this creates, and the guard for it: uninstall currently removes the
workspace directory when it is left empty (`src/install.ts:527-528`). In flat
layout that directory *is* the coord-root, which holds `mirror.git` and every
`issue-N/`. The directory removal is therefore gated on `layout === "nested"`.
The same applies to `--wipe-runtime`'s "other workspaces" scan.

### D3 — Digest: config + issue snapshot, with `digestPaths` demoted to opt-in

`automationDigestMaterial` (`src/cli.ts:162`) hashes the config plus every
`digestPaths` template, and `digestPaths` defaults to
`[".plans/issue-{issue}/plan.md"]` with `.min(1)` (`src/state.ts:153-161`). A
missing file is a hard start failure — which is exactly the pressure that made
owners hand-author plan files.

**Decision:** the digest binds `config` + `github-issue`, and `digestPaths`
becomes an optional list defaulting to `[]`.

- Schema: `.min(1)` → `.default([])`, same confinement refinements. Declaring
  paths remains supported for a product that genuinely wants a pinned spec file
  hashed into the session; the default asks for nothing.
- Source ids in `start.json` become `config`, `github-issue`, then any declared
  paths. `automationDigestSources` already accepts arbitrary ids
  (`src/state.ts:227-236`), so no runtime-state schema change is needed.
- Fail-closed is preserved: a *declared* digest path that is missing still
  fails. Only the default changed.
- Existing installs keep whatever they declared until re-onboarded. That is
  correct — it is a policy the owner's config states — and `onboard` regenerates
  it as `[]`.

The snapshot is canonical JSON containing **only issue content**
(`{ repository, number, title, body }`), written to
`<coord-root>/issue-N/issue.json`. Provenance (`fetchedAt`, the `gh` argv) goes
to the journal, not into the hashed bytes, so re-deriving the digest from the
persisted snapshot is deterministic and replay works.

Ordering: `issueRuntimePaths` refuses to let `start` run when `issue-N/` already
exists, and the digest is computed before that directory is created. So the
canonical bytes are produced in memory, hashed, and written to
`paths.issueSnapshot` inside the existing try block right after
`createIssueRuntime` — under the same `rmSync(paths.issueRoot)` cleanup that
already covers a failed start. The bytes hashed and the bytes persisted are the
same string, by construction rather than by re-serialisation.

Non-GitHub origins and offline runs: `githubRepositoryFromOrigin` returns null
for a non-github.com origin, and today those products can start fine. Failing
them would be a regression, so `start` gains `--issue-snapshot <file>`: a
JSON file supplying `{ title, body }` verbatim in place of the fetch. It is also
what the acceptance tests use for a fixture issue. `gh` absent, unauthenticated,
or 404 produces a remediation naming `gh issue create`, per R5.

### D4 — `coord <n>`: start-or-resume, and profile moves into the config

R4 asks for `coord N` = resolve + start + run. The literal reading breaks on the
second invocation, because `start` refuses when `issue-N/` exists
(`src/cli.ts:440`).

**Decision:** `coord N` starts issue N when its runtime does not exist and
resumes it when it does, then runs the driver either way. That makes it the
daily command it is meant to be — including after `Ctrl-C` — without adding a
`--resume` flag or weakening `start`'s own refusal, which stays exactly as it
is for the explicit `coord start N` path.

**Decision:** `profile` becomes a field of the workspace config, defaulted to
`consensus`, written by `install`/`onboard` from `--profile`. `coord start`'s
`--profile` becomes optional and overrides the config for one run. This removes
a required flag from the daily path, and removes the current oddity that
`install --profile` only affects a printed hint (`src/install.ts:371`) while the
real decision is retyped at every start.

### D5 — `bootstrap.sh` is POSIX `sh`, and testable without a network or a build

`curl … | sh` means no bashisms, no `$BASH_SOURCE`, and no assumption that the
script sits in a checkout. It also means the acceptance tests (R8) must be able
to run it without cloning from GitHub and without a two-minute `pnpm install`.

**Decision:** three flags carry that: `--source <url|path>` (default the GitHub
URL, a local path for tests and for owners who develop coordination in-tree),
`--ref <branch>` (default `main`), and `--no-build`. Plus `--root`, `--no-path`,
and `--help`. The fast test tier drives it with `--source <fixture> --no-build
--no-path`; one e2e test does a real build.

**Decision:** the installed `~/.local/bin/coord` wrapper does **not** build.
The repo-root `./coord` rebuilds stale sources because it is a developer tool;
an installed root must not require `pnpm` at runtime. Missing `dist/main.js`
produces "re-run bootstrap.sh", not a silent build.

**Decision:** no new metadata file in the install root. R1's "metadata so agent
shims can use `coord.installRoot` / doctor stamps" is already satisfied — the
install stamp records `installRoot`, `cliEntry`, `version`, `commit`, and
`canonicalDigest` (`src/state.ts:105-132`), and `cli.ts` derives its own install
root from `import.meta.url` (`src/cli.ts:73`), which is already correct for an
installed checkout. Adding a stamp file in the install root would also make that
checkout dirty, which `bootstrap.sh` then refuses to update. Nothing to add.

---

## Exact file map

### New files

1. **`scripts/bootstrap.sh`** (~150 lines, POSIX `sh`, executable) — R1.
   `usage()`; arg parse for `--root`, `--source`, `--ref`, `--no-path`,
   `--no-build`, `--help`; `COORD_INSTALL_ROOT` honoured, `--root` wins.
   `require_tool git|node|pnpm` emitting one hint per missing tool (nvm line for
   Node, corepack line for pnpm) and exiting 3. Clone when the root is missing;
   when it exists, verify it is a worktree of `--source`, refuse when
   `git status --porcelain` is non-empty (exit 4), otherwise `fetch` +
   `merge --ff-only` and refuse a non-fast-forward (exit 4). Build unless
   `--no-build`. Write `~/.local/bin/coord` (mode 755) unless `--no-path`, warn
   when `~/.local/bin` is not on `PATH` with the `export` line. Print the
   `coord onboard /path/to/app` next step. Touches no product repo and performs
   no onboarding.

2. **`templates/coord-wrapper.sh`** (~12 lines) — the `~/.local/bin/coord` body,
   with `@INSTALL_ROOT@` substituted by `bootstrap.sh`. A template rather than a
   heredoc so `test/wrapper.test.ts`-style assertions can read the shipped
   bytes, matching how `templates/hooks/shim.sh` is already handled.

3. **`src/registry.ts`** (~130 lines) — D1. `registryPath(env)`;
   `productEntrySchema` / `registrySchema` (zod, `formatVersion: 1`, entries of
   `{ productRoot, project, coordRoot, configPath, profile, onboardedAt }`);
   `readRegistry`, `recordProduct` (upsert by `realpath(productRoot)`, atomic
   write through the existing `atomicWriteJson`, mode 0700 directory),
   `forgetProduct`, and `resolveProduct({ productPath?, cwd, flags })`
   implementing the five-step order with the multi-entry error message. An
   unparseable registry is reported with its path and the `onboard` line that
   rewrites it — never silently discarded.

4. **`src/githubIssue.ts`** (~90 lines) — D3. `issueSnapshotSchema`;
   `canonicalIssueSnapshot(snapshot): string` (stable key order, trailing
   newline — the exact bytes both hashed and written);
   `fetchIssueSnapshot({ repository, issue, runner })` shelling
   `gh issue view <n> --repo <r> --json number,title,body`;
   `readIssueSnapshotFile(path)` for `--issue-snapshot`. Distinct remediations
   for: origin is not github.com (use `--issue-snapshot`), `gh` not on PATH,
   `gh` not authenticated, and issue not found ("Create the GitHub issue first:
   `gh issue create`").

5. **`src/onboard.ts`** (~110 lines) — R2. `onboard(options)`: defaults
   `coordRoot = <parent-of-product>/coord-runtime`,
   `agents = claude,codex,cursor,antigravity`, `profile = consensus`,
   `cloneRoot = <parent-of-product>`, `installRoot = <this CLI's root>`; calls
   `install()` with `writeProduct: false, vendor: false, bootstrap: false`; runs
   `doctor()` and returns its exit code (non-zero doctor ⇒ non-zero onboard, and
   the registry entry is still recorded so `coord doctor` can be re-run without
   re-typing paths); records the registry entry; prints the
   `gh issue create` → `coord <n>` next steps.

6. **`test/registry.test.ts`** (~120 lines) — resolution order, cwd-inside-clone
   detection, multi-entry disambiguation error, stale-entry message,
   unparseable-registry message.

7. **`test/githubIssue.test.ts`** (~110 lines) — canonical bytes are stable
   across key order and re-serialisation; each failure mode's remediation text;
   `--issue-snapshot` parsing and rejection of a malformed file.

8. **`test/onboard.test.ts`** (~200 lines) — R8. No-extra-flags onboard against
   the existing product fixture: product `git status` empty, flat
   `<coord-root>/config.json` written, doctor invoked, registry entry recorded,
   non-zero exit when doctor fails, second run is a no-op (empty `changes`), and
   a human clone of the same product has no coordination hooks afterwards.

9. **`test/bootstrap.test.ts`** (~160 lines) — R8, fast tier, driven with
   `--source <local fixture> --no-build --no-path`: fresh install clones; a
   clean re-run is idempotent; a dirty root is refused with exit 4 and nothing
   mutated; a non-fast-forward is refused; the wrapper is written with mode 755
   and points at the root; `--no-path` skips it; each missing-tool hint fires.

10. **`test/bootstrap.e2e.test.ts`** (~60 lines) — e2e tier: a real
    `pnpm install --frozen-lockfile && pnpm build` into a temporary root, then
    `<root>/dist/main.js --help` and the installed wrapper both run.

11. **`.plans/issue-6/plan.md`** — this file (R2/R6: authored by the agent, on
    the agent's branch).

### Modified files

12. **`src/setupWorkspace.ts`** — D2. Replace `workspaceDirectory` /
    `workspaceConfigPath` with `flatWorkspaceConfigPath(coordRoot)`,
    `nestedWorkspaceConfigPath(coordRoot, project)`,
    `resolveWorkspaceConfig(coordRoot, project?)` →
    `{ path, directory, layout, exists }`, and
    `chooseWorkspaceConfigPath(coordRoot, project)` → same shape.
    `writeWorkspaceConfig` takes the chosen path instead of deriving it.
    `buildWorkspaceConfig` gains `profile` (D4) and keeps taking the config
    directory for `relativeFrom`, which now resolves against the flat root.

13. **`src/state.ts`** — `coordinatorConfigSchema`: `digestPaths`
    `.min(1)` → `.default([])` (D3); add
    `profile: workflowProfileSchema.default("consensus")` (D4). The uniqueness
    superRefine is unchanged and correct for an empty list. No change to
    `startStateSchema`.

14. **`src/install.ts`** — use the layout resolver for both write and uninstall
    paths; pass `options.profile` into `buildWorkspaceConfig`; gate the
    workspace-directory removal and the `--wipe-runtime` "other workspaces"
    scan on `layout === "nested"` (D2); call `forgetProduct` on uninstall;
    rewrite the "Next steps" block to the `gh issue create` / `coord <n>` happy
    path.

15. **`src/doctor.ts`** — resolve the config through the layout resolver, so
    both layouts are diagnosed (R3); the "no installed workspace" error names
    both candidate paths; `checkStartCompatibility`'s `{issue}`-placeholder
    finding now only applies to explicitly declared `digestPaths` (vacuous by
    default). No new finding classes and no exit-code changes.

16. **`src/paths.ts`** — add `issueSnapshot: containedPath(issueRoot,
    "issue.json")` to `IssueRuntimePaths` (D3). One line plus the type.

17. **`src/cli.ts`** — the largest change, and still net-simpler at the call
    site:
    - `automationDigestMaterial` takes
      `{ configPath, config, issue, issueSnapshot }` and emits `config`,
      `github-issue`, then declared paths.
    - New `resolveRuntime(parsed, io)` helper implementing D1, shared by
      `start`, `run`, `doctor`, and the numeric form; `--product` added to the
      allowed flags of each.
    - New `onboard` command: one positional product path, flags `--coord-root`,
      `--agents`, `--profile`, `--clone-root`, `--declare`, `--origin`,
      `--base-branch`, `--dry-run`.
    - `start`: `--profile` optional (config default), `--config` /
      `--coord-root` optional when resolvable, `--issue-snapshot` added; fetches
      and materialises the snapshot; journals the fetch provenance.
    - Numeric dispatch: a bare `/^[0-9]+$/` command is `coord <n>` — resolve,
      start when `issue-N/` is absent, then `run` (D4).
    - `help` rewritten to lead with bootstrap → onboard → `gh issue create` →
      `coord N`, with the advanced `install`/`uninstall` forms below it and the
      corrected statement about `--coord-root`.

18. **`README.md`** — R7. Replace the "Onboard a product" and "Quick start"
    sections with the three-command happy path; move `install`/`uninstall`
    flags, the nested layout, and `digestPaths` into
    `docs/setup-workspace.md`.

19. **`docs/setup-workspace.md`** — R7. Add a bootstrap section; rewrite "Where
    the config lives, and why" for the flat default plus the nested
    multi-product form; **delete** the "Place each issue's owner-authored plan
    at …" instruction and replace it with the issue-snapshot model and a
    pointer to R2 agent-authored plans (R5, R6).

20. **`docs/coord-driver.md`** — R7. Rewrite the `digestPaths` bullet as
    "optional extra hashed inputs"; document `config` + `github-issue` as the
    digest, `issue.json` in the runtime topology, and `--issue-snapshot`; update
    the "Starting and running" commands to the flagless forms.

21. **`config.example.json`**, **`config.product.example.json`** — drop the
    `.plans/issue-{issue}/plan.md` `digestPaths` entry; add `"profile"`.

22. **`vitest.config.ts` / `vitest.e2e.config.ts`** — exclude
    `test/**/*.e2e.test.ts` from the fast tier and include it in the e2e tier.

23. **`test/cli.test.ts`**, **`test/install.test.ts`**, **`test/doctor.test.ts`**,
    **`test/support/workspaceFixture.ts`** — update for the flat default and the
    issue-seeded digest; **add** the R8 compatibility test that a pre-existing
    `workspaces/<project>/config.json` still resolves for start, doctor, and
    uninstall; **add** the R8 test that start seeds the digest from issue
    content with no owner `plan.md` anywhere.

### Files deliberately untouched

`src/steps.ts`, `src/evidence.ts`, `src/pinValidation.ts`,
`src/finalization.ts`, `src/protocol.ts`, `src/runLoop.ts`, `src/hookSync.ts`,
`src/hookPolicy.ts`, `src/mirror.ts`, `src/tmux.ts`, `githooks/**`,
`templates/hooks/shim.sh`, `scripts/setup_*.sh`. The protocol, the hook
delivery mechanism, and the verification path are not in scope, and issue 6
should be reviewable as an operator-surface change.

---

## Additional simplifications this makes possible

These are beyond the letter of R1–R8 and are the reason the change is a net
reduction rather than an addition.

**S1 — `--profile` disappears from the daily path.** D4 makes it a config field.
`coord install`'s `profile` option stops being decorative, and `coord start`
loses a required flag.

**S2 — `digestPaths: []` retires an entire failure mode.** The "Digest source …
is missing" error (`src/cli.ts:179`) becomes unreachable on a default install,
and with it the `<coord-root>/workspaces/<project>/.plans/` directory that
existed only to satisfy it. `coord uninstall`'s careful "the workspace directory
is also where the owner keeps plans" reasoning (`src/install.ts:521-523`)
becomes obsolete, though the conservative deletion behaviour stays.

**S3 — `scripts/fresh-issue.sh` can be deleted.** It creates
`.plans/`, `.signals/`, and `.code-reviews/` directories and prints an
`issue-N:<baseline>` session id. Both are now produced by the driver: the
session id by `start` (`issueSessionId`), the directories by the agents
themselves when they publish evidence. Nothing in `src/`, `githooks/`,
`templates/`, or the docs references it. **Proposed for deletion**, flagged
separately in review so the owner can veto it independently of R1–R8.

**S4 — one `resolveRuntime` replaces four flag blocks.** `start`, `run`,
`doctor`, and `coord N` currently each re-derive `--coord-root` / `--config`
by hand; after D1 they share one resolver, and `context()` (`src/cli.ts:122`)
collapses into it.

**S5 — `coord onboard` subsumes the four-command README recipe.** install +
doctor + "next steps" prose becomes one command whose failure mode is doctor's
exit code. The README's install section shrinks from a flag table to three
lines.

**S6 — the `--bootstrap-coordination` install flag becomes redundant.** Its job
(running `pnpm install && pnpm build` in the install root) is what
`scripts/bootstrap.sh` now owns, on the correct side of the boundary. Keeping it
means two code paths that build the same checkout. **Proposed for deletion** of
the flag and `bootstrapCoordination()` (`src/install.ts:145-160`) only — the
`bootstrapped` field stays in `installStampSchema`, because that schema is
`.strict()` and removing it would make every existing config unparseable. It
becomes permanently `false`, which is what it already means after issue 4's R17.
Flagged separately for owner veto.

**S6 does not make `ownsInstallRoot` true.** `bootstrap.sh` genuinely creates
the install checkout, which is the first time anything in this project does —
so the tempting move is to stamp ownership and let
`uninstall --delete-coordination` work. The plan deliberately does not: the
operator runs `bootstrap.sh` directly, one install root serves every onboarded
product, and letting one product's uninstall delete the shared root is exactly
the failure issue 4's R17 closed. `ownsInstallRoot` stays `false` and
`--delete-coordination` keeps refusing. Removing a bootstrapped root is
`rm -rf ~/.local/share/coordination ~/.local/bin/coord`, documented in
`docs/setup-workspace.md`.

S3 and S6 are proposed, not assumed; the plan is implementable without either.

---

## R6 is already implemented

`R2.plan` requires `.plans/issue-<n>/plan.md` at the agent's own pushed commit
(`src/steps.ts:63-69`), `pinValidation` scopes agent branch writes to
`.plans/issue-<n>/**` and its siblings (`src/pinValidation.ts:162-171`), and
`verifyFinalization` makes those paths deletion-only after consensus
(`src/finalization.ts:122`). Nothing about agent-authored plans needs building.
What R6 needs is for the docs to stop describing a *different* `plan.md` — the
owner's pre-start digest file — with the same name, in the same-looking path,
under coord-root. That collision is most of why the current UX is confusing, and
D3 removes it: after this change there is exactly one `plan.md` in the system,
it is the agent's, and it lives on the agent's branch.

---

## Requirement trace

| Req | Where it lands | Verified by |
| --- | --- | --- |
| R1 | `scripts/bootstrap.sh`, `templates/coord-wrapper.sh` | `test/bootstrap.test.ts`, `test/bootstrap.e2e.test.ts` |
| R2 | `src/onboard.ts`, `src/cli.ts` onboard command | `test/onboard.test.ts` |
| R3 | `src/setupWorkspace.ts` resolver; install/uninstall/doctor call sites | `test/onboard.test.ts` (flat), `test/install.test.ts` + `test/doctor.test.ts` (nested compat) |
| R4 | `src/registry.ts`, `resolveRuntime`, numeric dispatch | `test/registry.test.ts`, `test/cli.test.ts` |
| R5 | `src/githubIssue.ts`, `automationDigestMaterial`, `paths.issueSnapshot`, `digestPaths` default | `test/githubIssue.test.ts`, `test/cli.test.ts` |
| R6 | docs only — already enforced by `src/steps.ts` | existing `test/evidence.test.ts` |
| R7 | `README.md`, `docs/*.md`, `config*.example.json`, `help` | doc review; `help` asserted in `test/cli.test.ts` |
| R8 | the six test files above | `pnpm check` |

---

## Test plan

Fast tier (`pnpm check:fast`) covers everything except a real build. New and
changed assertions:

- **Bootstrap idempotency**: second run reports no changes and leaves the same
  commit; **dirty refuse**: a modified tracked file in the root makes the run
  exit 4 with the file named and the checkout unchanged.
- **Onboard, no extra flags**: `git status --porcelain` in the product is empty;
  `<coord-root>/config.json` exists and `<coord-root>/workspaces/` does not;
  doctor ran; the registry entry matches; a doctor failure propagates a non-zero
  exit.
- **Issue-seeded digest**: with a fixture issue and **no** `plan.md` anywhere
  under coord-root, `start` succeeds, `start.json`'s
  `automationDigestSources` ids are exactly `["config", "github-issue"]`,
  `<coord-root>/issue-N/issue.json` holds the canonical bytes, and re-hashing
  the persisted file reproduces `automationDigest`. Two different issues yield
  two different digests. A missing issue fails with the `gh issue create`
  remediation and leaves no `issue-N/` behind.
- **Human clone unaffected**: the existing assertion (a fresh clone of the
  product has no coordination hooks) re-run through `onboard`.
- **Nested compatibility**: a hand-placed `workspaces/<project>/config.json`
  resolves for `start`, `doctor`, and `uninstall`, and uninstall does not remove
  the coord-root in either layout.
- **`coord N`**: starts when `issue-N/` is absent; resumes without error when it
  is present; disambiguates with `--product`; errors listing candidates when two
  products are registered and none is named.

E2E tier adds the real bootstrap build. `test/integration.test.ts` (the
four-agent temporary-origin canary) is updated only where it constructs a
config, and must keep passing unchanged otherwise — it is the check that the
protocol was not disturbed.

---

## Sequencing

Seven commits, each one green under `pnpm check:fast`:

1. Layout resolver (D2) + call sites + nested-compat test. No behaviour change
   for existing installs.
2. `profile` in the config, `--profile` optional (D4, S1).
3. `digestPaths` default `[]` + `src/githubIssue.ts` + digest rebind (D3, R5).
4. `src/registry.ts` + `resolveRuntime` (D1, S4).
5. `src/onboard.ts` + the `onboard` command (R2, S5).
6. `scripts/bootstrap.sh` + wrapper template + tests (R1).
7. Docs, examples, and help (R7); then the S3/S6 deletions as a final,
   separately revertable commit.

## Risks

- **Registry as machine-global mutable state** is the one genuinely new
  category of state this introduces. It is confined to a single file, schema-
  validated, owner-written, never agent-writable, and every consumer degrades to
  an explicit-flag error rather than to a guess.
- **Flat/nested ambiguity during migration.** Mitigated by "flat wins, never
  relocate an existing nested install" and by uninstall's directory-removal
  guard, which is the only place the ambiguity could destroy data.
- **`gh` as a start-time dependency.** Already a dependency for
  `prPolicy: coord-open-unmerged` (`src/runLoop.ts:58-92`); `--issue-snapshot`
  keeps non-GitHub and offline products startable.
- **Doc drift** is the largest surface here by line count and the least
  mechanically checkable. The `help` text is asserted in tests; the Markdown is
  not, so it gets read end-to-end before the branch is pushed for review.

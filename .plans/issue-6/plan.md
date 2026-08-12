# Issue 6 plan — Claude

Simplify coordination bootstrap and onboard (`coord N` from GitHub issues).

**This branch implements Codex's plan** (`origin/issue-6/codex`), plus the
changes the four peer reviews agreed on. Where this document and Codex's differ,
the differences are listed under "Changes adopted from the reviews" and each one
is a finding two or more reviewers made.

Baseline: `origin/main` at `f9d0084`.

## Context and binding decisions

Issue 6 changes the operator surface only. Every step, gate, evidence predicate,
pin rule, and finalization invariant is untouched, and so are `githooks/**`,
`src/hookSync.ts`, `src/hookPolicy.ts`, `src/mirror.ts`, and `src/tmux.ts`. The
four-agent canary in `test/integration.test.ts` passes unchanged, which is the
check that the protocol was not disturbed.

Fixed by the issue and by Codex's plan:

1. The product's tracked tree stays byte-for-byte unchanged and human developers
   of the product get nothing.
2. The install root stays a real coordination checkout, because agent hook shims
   exec canonical bodies out of it.
3. `coord install` keeps every advanced flag; `onboard` is a preset over it.
4. Agents author their own plans on their own branches. `R2.plan` already
   requires `.plans/issue-<n>/plan.md` at the agent's pushed commit
   (`src/steps.ts:63-69`), so R6 was a documentation requirement, not a code
   one — the work was removing the *owner's* same-named pre-start file.

## Proposed architecture

**One workspace resolver** (`src/workspace.ts`). `WorkspaceLocation` carries
`coordRoot`, `workspaceRoot`, `configPath`, and `layout`. It is the only module
that decides flat versus nested. A single product is flat
(`<coord-root>/config.json`); every product after the first nests under
`workspaces/<project>/`, **including its run state**, because GitHub issue
numbers are repository-local. Resolution is flat-first and never relocates an
existing install, so pre-existing nested workspaces keep working with no
migration.

**One product locator.** `onboard` records `coord.ownerWorkspaceConfig` — the
absolute config path — in the owner's product clone. Untracked, per-clone, never
copied to another checkout, cleared by `uninstall`. Deliberately not
`coord.workspaceConfig`: `consensus_wiring_present` in `githooks/lib/identity.sh`
treats that key as proof a clone is an agent clone.

**One start transaction.** `startIssue` in `src/cli.ts` owns resolution,
preflight, launch, snapshot, and durable state. `coord start <n>` and
`coord <n>` both call it in-process; nothing spawns a subprocess, so the
injected runner and run loop the tests depend on survive.

**One digest.** `config.json` bytes + the canonical GitHub issue snapshot +
any declared `digestPaths`. The issue is mandatory and not configurable.

## Changes adopted from the reviews

| Change | Raised by | Why |
| --- | --- | --- |
| Owner locator must not be `coord.workspaceConfig` | Cursor (on Codex) | That key marks an agent clone; a product carrying it with no `consensus.agentId` fails every commit closed the moment hooks are present |
| `coord N` starts **or resumes** | Cursor (on Codex), Claude | `start` refuses an existing runtime; inheriting that breaks the command after `Ctrl-C`, which is the common case |
| Issue snapshot is mandatory, never a `digestPaths` entry | Codex (on Cursor, Antigravity), Cursor (on Codex) | `digestPaths: []` would otherwise remove the work statement, letting two issues share a digest |
| Flat slot occupied by another project ⇒ nest | Codex (on Cursor, Antigravity) | Otherwise the second product overwrites the first product's config |
| Per-workspace `issue-N/` and `mirror.git` | Codex (all), Cursor (all) | Two products cannot share one `issue-42/` |
| `gh issue view` must pass `--repo` from `config.origin` | Codex (on Antigravity) | Otherwise `gh` resolves from the cwd and can hash the wrong repository's issue |
| Snapshot written inside the startup transaction | Codex (on Antigravity), Cursor | A partial start must leave no `issue-N/` behind |
| `profile` persisted in config | Codex (on Antigravity), all plans | `coord N` cannot otherwise avoid a required flag |
| Plan must satisfy `checkPlan` | Codex (on all) | `src/evidence.ts:60-70` requires exact section headings; this document now has them |

Two review findings were **not** adopted, with reasons:

- *Withhold the locator when onboard's doctor fails* (Cursor, on Claude). Codex's
  plan keeps the installed files available for repair, and the locator is what
  makes `coord doctor` re-runnable without retyping paths. Onboard still exits
  non-zero, which is the signal.
- *`--issue-snapshot` escape for non-GitHub origins* (my own earlier plan;
  Codex objected). Codex is right that a user-facing bypass defeats the
  issue-first invariant — `coord start 999 --issue-snapshot fake.json` would
  create a valid run for an issue that does not exist. Tests inject through the
  existing `ProcessRunner` instead. Accepted consequence: a product whose origin
  is not github.com can no longer start.

## Exact file map

**New production files**

1. `src/workspace.ts` — `WorkspaceLocation`, flat/nested resolution,
   install-time selection, `workspaceFromConfigPath` for explicit `--config`,
   and the owner-locator read/write/clear helpers with named failure kinds.
2. `src/githubIssue.ts` — origin parsing (now the single copy; `src/runLoop.ts`
   re-exports it), strict `gh issue view` parsing, canonical snapshot rendering,
   and a distinct remediation per failure mode.
3. `scripts/bootstrap.sh` — POSIX `sh`; tool preflight; clone or clean
   fast-forward; ownership note in `.git/`; build; managed `~/.local/bin/coord`.

**Modified production files**

4. `src/cli.ts` — `resolveWorkspaceLocation`; `context` resolves through it;
   `startIssue` extracted; `onboard` command; numeric dispatch; `--product` on
   start/run/next/doctor; `--profile` optional; `automationDigestMaterial` takes
   the snapshot; help rewritten.
5. `src/install.ts` — selects a workspace through `src/workspace.ts`; writes and
   clears the owner locator; `onboard()` preset; uninstall resolves both layouts
   and never removes a flat workspace root.
6. `src/state.ts` — `profile` defaulted to `consensus`; `digestPaths` default
   `[]`; `atomicWriteText` so the hashed bytes are the persisted bytes.
7. `src/paths.ts` — `issueRuntimePaths` takes a workspace root; adds
   `githubIssue`.
8. `src/setupWorkspace.ts` — no longer owns layout policy; persists `profile`.
9. `src/doctor.ts` — resolves both layouts, including an unparseable flat config.
10. `src/runLoop.ts` — imports the shared origin parser.
11. `README.md`, `docs/setup-workspace.md`, `docs/coord-driver.md`,
    `config.example.json`, `config.product.example.json`.

**New tests**

12. `test/workspace.test.ts` (12), `test/githubIssue.test.ts` (13),
    `test/onboard.test.ts` (12), `test/bootstrap.test.ts` (13).

**Updated tests**

13. `test/cli.test.ts` — issue-seeded digest, `coord <n>` suite, nested
    compatibility; `test/install.test.ts`, `test/doctor.test.ts` — flat paths.

## Tests

`pnpm check` passes: 253 fast tests across 22 files, plus the four-agent
temporary-origin canary. New coverage, by requirement:

- **R1** — clone; idempotent re-run; fast-forward; dirty refusal with the
  checkout and its HEAD unchanged; diverged refusal; non-worktree refusal;
  wrapper installed executable and pointing at the root; `--no-path`; refusal to
  overwrite a foreign `coord`; `--root` over `COORD_INSTALL_ROOT`; missing-tool
  hint before any effect; `sh -n` and `dash -n`.
- **R2** — no-flag onboard leaves `git status --porcelain` empty, writes a flat
  config with no `workspaces/`, runs doctor, records the locator, is a no-op on
  re-run; a fresh human clone of the same origin has no hooks and no locator;
  the locator is none of the three agent-wiring keys.
- **R3** — fresh flat; nested preserved and not relocated; second product nests
  without touching the first; `issue-42` and `mirror.git` differ between them;
  start, doctor, and uninstall all resolve a pre-existing nested workspace.
- **R4** — `coord 7` from the product cwd starts and enters the run loop; a
  second `coord 7` resumes while `coord start 7` still refuses; `--product`
  works from an unrelated directory; a non-worktree and a non-onboarded
  repository each fail with their own remediation.
- **R5** — digest sources are exactly `["config", "github-issue"]`; the digest
  changes when only the issue body changes; the persisted
  `issue-7/github-issue.json` is byte-identical to what was hashed; a missing
  issue fails with the `gh issue create` remedy, calls no start effects, and
  leaves no `issue-7/`.

## Validation

```bash
pnpm check          # lint, typecheck, 253 fast tests, four-agent canary
sh -n scripts/bootstrap.sh
```

Not exercised automatically: a real `curl | sh` against the public repository,
and a real `gh` call. Both are network-dependent; the shell path is covered
against a local fixture repository and the `gh` argv is asserted exactly.

## Alternatives

**A global product registry** (`~/.local/state/coordination/products.json`), as
my first plan proposed. Rejected on Codex's and Cursor's reasoning: it is new
machine-global mutable state, it needs cardinality rules that make the daily
command's target depend on how many products happen to be registered, and a
registry under the install root additionally dirties the checkout bootstrap must
fast-forward. The locator is per-product and needs no such rules.

**Inferring `<parent>/coord-runtime` at start time.** Rejected: it silently
breaks for anyone who passed `--coord-root`, and guessing a runtime and then
writing state into it is the class of mistake explicit `--coord-root` existed to
prevent.

**A symlink for `~/.local/bin/coord`** pointing at the repository's own `./coord`
(Codex's plan). Not adopted: that wrapper rebuilds stale sources, which is right
for a developer checkout and wrong for an installed root, where `pnpm` must not
be a runtime dependency. A generated four-line wrapper that refuses an unbuilt
root and names `bootstrap.sh` is written instead.

**Deleting `digestPaths`.** Rejected in favour of defaulting it to `[]`: a
product that wants an immutable spec file pinned into the session keeps the
option, and fail-closed still holds for anything declared.

**Stamping `ownsInstallRoot: true` when bootstrap created the checkout.**
Rejected: one install root serves every onboarded product, so letting one
product's `uninstall --delete-coordination` remove it re-opens exactly what
issue 4's R17 closed. Removal is documented as `rm -rf`.

## Risks

- **`gh` becomes a start-time dependency** for every product, not only for
  `prPolicy: coord-open-unmerged`. Non-github.com origins can no longer start.
  This is what R5 specifies and the reviews confirmed; it is the one deliberate
  capability regression in this branch.
- **Flat/nested ambiguity during migration.** Contained by "never relocate an
  existing install" and by the uninstall guard that refuses to remove a
  workspace root that is the coord-root — the only place the ambiguity could
  destroy data. Covered by test.
- **Pre-existing runs under an old layout.** A nested product started before
  this change has state at `<coord-root>/issue-N`; new starts use
  `workspaces/<project>/issue-N`. Nothing is moved. An in-flight run is still
  reachable with an explicit `--coord-root`, which continues to mean "the root
  that directly holds `issue-N`".
- **Docs are the largest surface by line count and the least checkable.** `help`
  is asserted in tests; the Markdown was read end-to-end before pushing.

## Conclusion

Implemented and green on `issue-6/claude`. R1–R8 are covered, the protocol layer
is untouched and its canary passes, and the nine cross-review findings above are
folded in. The two findings not adopted are argued rather than dropped.

Outstanding for the owner: whether to accept the non-github.com start
regression, and whether `scripts/fresh-issue.sh` and `--bootstrap-coordination`
should now be deleted — both are made redundant by this branch but neither
deletion is included, since they are outside R1–R8 and reversible separately.

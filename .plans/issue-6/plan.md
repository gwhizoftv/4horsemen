# Issue 6 plan — Cursor

## Context and binding decisions

Issue 6 collapses today’s multi-flag install, nested
`<coord-root>/workspaces/<project>/` happy path, and owner pre-start
`.plans/issue-N/plan.md` ceremony into:

```bash
curl -fsSL …/scripts/bootstrap.sh | sh   # once per machine
coord onboard /path/to/app               # once per product
gh issue create …                        # → N
coord N                                  # start + run; agents plan on branches
```

**Governing rule (unchanged from issue 4):** coordination constrains agents and
the owner control plane, not other product developers. Default product-master
footprint stays zero (`git status` empty after onboard).

This plan assumes issue 4 / PR #5 is on `main` (`coord install` / `uninstall` /
`doctor`, shims, declared `verify`/`checks`, install stamp under coord-root).
Issue 6 layers bootstrap, onboard defaults, flat layout, GitHub-issue digest
binding, and `coord <n>` on top of that surface — it does not reopen hook
delivery or the zero-footprint rule.

Binding decisions for this implementation:

| Topic | Decision |
| --- | --- |
| Install root default | `~/.local/share/coordination` (`--root` / `COORD_INSTALL_ROOT`) |
| PATH wrapper | `~/.local/bin/coord` (skip with `--no-path`) |
| Onboard defaults | `--coord-root=<parent>/coord-runtime`, agents `claude,codex,cursor,antigravity`, profile `consensus`, `--clone-root=<parent>` |
| Flat layout | Fresh single-product writes `<coord-root>/config.json`; resolve **flat first**, then `workspaces/<project>/config.json` |
| Digest inputs | Always `config.json` + materialised GitHub issue N snapshot; **no** owner pre-start `plan.md` |
| Agent plans | Still created on `issue-N/<agent>` as R2 evidence (unchanged protocol) |
| `coord N` | Resolve product/runtime → `start` → `run` (one owner entry) |
| Advanced escape | Keep `coord install` with explicit flags |

## Proposed architecture

### Happy-path vs advanced

```text
bootstrap.sh  →  install root + PATH wrapper
     │
coord onboard <product>  →  installOnce(defaults) + product registry + doctor
     │
coord N [--product …]    →  resolve → start (issue snapshot digest) → run
     │
coord install …          →  advanced / explicit flags (unchanged capability)
```

`onboard` is a **thin CLI wrapper** over the existing `install()` / `installOnce`
path plus doctor and a product→runtime registry write. It must not fork a second
installer.

### Layout resolution (R3)

Introduce one resolver used by install, uninstall, doctor, start, and onboard:

1. If `<coord-root>/config.json` exists and its `project` matches (or is the only
   product), use it (flat).
2. Else if `<coord-root>/workspaces/<project>/config.json` exists, use it
   (legacy / multi-product).
3. Else, for a **new** write: prefer flat when the runtime has no
   `workspaces/` children; if other projects already live under `workspaces/`,
   write nested so multi-product keeps working.

Issue runtimes stay at `<coord-root>/issue-<n>/` (already flat today). Mirror and
containment rules are unchanged.

### Product → runtime pointer (R4)

Do **not** write into the product tree (would break empty `git status`).

Persist under the **install root**:

```text
<install-root>/registry/products/<project-slug>.json
```

Contents (absolute paths): `{ productRoot, coordRoot, configPath, project,
defaultProfile, installedAt }`. Onboard upserts; uninstall removes when it
removes that product’s config. Resolution for `coord N` / `start --product`:

1. Explicit `--config` / `--coord-root` win.
2. Else `--product` (or cwd if it is a registered `productRoot`) → registry →
   stamp cross-check (`coordination.productRoot`).
3. Else fail with remediation (`coord onboard …` / pass `--product`).

### Digest binds to GitHub issue (R5)

Today `automationDigestMaterial` hashes `config.json` plus every
`digestPaths` file and **fails if any path is missing** — which forced owners to
hand-create `.plans/issue-N/plan.md` under the workspace directory.

Change start so that, before hashing:

1. Resolve GitHub issue N from `config.origin` via `gh issue view N --json
   title,body` (or GitHub API with the same fields). Missing/unreadable ⇒ fail
   with “create the GitHub issue first”.
2. Materialise a stable snapshot under the config directory, e.g.
   `issues/issue-<n>.md` (title + body, deterministic encoding).
3. Hash with the existing `sha256-length-prefixed-v1` scheme.

Default `digestPaths` becomes `["issues/issue-{issue}.md"]`. Optional extra
owner inputs remain via `--declare` / declaration `digestPaths`; they are no
longer the happy path. Agent-authored `.plans/issue-N/plan.md` on
`issue-N/<agent>` stays protocol evidence and is **not** a pre-start digest
source.

### `coord <n>` (R4)

When the first argv token is a positive integer, treat it as the daily command:

1. Resolve config + coord-root (registry / flags).
2. Read `defaultProfile` from registry (or config field added by onboard;
   default `consensus`).
3. Call the same start path as `coord start N …` (materialise issue snapshot,
   write runtime, first tick).
4. Then enter `run` (foreground loop) unless `--no-run` is added later as an
   advanced escape — v1 always runs.

`coord start` remains for operators who want start without run; after onboard it
accepts `--product` and may omit `--config` / `--coord-root` / `--profile` when
they resolve from the registry. Explicit flags still override.

### Profile persistence

Today `--profile` on install is only printed in “next steps”; it is not stored.
Onboard’s default `consensus` is useless for `coord N` unless persisted. Add
optional `defaultProfile` on the coordinator config (and mirror it in the
registry). `start` / `coord N` use it when `--profile` is omitted; explicit
`--profile` still wins.

## Exact file map

### New production files

1. **`scripts/bootstrap.sh`** — `curl | sh` entry: resolve install root, clone or
   fast-forward if clean (refuse if dirty), require Node/pnpm with one clear
   hint, `pnpm install --frozen-lockfile && pnpm build`, write
   `~/.local/bin/coord` wrapper pointing at install-root `dist/main.js` (or the
   repo `coord` script), support `--root`, `--no-path`, `COORD_INSTALL_ROOT`.
   Does not touch product repos; does not onboard.
2. **`src/productRegistry.ts`** — read/write/remove install-root product
   registry entries; resolve product → `{ coordRoot, configPath, defaultProfile }`.
3. **`src/workspaceLayout.ts`** — flat-first / nested-compat path helpers:
   `resolveWorkspaceConfigPath`, `writeTargetForNewInstall`, replace the hard-coded
   `workspaceDirectory` / `workspaceConfigPath` nesting assumption.
4. **`src/githubIssue.ts`** — fetch issue title/body; render deterministic
   snapshot markdown; map transport failures to operator remediation.

### Production files to refine

5. **`src/setupWorkspace.ts`** — use layout helpers; default `digestPaths` to
   `issues/issue-{issue}.md`; accept flat `workspaceDir === coordRoot`; keep
   agent root relativisation honest for both layouts.
6. **`src/install.ts`** — call layout + registry upsert; set
   `ownsInstallRoot` when bootstrap created the checkout (if detectable);
   onboard-facing return value includes registry path; wipe-runtime / uninstall
   understand flat config and multi-product nested siblings.
7. **`src/state.ts`** — optional `defaultProfile` on `coordinatorConfigSchema`
   / declaration if needed; keep `digestPaths` confined templates (default
   updated); install stamp unchanged aside from continued `productRoot` use.
8. **`src/cli.ts`** — `onboard` command; numeric `coord <n>` entry; start
   resolution via `--product` / registry; call issue snapshot before
   `automationDigestMaterial`; help text for happy path; stop claiming
   `--coord-root` is always required for every command.
9. **`src/doctor.ts`** — resolve config via layout helper; doctor tip text for
   missing issue snapshot may note that start materialises it (do not require
   pre-existing snapshot files).
10. **`src/hookPolicy.ts`** / **`templates/hooks/shim.sh`** — remediation strings
    may mention `coord onboard` alongside `coord install` where operators are
    told to re-wire.
11. **`coord`** (repo wrapper) — unchanged behaviour for in-tree development;
    bootstrap’s PATH wrapper is the installed analogue.
12. **`README.md`** — happy path: bootstrap → onboard → `gh issue create` →
    `coord N`; advanced install / nested layout / explicit start flagged as
    advanced.
13. **`docs/setup-workspace.md`** — remove “place owner plan before start”;
    document flat layout, onboard, registry, issue-seeded digest; keep advanced
    `install` flags.
14. **`docs/coord-driver.md`** — digest section: config + GitHub issue snapshot;
    agent branch plans as R2 evidence, not start inputs.
15. **`config.example.json`** / **`config.product.example.json`** — default
    `digestPaths` and optional `defaultProfile`; drop owner-plan guidance.

### New / updated tests

16. **`test/bootstrap.test.ts`** (or shell-driven under `test/`) — clean re-run
    idempotent; dirty install root refuses; `--no-path` skips wrapper; missing
    Node/pnpm message (stubbed PATH). Prefer isolating in a temp HOME /
    `COORD_INSTALL_ROOT`.
17. **`test/onboard.test.ts`** — no-extra-flags onboard: empty product
    `git status`, flat `config.json`, doctor exit 0, registry written.
18. **`test/workspaceLayout.test.ts`** — flat preferred; nested still resolves;
    new write under existing multi-product runtime stays nested.
19. **`test/githubIssue.test.ts`** — snapshot encoding stability; missing issue
    fails with remediation.
20. **`test/cli.test.ts`** — extend: digest from materialised issue without
    pre-existing plan.md; `coord N` resolves via registry and invokes start+run
    seams; `start --product` omits long paths.
21. **`test/install.test.ts`** / **`test/doctor.test.ts`** — compat with nested
    `workspaces/<project>/config.json`; uninstall/doctor against flat.
22. **`test/support/workspaceFixture.ts`** — helpers for flat vs nested fixtures
    and fake `gh` / issue fetch injection.

## Implementation sketch (ordered)

1. **Layout helpers + tests** — no CLI behaviour change yet; install still
   writes nested until step 3 flips the default write target.
2. **GitHub issue snapshot + digest default** — start materialises snapshot;
   change default `digestPaths`; update cli/doctor/docs examples; tests prove
   no pre-start plan.md.
3. **Product registry + start/`coord N` resolution** — persist profile; allow
   omitted `--config`/`--coord-root`/`--profile` when resolved.
4. **`coord onboard`** — defaults → install → registry → doctor (non-zero on
   doctor failure); keep `install` for advanced flags.
5. **`scripts/bootstrap.sh` + PATH wrapper** — idempotent install-root bootstrap;
   mark `ownsInstallRoot` when this path created the clone (uninstall
   `--delete-coordination` remains gated on that bit).
6. **Docs / help / examples** — README happy path; advanced section for nested
   multi-product and explicit install flags.
7. **Acceptance sweep (R8)** — bootstrap dirty/clean; onboard flat+doctor;
   issue-seeded digest; human clone still hook-free; nested compat.

## Additional simplifications

These keep the change set smaller without weakening R1–R8:

1. **Onboard = install + doctor + registry.** No parallel installer, no second
   stamp schema, no duplicate clone loop.
2. **One layout resolver.** Every command that today hard-codes
   `workspaces/<project>/config.json` goes through it — avoid “install flat,
   doctor nested” skew.
3. **Reuse `automationDigestMaterial`.** Materialise the issue file first, then
   hash; do not invent a second digest scheme or special-case “virtual” sources
   inside the hasher.
4. **Registry under install root, not product.** Satisfies the pointer
   requirement and the zero-footprint rule with one file format.
5. **Persist `defaultProfile` once.** Avoids re-typing `--profile consensus` on
   every `coord N` without making profile a required start flag forever.
6. **Numeric argv dispatch only.** `coord 42` is sugar for resolve→start→run;
   do not add a separate orchestration module or daemon.
7. **Do not auto-migrate nested → flat.** Compat resolve-both is enough; owners
   who want flat can re-onboard or move the file deliberately. Avoids risky
   rewrite of in-flight runtimes.
8. **Keep `digestPaths` for optional extras.** Prefer changing the default path
   over deleting the field; advanced operators can still pin extra agreed
   inputs.
9. **Inject issue fetch in tests.** Same pattern as `processRunner` /
   `makeRunLoop` — no live GitHub in unit tests; one optional e2e later if
   desired.
10. **Bootstrap does not call onboard.** Issue non-goal: install root ≠ product
    wiring. Keeps `curl | sh` safe and reviewable.

## Alternatives rejected

1. **Require owner `plan.md` under coord-root as the work statement.** Rejected:
   that is today’s ceremony; the GitHub issue is the work statement.
2. **Put the product→runtime pointer in the product tree.** Rejected: dirties
   master / breaks empty `git status` by default.
3. **PATH-only binary without install root.** Rejected: hooks need
   `githooks/**` + built CLI via `coord.installRoot`.
4. **Delete `coord install`.** Rejected: advanced flags (`--declare`, `--vendor`,
   `--write-product`, custom clone-root) stay as escapes.
5. **Force-migrate all runtimes to flat.** Rejected: resolve-both is safer for
   in-flight issues.
6. **Digest only the live GitHub API response without materialising.** Rejected:
   need a durable snapshot under coord-root for hashing/replay and for agents to
   cite the same bytes the digest named.
7. **Replace agent branch `plan.md` with the owner issue snapshot.** Rejected:
   R2 plans remain agent-authored protocol evidence; the issue snapshot is only
   the start-time work statement.

## Risks and mitigations

- **`gh` missing or unauthenticated.** Fail start with install/auth remediation;
  do not fall back to an empty or owner-typed plan.
- **Issue edited after start.** Digest is start-time; mid-run edits do not
  rewrite `start.json`. Document that deliberately.
- **Registry stale after manual coord-root move.** Doctor / start stamp
  cross-check `productRoot`; re-onboard repairs. Remediations name `coord
  onboard` / `coord install`.
- **Flat vs nested ambiguity** (both `config.json` and
  `workspaces/<project>/config.json`). Prefer flat when present; doctor warns if
  both exist for the same project.
- **Bootstrap dirty refuse.** Leave working tree untouched; print status hint —
  never reset.
- **`coord N` from unrelated cwd.** Require `--product` or a registry hit;
  never guess a random runtime.
- **Multi-product wipe.** Existing uninstall refusal when other workspaces exist
  remains; flat single-product wipe deletes the top-level config only for that
  product.

## Acceptance criteria (from R8)

- [ ] Bootstrap: clean re-run is a no-op success; dirty install root refuses
      without mutating.
- [ ] `coord onboard <product>` with no extra flags: product `git status` empty;
      `<coord-root>/config.json` flat; doctor runs and failure fails onboard.
- [ ] `coord N` (or start+run) with fixture issue number seeds digest from issue
      content **without** a pre-existing owner `plan.md`.
- [ ] Fresh human product clone still has no coordination hooks after onboard.
- [ ] Existing `<coord-root>/workspaces/<project>/config.json` still resolves for
      doctor / start / uninstall.
- [ ] README / help happy path matches bootstrap → onboard → issue → `coord N`.

## Validation

```sh
nvm use 26
pnpm install --frozen-lockfile
pnpm check:fast
# after bootstrap/onboard paths land:
pnpm check
```

Do not commit on `main`. Branch: `issue-6/cursor`. Commit prefix: `Cursor: `.

## Conclusion

Issue 6 is an operator-flow simplification on the issue-4 install surface: one
machine bootstrap, one-command product onboard with flat runtime config, digest
bound to the GitHub issue the owner already created, and `coord N` as the daily
start+run entry — while agents continue to publish plans on their issue
branches and the product master stays coordination-free by default.

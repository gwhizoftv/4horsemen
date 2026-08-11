# Code review: Codex implementation for issue 4

- Reviewed head: `origin/issue-4/codex` @ `809fe09`
- Baseline: `origin/main` @ `a673383`
- Scope: `git diff a673383...809fe09` — installable deploy, Option C shims, declared
  `verify`, doctor/uninstall
- Reviewer: Claude

## Verdict

The install shape is right and materially stronger than the alternatives on the
points that matter most: shims are generated per clone and byte-compared by
`doctor`, pre-existing agent-clone hooks are backed up to `<hook>.coord-original`
and chained rather than clobbered, workspace configs are namespaced per product
digest, declared-argv PATH validation runs *before* any clone is created, and the
emitted config is proven to survive `coord start` by a test.

The defects below are concentrated in two places: (a) install turns *every*
undeclared policy field into an explicit empty opt-out, so the default install
produces a workspace with no gate in either tier; and (b) the opt-in
`--write-product` path is not reversible.

## Findings

### 1. `src/setupWorkspace.ts:288`

**Rule.** Absence of a top-level `verify` must stay distinguishable from an
explicit empty `verify`. Only an operator writing `{"precommit": [], "prepush": []}`
may disarm agent-clone gating; install must never synthesize that value on the
operator's behalf.

**Failure.** `verify: policy?.verify ?? { precommit: [], prepush: [] }` writes an
explicit empty declaration whenever no `--config` is supplied — which is the
documented default in `README.md` and `docs/setup-workspace.md`. `githooks/lib/verify.mjs:336-337`
then reads `verify.precommit` as a present-but-empty array and `runCommands`
iterates nothing, so every agent commit and push in the new workspace runs zero
product checks and silently reports success. The `loadPolicy` "no verify
declaration" remediation at `githooks/lib/verify.mjs:334` is unreachable through
`coord install`, so the acceptance criterion *"missing `verify` on an agent-wired
clone blocks with fix text"* cannot be satisfied by an installed workspace. The
branch's own test at `test/install.test.ts:2236` codifies the defect
(`expect(readConfig(first.configPath).verify).toEqual({ precommit: [], prepush: [] })`).

**Test.**

```ts
it("leaves verify undeclared when no policy supplies it", () => {
  const value = fixture();
  const result = install(value);                       // no configSource
  const raw = JSON.parse(readFileSync(result.configPath, "utf8"));
  expect("verify" in raw).toBe(false);
  const commit = spawnSync(join(result.cloneRoots[0], ".git/hooks/pre-commit"), { cwd: result.cloneRoots[0], encoding: "utf8" });
  expect(commit.status).toBe(1);
  expect(commit.stderr).toContain("no verify declaration");
});
```

---

### 2. `src/setupWorkspace.ts:287` and `:291`, enabled by `src/state.ts:130` and `src/state.ts:188`

**Rule.** Relaxing a schema minimum is only safe if some other layer still forces
the operator to make the decision the minimum used to force. Tier-3 finalization
`checks` and the automation `digestPaths` are gates; an installed workspace must
not be able to reach `R7.finalize` with both of them empty and no diagnostic.

**Failure.** `checks: z.array(checkCommandSchema)` and the `digestPaths` `.min(1)`
were both dropped, and install fills the fields with `policy?.checks ?? []` /
`policy?.digestPaths ?? []`. A default install therefore emits `checks: []`, and
`src/runLoop.ts:593` (`for (const check of start.checks)`) iterates zero times, so
`R7.finalize` materializes the clean worktree, runs nothing, and accepts the pin —
tier 3 is vacuous, and `doctor` reports the workspace healthy because
`missingDeclaredCommands` also has nothing to check. Concretely: install a Go
product with defaults, drive a run to R7, and coordination opens/authorizes a PR
for a tree that never had `go build` run against it. The same install emits
`digestPaths: []`, so `automationDigestMaterial` (`src/cli.ts:137`) hashes only the
config bytes and the plan document is no longer bound into the digest that
identifies the run.

**Fix sketch.** Keep `checks` non-empty in the schema and make install refuse to
emit a workspace with no tier-3 checks unless the operator declares
`"checks": []` explicitly — the same missing-vs-empty rule finding 1 asks for on
`verify`. If `digestPaths` may legitimately be empty, say so in
`docs/coord-driver.md` next to the field.

---

### 3. `src/uninstall.ts:92-95`

**Rule.** Uninstall must reverse everything install wrote, or refuse and say what
it is leaving behind. The install stamp records `writeProduct`, so uninstall has
the information it needs; a "conservative default" must not mean "abandons files
in the product's tracked tree".

**Failure.** `installProductFiles` (`src/setupWorkspace.ts:245-259`) creates
`<product>/AGENTS.md` when absent and, with `--vendor`, copies all five hook
bodies plus `githooks/lib/identity.sh`, `githooks/lib/verify.mjs` and
`githooks/.coord-vendor-stamp.json` into the product worktree. `uninstallWorkspace`
removes only the managed `.gitignore` block. After
`coord install --write-product --vendor` followed by `coord uninstall`, the
product's `git status` still shows an untracked `githooks/` tree — and
`templates/product/gitignore.coordination.block` does not ignore `githooks/`, so it
stays visible forever. The next maintainer running `git add -A` commits
coordination's identity-mandatory hook bodies onto the product default branch,
which is exactly the "loaded gun" the issue's §2a forbids. The branch's own test
(`test/install.test.ts:2401`) asserts those files exist after install and never
re-checks them after uninstall.

**Test.**

```ts
it("removes opt-in product writes it made", () => {
  const value = fixture();
  const result = install(value, { writeProduct: true, vendor: true });
  uninstallWorkspace({ product: value.product, coordRoot: value.coordRoot, configPath: result.configPath });
  expect(git(value.product, ["status", "--porcelain"])).toBe("");
});
```

---

### 4. `templates/hooks/shim.sh:38-40`

**Rule.** A hook that spools data through the filesystem must create its temporary
file at a name an attacker cannot predict, and must create it in a way that fails
if the name already exists. `umask` restricts the mode of a *newly created* file;
it does not stop a redirect from following a pre-existing symlink.

**Failure.** `input="${TMPDIR:-/tmp}/coord-pre-push.$$.input"` is fully predictable
(agent PIDs are small and observable), and `cat > "$input"` follows symlinks. On any
host where `TMPDIR` is unset and `/tmp` is shared — Linux CI runners, containers with
several service accounts — a local attacker who pre-creates
`/tmp/coord-pre-push.<pid>.input` as a symlink causes the agent's `git push` to
truncate and overwrite the link target with the ref list, as the agent user. The
`trap 'rm -f "$input"' EXIT` is also registered *after* `cat`, so an interrupted
push leaks the file.

**Fix sketch.** `input="$(mktemp "${TMPDIR:-/tmp}/coord-pre-push.XXXXXX")"` and
register the `trap` before writing.

---

### 5. `src/setupWorkspace.ts:219` and `src/setupWorkspace.ts:259`

**Rule.** The shared branch of a workspace is repository policy, not a property of
whatever the owner's shell happened to have checked out when they ran the
installer. It must come from the remote's default branch, an explicit flag, or a
declared config — never from transient local state.

**Failure.** `const currentBranch = git(productRoot, ["branch", "--show-current"]) || "main"`
becomes `baseBranch` whenever neither `--base-branch` nor a policy config supplies
one. An owner who runs the documented install command while their product clone
sits on `feature/login` — the normal state of a working clone — gets
`baseBranch: "feature/login"` persisted in the workspace config,
`consensus.sharedBranch=feature/login` in every agent clone, and
`git clone --branch feature/login` for each agent (`src/setupWorkspace.ts:170`).
The run then bases every agent branch on a feature branch and the eventual PR
targets it. The `|| "main"` fallback has the mirror-image failure: from a detached
HEAD on a `master`-default product, install records a `main` that does not exist and
`coord start` cannot resolve `origin/main`.

**Test.**

```ts
it("does not adopt the product's currently checked-out branch as baseBranch", () => {
  const value = fixture();
  git(value.product, ["checkout", "-b", "feature/x"]);
  expect(install(value).config.baseBranch).toBe("main");
});
```

---

### 6. `src/doctor.ts:82`, `:124`, `:146`

**Rule.** `doctor` must diagnose the mode the workspace is actually in. Vendor mode
is documented (`docs/setup-workspace.md`: *"copies the canonical bodies into the
agent hook directories for offline use; it never falls back between the install root
and the copy"*) as not requiring the install root at hook time, so vendor-mode health
must not be defined in terms of the install root's presence.

**Failure.** All three checks are unconditional on `hookMode`. With
`hookMode === "vendor"` and the coordination checkout moved or unmounted — the
offline case vendor mode exists for, and the case
`test/install.test.ts:2381` deliberately exercises by unsetting `coord.installRoot`
— `doctor` reports `MISSING_INSTALL_ROOT` (line 82, `!existsSync(stamp.installRoot)`),
`BAD_HOOKS` for every agent (line 124, `hooksGood` short-circuits on the same
`existsSync`), and `STALE_VENDOR` (line 146, `currentDigest` is `null` so
`vendor.hookDigest !== currentDigest` always holds). `coord doctor` exits 3 for a
workspace whose hooks all run correctly, and the operator has no way to tell the
false alarm from a real one because the codes are the same.

**Fix sketch.** Branch on `stamp.hookMode`: in vendor mode, verify the copied bodies
against the recorded `stamp.json` digest and treat a missing install root as
informational; in shim mode keep the current strictness.

## Also noted (not findings)

- `githooks/pre-commit` / `pre-push` now `exec node`, so an agent clone whose hook
  environment lacks `node` on `PATH` (GUI Git clients, nvm not sourced) blocks with
  `node: command not found` rather than a coordination remediation. Fail-closed, but
  worth a `command -v node` guard with the standard `HOOK BLOCKED:` text.
- `parseArgs` (`src/cli.ts:80`) now treats `force`, `dry-run` etc. as boolean for
  *every* command. No current command uses those names, so this is latent only.
- `executableOnPath` resolves a relative `argv[0]` containing `/` against the
  *product* root at install time, but hooks execute it from the *agent clone*.
  Same-tree today; would diverge if `--clone-root` ever pointed elsewhere.

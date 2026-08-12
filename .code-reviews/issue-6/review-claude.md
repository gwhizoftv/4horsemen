# Code review: issue 6 bootstrap/onboard simplification

- Reviewed head: `issue-6/claude` @ `a98b1c2`
- Baseline: `main` @ `f9d0084`
- Scope: `git diff main...HEAD` — `scripts/bootstrap.sh`, `coord onboard`, `coord <n>`,
  the flat/nested workspace locator, the GitHub-issue work statement
- Reviewer: Claude

## Verdict

The shape is right: one module owns the flat-vs-nested decision, the start
transaction is extracted rather than duplicated, the issue fetch is ordered
before the first effect, and the canonical snapshot is written with the exact
bytes that were hashed.

The defects below cluster in three places: (a) the new owner locator is written
to one clone but documented as resolving from several, and it is cleared during
a `--dry-run`; (b) `bootstrap.sh` writes through a symlinked launcher and never
checks out `--ref`; (c) the layout selector can relocate a workspace that
already holds in-flight run state.

## Findings

### 1. `src/install.ts:546`

**Rule.** A `--dry-run` performs no effect. Every other mutation in `uninstall`
is guarded by `if (!options.dryRun)` before it runs, and the log line only then
chooses between "would …" and "…ed".

**Failure.** `clearOwnerLocator` is called *inside the `if` condition*:

```ts
if (stamp !== undefined && clearOwnerLocator(stamp.productRoot, configPath)) {
  effects.log(`${options.dryRun ? "would clear" : "cleared"} the owner locator …`);
}
```

`clearOwnerLocator` (`src/workspace.ts:167-174`) runs
`git config --local --unset-all coord.ownerWorkspaceConfig` unconditionally. So
`coord uninstall --product /x/app --coord-root /x/coord-runtime --dry-run`
prints "would clear the owner locator" while actually clearing it. Nothing else
in that run is reverted, so afterwards the workspace is still fully installed
but `coord 42` inside `/x/app` fails with
"`/x/app` has not been onboarded, so coord does not know its runtime." The
operator's next move is `coord onboard`, which re-runs the whole installer as
the repair for a command that promised to change nothing.

**Test.**

```ts
it("does not clear the owner locator on a dry run", () => {
  const fixture = product();
  onboardOnce(fixture);
  uninstall({ coordRoot: fixture.coordRoot, productRoot: fixture.productRoot,
    deleteClones: false, wipeRuntime: false, deleteCoordination: false,
    force: false, dryRun: true, log: silence().log });
  expect(localConfigGet(fixture.productRoot, OWNER_LOCATOR_KEY)).not.toBeNull();
});
```

---

### 2. `src/install.ts:377`

**Rule.** Every directory the CLI documents as a valid cwd for flag-free
resolution must actually carry `coord.ownerWorkspaceConfig`, because
`resolveWorkspaceFromDirectory` (`src/workspace.ts:189-197`) reads that key and
nothing else.

**Failure.** Step 6b writes the locator only into `productRoot`, and
`test/onboard.test.ts:111` asserts that agent clones deliberately do *not* carry
it. But `src/cli.ts:186` heads the owner controls with
"(`--product`, or run from the product / an agent clone)", and
`docs/setup-workspace.md` states "That is what lets `coord 42` work with no
flags from the product **or any of its agent clones**."

The concrete break is the one command that exists for agents. `README.md`
documents `COORD_AGENT=codex coord next --issue 42`; `next` no longer requires
`--coord-root` (`src/cli.ts:730`), so from `/x/app-codex` it calls
`context()` → `resolveWorkspaceLocation` → `resolveWorkspaceFromDirectory`,
which returns `{ kind: "not-onboarded", productRoot: "/x/app-codex" }` and
throws:

> `/x/app-codex` has not been onboarded, so coord does not know its runtime.
>   Fix: coord onboard /x/app-codex

An agent that follows that remediation onboards its own clone as a second
product: a new `coord-runtime` beside it, four clones-of-a-clone, and a second
workspace, none of which is the run it was participating in.

**Fix sketch.** Either resolve through the agent-clone key as a fallback —
`localConfigGet(root, WORKSPACE_CONFIG_KEY)` already holds the same absolute
config path and is written to every agent clone — or delete the "or an agent
clone" claim from `src/cli.ts:186`, `docs/setup-workspace.md`, and keep
`--coord-root` mandatory for `next`. The fallback is preferable; it costs one
branch in `resolveWorkspaceFromDirectory` and does not add a fourth key to a
product clone.

---

### 3. `scripts/bootstrap.sh:109`

**Rule.** The guard that refuses to overwrite a `~/.local/bin/coord` bootstrap
did not create must cover symlinks, because `cat > "$launcher"` follows a
symlink and truncates its *target*.

**Failure.**

```sh
if [ -e "$launcher" ] && [ ! -L "$launcher" ] && ! grep -q 'coord bootstrap-managed' "$launcher" 2>/dev/null; then
  die "…already exists and was not installed by bootstrap…"
fi
…
cat > "$launcher" <<EOF
```

The `[ ! -L "$launcher" ]` term makes the guard *skip* exactly the case it
should catch. `docs/setup-workspace.md` tells developers "just run `./coord`
from that checkout", and the common way to do that globally is
`ln -s ~/repos/coordination/coord ~/.local/bin/coord`. Piping the documented
`curl … | sh` on that machine rewrites the tracked file
`~/repos/coordination/coord` with the generated wrapper. Two consequences
follow: the developer checkout is now dirty, so bootstrap's own update path
(`scripts/bootstrap.sh:87`) refuses to ever update that root again; and `./coord`
in the checkout stops rebuilding stale sources, which is the behaviour the
comment at `scripts/bootstrap.sh:111` says it is preserving.

A dangling symlink is worse: `[ -e "$launcher" ]` is false for it, so the guard
is skipped and `cat >` creates the wrapper at whatever path the dangling link
names — arbitrary, outside `$BIN_DIR`.

**Fix sketch.**

```sh
if { [ -e "$launcher" ] || [ -L "$launcher" ]; } &&
   { [ -L "$launcher" ] || ! grep -q 'coord bootstrap-managed' "$launcher" 2>/dev/null; }; then
  die "$launcher already exists and was not installed by bootstrap. Remove it, or re-run with --no-path." 6
fi
rm -f "$launcher"
cat > "$launcher" <<EOF
```

---

### 4. `scripts/bootstrap.sh:92`

**Rule.** `--ref <branch>` names the branch the install root tracks, so an
update leaves the root checked out on that branch.

**Failure.** The update path fetches `$ref` and then merges `FETCH_HEAD` into
whatever branch happens to be checked out; it never runs `checkout`. The header
comment and `docs/setup-workspace.md` both stress that the install root "is
frequently somebody's working checkout of this repository", so the checked-out
branch is routinely not `main`. A developer sitting on a freshly created
`issue-7/claude` with no commits yet re-runs the documented `curl … | sh` to
upgrade: `git merge --ff-only FETCH_HEAD` fast-forwards `issue-7/claude` to
`origin/main`'s tip, so their issue branch silently now points at main and
`git log` on it shows commits they never made. If the branch does have local
commits, bootstrap instead dies with "`$root` has diverged from origin/main" —
a false statement about a branch that was never supposed to track main.

**Fix sketch.** After the clean-tree check, require the intended branch before
merging:

```sh
current="$(git -C "$root" symbolic-ref --quiet --short HEAD || echo '')"
[ "$current" = "$ref" ] ||
  die "$root is on '$current', not '$ref'. Check out $ref yourself, or pass --ref $current." 4
```

---

### 5. `src/cli.ts:141`

**Rule.** The runtime root is named explicitly. The help this PR replaces said
so in as many words: "The safety-critical `--coord-root` option must always be
explicit", and `start` enforced it with `requireFlag(parsed, "coord-root")`.

**Failure.** `resolveWorkspaceLocation` now accepts `--config` with no
`--coord-root` and hands the config's own directory to `workspaceFromConfigPath`
(`src/workspace.ts:127-142`), which returns
`{ coordRoot: dir, workspaceRoot: dir, layout: "flat" }` whenever `dir`'s parent
is not literally named `workspaces`. The pre-PR documented invocation was
`./coord start 42 --config ./config.json --coord-root <external>` run from a
checkout; drop the second flag — which the new help no longer marks as
mandatory — and `coord start 42 --config ./config.json` creates `./mirror.git`
and `./issue-42/` inside that checkout. `resolveSafeCoordRoot`
(`src/cli.ts:412`) does not catch it: it only rejects a root that overlaps a
*configured agent clone root*, and the checkout the operator is standing in is
not one of those. The result is a bare mirror and live run state committed-
adjacent inside a git repository, which then reports dirty and — if that repo is
the install root — is permanently unupdatable by `bootstrap.sh` (finding 3's
same refusal at `scripts/bootstrap.sh:87`).

**Fix sketch.** Keep `--coord-root` required whenever `--config` is used, or
refuse a resolved `workspaceRoot` that is inside a git worktree.

---

### 6. `src/workspace.ts:107`

**Rule.** `selectWorkspaceForInstall`'s own contract: "An already-installed
workspace is returned unchanged — reinstalling to repair a hook must never
relocate a runtime out from under in-flight issue state."

**Failure.** The "already installed" test runs through
`resolveInstalledWorkspace` without `acceptUnreadableFlat`, so it depends on
`configProject` (`src/workspace.ts:61-68`) being able to `JSON.parse` the flat
config and read a non-empty `project` string. If that read fails, the flat
config is treated as belonging to nobody: `resolveInstalledWorkspace` returns
`null`, the flat slot is seen as occupied, and install writes
`<coord-root>/workspaces/<project>/config.json` instead.

Concretely: `/x/coord-runtime/config.json` is the flat workspace for `app`, with
`/x/coord-runtime/issue-42/` and `/x/coord-runtime/mirror.git` in flight. The
config is hand-edited and left with a trailing comma. `install.ts:248` already
anticipates this — "A config that no longer parses … must not stop the
installer that exists to rewrite it; regenerating is the repair" — so the
operator re-runs `coord onboard /x/app`. It succeeds, but the workspace is now
nested. `coord 42` resolves `workspaceRoot = /x/coord-runtime/workspaces/app`,
finds no `issue-42/`, and starts a brand-new session against the same origin
while the original run's cursors, journal, and mirror sit unreachable one
directory up. Two coordinators can then be driving issue 42.

**Test.**

```ts
it("does not relocate an installed workspace when its flat config is unparseable", () => {
  const fixture = product();
  const first = onboardOnce(fixture);
  expect(first.location.layout).toBe("flat");
  writeFileSync(first.configPath, "{ not json");
  expect(onboardOnce(fixture).location.workspaceRoot).toBe(first.location.workspaceRoot);
});
```

**Fix sketch.** When the flat config exists but is unreadable, refuse rather
than silently nesting: an unreadable config either belongs to this project (and
must be rewritten in place) or to another (and the operator must say which).

---

### 7. `src/workspace.ts:48`

**Rule.** Every component of a derived runtime path is proven not to be a
symlink before state is written there. `resolveSafeCoordRoot` asserts it for
the coord-root (`src/paths.ts:85`); `createIssueRuntime` asserts it from
`paths.coordRoot` downward (`src/paths.ts:163-171`).

**Failure.** For a nested workspace, `paths.coordRoot` is the *workspace* root,
so `createIssueRuntime`'s assertions start at
`<coord-root>/workspaces/<project>` and never look at the `workspaces`
component; `resolveSafeCoordRoot`'s assertion stops at `<coord-root>`. Nothing
checks `<coord-root>/workspaces`. Replace that directory with a symlink into an
agent clone — e.g. `ln -s /x/app-codex/.runtime /x/coord-runtime/workspaces` —
and `coord start 42 --coord-root /x/coord-runtime --product /x/app` passes the
agent-overlap check (which realpaths only `/x/coord-runtime`) and then writes
`start.json`, `cursors.json`, `journal.jsonl`, and the bare `mirror.git` inside
a clone an agent has write access to. That is precisely the containment the
coord-root check exists to guarantee.

**Fix sketch.** In `nestedWorkspace`, after `containedPath`, call
`assertNoSymlink(root, workspaceRoot)` — it walks every component from the
coord-root down and is the same helper the flat path already relies on.

---

### 8. `src/cli.ts:749`

**Rule.** A flag the help advertises for a command is in that command's
`allowedFlags` list; `allowedFlags` is a hard reject, not a warning.

**Failure.** `src/cli.ts:186` introduces the owner controls with
"Owner controls (`--product`, or run from the product / an agent clone)" and
then lists `coord answer`, `coord drop`, and `coord pause|resume|
restart-action|abandon` under that heading. None of those five call sites allow
`product`: `answer` at `src/cli.ts:749`, `drop` at `818`, `pause`/`resume` at
`843`, `restart-action` at `857`, `abandon` at `881` all pass
`["issue", "coord-root"]`. `coord drop codex --issue 42 --product /x/app`
throws "Unsupported option --product." The operator's only recourse is `cd`,
which is exactly what `--product` was added to avoid — and the four commands
that *do* accept it (`start`, `run`, `next`, and the bare `coord <n>`) make the
inconsistency look like a typo in their own invocation.

**Test.**

```ts
it("accepts --product on the owner controls the help advertises", async () => {
  for (const argv of [["pause"], ["resume"], ["abandon"], ["drop", "codex"]]) {
    await expect(runCli([...argv, "--issue", "42", "--product", productRoot], deps))
      .resolves.not.toThrow();
  }
});
```

---

### 9. `src/install.ts:568`

**Rule.** A guard that refuses an operation runs before any irreversible effect
of that operation. (Ordering predates this PR, but the block is rewritten here
and the new flat layout makes the guard fire on the common runtime.)

**Failure.** `uninstall` clears the owner locator (546), deletes the workspace
config (551), and only then evaluates the `--wipe-runtime` safety check and
throws "Refusing --wipe-runtime: … Re-run with --force to wipe the whole runtime
anyway." With the new layout, product one is flat at `<R>/config.json` and
product two is nested at `<R>/workspaces/two/`, so `others` is non-empty for
product one and the guard fires on a two-product runtime — the layout onboard
produces by default. The re-run the message prescribes cannot work: the config
it needs is gone, so `resolveInstalledWorkspace` returns `null` and uninstall
exits with "No installed workspace for 'one' under `<R>`. Nothing to
uninstall." `<R>/issue-*` and `<R>/mirror.git` are stranded with no command that
can remove them, and the clones are already unwired.

**Fix sketch.** Hoist the `others` computation and its `throw` above the
`clearOwnerLocator` / `rmSync(configPath)` block, alongside the other
preflights.

---

### 10. `src/cli.ts:149`

**Rule.** A mistyped path produces a diagnosis, not a spawn error. `onboard`
already does this (`src/install.ts:644`: "No such product directory: …").

**Failure.** `resolveWorkspaceLocation` passes `--product` straight to
`resolveWorkspaceFromDirectory` → `worktreeRoot(directory)` → `git(directory, …)`,
which is `spawnSync` with a non-existent `cwd`. `src/gitExec.ts:20` turns
`result.error` into a throw, so `coord 42 --product /x/ap` (one character short)
reports:

> Cannot run git rev-parse --show-toplevel in /x/ap: spawnSync git ENOENT

which names `git` as the missing thing. The same message appears from
`coord doctor --product /x/ap` (`src/cli.ts:661`), where the pre-PR path gave
"No installed workspace for 'ap' at …".

**Fix sketch.** In `resolveWorkspaceFromDirectory`, return
`{ kind: "not-a-worktree", path }` when `existsSync(directory)` is false;
`describeLocatorFailure` already renders that case usefully.

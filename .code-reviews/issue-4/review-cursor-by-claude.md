# Code review: Cursor implementation for issue 4

- Reviewed head: `origin/issue-4/cursor` @ `f0aa7fd`
- Baseline: `origin/main` @ `a673383`
- Scope: `git diff a673383...f0aa7fd` — installable deploy, Option C shims, declared
  `verify`, doctor/uninstall
- Reviewer: Claude
- Note: the branch carries its own `.code-reviews/issue-4/review-cursor.md`. Its five
  findings are all still present in `f0aa7fd`; only finding 1 is repeated below
  (finding 5 of this review), because it is the branch's one fail-open.

## Verdict

The two-mode placement is correct — shims land in agent `.git/hooks/`, the product
worktree is untouched by default, `core.hooksPath` is deliberately unset, and the
human-clone acceptance test is real. But the *emitted workspace config* is wrong in
three independent ways, and the two of them that fire on the documented default
install make the workspace unusable rather than merely ungated: `coord start`
rejects the config, and a non-Node product gets pnpm commands wired into its agent
hooks. Hook wiring is also destructive: it overwrites and then deletes hooks it did
not write.

## Findings

### 1. `src/setupWorkspace.ts:157` and `:245`, with `config.product.example.json:223`

**Rule.** `digestPaths` entries are resolved relative to the directory holding the
workspace config (`src/cli.ts:133-145`: `configRoot = dirname(configPath)`, then
`containedPath(configRoot, path)`), and a missing digest source is a hard error. An
emitted config must therefore only name digest paths that exist relative to
`--coord-root`. The acceptance criterion is *"emitted config accepted by `coord start`
unchanged"*.

**Failure.** `loadTemplate` parses `config.product.example.json`, which declares
`"digestPaths": [".plans/issue-{issue}/plan.md"]`, and `setupWorkspace` spreads
`...template` into the emitted config without rewriting the field. The config is
written to `join(coordRoot, "config.json")` (`:256`), so `automationDigestMaterial`
resolves the entry to `<coord-root>/.plans/issue-4/plan.md`, which install never
creates. Running the exact next-step command that `runInstall` prints
(`src/install.ts:1593`) fails at `src/cli.ts:316` with
`Digest source .plans/issue-4/plan.md for issue 4 is missing at <coord-root>/.plans/issue-4/plan.md`.
`test/install.test.ts` never invokes `coord start`, so nothing catches it.

**Test.**

```ts
it("emits a config that coord start accepts unchanged", async () => {
  // install as in the existing test, then:
  const code = await runCli(
    ["start", "4", "--profile", "solo", "--config", join(runtime, "config.json"), "--coord-root", runtime],
    { io: { cwd: root }, /* stub processRunner / startEffects / makeRunLoop */ }
  );
  expect(code).toBe(0);
});
```

---

### 2. `src/setupWorkspace.ts:157`

**Rule.** Goal 3 of the issue: agent `verify` and finalization `checks` are
*product-declared* argv. When the operator declares nothing, install must fail
closed with "declare your commands", not silently substitute another project's
toolchain.

**Failure.** `loadTemplate(undefined)` falls back to
`join(packageRoot, "config.product.example.json")`, and that file declares
`verify.precommit = pnpm check:fast`, `verify.prepush = pnpm test:e2e`, and
`checks = [pnpm install --frozen-lockfile, pnpm check]` — coordination's *own*
toolchain. `--config` is optional in the CLI (`src/cli.ts:1067`,
`configTemplate: parsed.flags.get("config")`). So
`coord install --product /path/to/go-service --coord-root … --agents cursor` emits a
Go workspace whose agent pre-commit runs `pnpm check:fast` in a tree with no
`package.json`: every agent commit is blocked. `runDoctorChecks(requirePathCommands)`
does not catch it, because `pnpm` *is* on the owner's PATH — the command exists, it is
simply the wrong project's. This is the exact ecosystem-sniffing failure the issue
asked to remove, relocated from the hook body into the default template.

**Fix sketch.** Drop the implicit default: require `--config`, or emit
`verify`/`checks` absent and let the agent-clone hooks fail closed with the
"declare verify" remediation until the operator fills them in. Rename
`config.product.example.json` to something that cannot be loaded implicitly.

---

### 3. `src/setupWorkspace.ts:256` (with `src/install.ts:142` and `:185`)

**Rule.** A coord-root is the owner's control plane, not a per-product directory —
`coord run`/`coord start` already namespace their state by issue inside it. Two
products installed against one coord-root must not collide, or install must refuse.

**Failure.** The workspace config path is the constant `join(coordRoot, "config.json")`,
and `setupWorkspace` writes it unconditionally (`:281`). Install product A, then
product B with the same `--coord-root`: B's config overwrites A's. A's agent clones
still carry `coord.workspaceConfig = <coordRoot>/config.json` in local git config, so
from that moment A's agents run **B's** `verify` argv and **B's**
`workflowCritical*` scoping against A's tree. `coord uninstall --coord-root <same>`
then reads B's config only, so A's clones keep their hooks, identity and launcher
forever with no config left to describe them. `coord doctor --coord-root <same>`
likewise reports on B while silently mis-describing A. Codex namespaces this file by
a product-path digest for exactly this reason.

**Test.**

```ts
it("keeps two products in one coord-root separate", async () => {
  await install(productA, runtime, ["cursor"]);
  const a = readFileSync(join(runtime, "config.json"), "utf8");
  await install(productB, runtime, ["cursor"]);
  // either a distinct path per product, or an explicit refusal
  expect(readFileSync(join(runtime, "config.json"), "utf8")).toBe(a);
});
```

---

### 4. `src/hookSync.ts:33-37` and `src/hookSync.ts:75-80`

**Rule.** From the issue: *"Additive merge applies … when chaining onto a product that
already has hooks in an agent clone — wrap/chain, never clobber."* An installer may
not destroy a file it did not create, and an uninstaller may not delete one.

**Failure.** `writeHookShims` does `writeFileSync(path, body, { mode: 0o755 })` for all
five hook names with no existence check and no backup. `clearAgentHooks` then
`unlinkSync`s all five whenever they exist, with no check that the body is a
coordination shim. Concretely: an owner reuses an existing `<product>-cursor` clone
that already has a `pre-commit` (husky, a product bootstrap script, a personal
lint hook). `coord install` overwrites it — the content is gone, no
`.coord-original`, no warning. `coord uninstall` then removes the shim, leaving the
clone with *no* pre-commit at all. The original is unrecoverable. `doctor`'s
"is not a coordination shim" check (`src/doctor.ts:1298`) can never fire, because
install has already guaranteed the file is a shim. Codex's `installHooks`
(`src/hookSync.ts:31-40` on `issue-4/codex`) renames to `<hook>.coord-original`,
chains it from the shim, and restores it on uninstall — that is the behaviour to
match.

**Test.**

```ts
it("preserves and restores a pre-existing agent-clone hook", () => {
  const original = "#!/bin/sh\necho product-hook\n";
  writeFileSync(join(clone, ".git/hooks/pre-commit"), original, { mode: 0o755 });
  writeHookShims(clone);
  expect(readFileSync(join(clone, ".git/hooks/pre-commit.coord-original"), "utf8")).toBe(original);
  clearAgentHooks(clone);
  expect(readFileSync(join(clone, ".git/hooks/pre-commit"), "utf8")).toBe(original);
});
```

---

### 5. `githooks/pre-push:21` (confirming the branch's own finding 1)

**Rule.** On an agent-wired clone a missing or unreadable `coord.workspaceConfig`
must fail closed for `pre-push`, i.e. exit non-zero. Printing `HOOK BLOCKED` while
exiting 0 is a fail-open.

**Failure.** `coord_load_workflow_critical workflow_critical_prefixes workflow_critical_files`
returns 1 when the path is unset (`githooks/lib/workspace-config.sh:95`), but
`pre-push` sets `set -uo pipefail` without `-e` (`:6`) and discards the return value.
Both arrays stay empty, so `is_workflow_critical` never matches, `run_verify` stays
`false`, `status` stays `0`, and the hook prints
`verify.prepush skipped — no workflow-critical paths among N changed file(s)` followed
by `pre-push checks passed` and `exit 0` (`:145`). Deleting `coord.workspaceConfig`
from an agent clone is enough to push arbitrary changes with no declared
verification. `pre-commit` was fixed for this in `df64e30` (it gained `set -euo pipefail`);
`pre-push` was not.

**Fix sketch.** `coord_load_workflow_critical … || exit 1`, and add the same guard
for every other unchecked helper return in this file.

---

### 6. `githooks/lib/workspace-config.sh:90-91`, with `githooks/pre-push:6` and `:26`

**Rule.** Hook bodies carry a `#!/usr/bin/env bash` shebang and must run under the
oldest bash they can plausibly be dispatched with. macOS still ships bash 3.2 at
`/bin/bash`, and Git hooks inherit whatever `PATH` the invoking process has — GUI
Git clients, `launchd`/cron jobs and `env -i` shells routinely resolve `bash` to the
system copy rather than Homebrew's.

**Failure.** `local -n prefixes_ref="$1"` is a bash 4.3 nameref, and
`"${workflow_critical_prefixes[@]}"` on an empty array is an unbound-variable error
under `set -u` before bash 4.4. Under bash 3.2 both fire, verified locally:

```
$ /bin/bash -c 'set -uo pipefail; f(){ local -n a="$1"; }; arr=(); f arr; echo "${arr[@]}"'
local: -n: invalid option
arr[@]: unbound variable          # exit 1
```

So every agent `git push` in such an environment aborts inside `is_workflow_critical`
with `workflow_critical_prefixes[@]: unbound variable` — fail-closed, but with an
error that names nothing an agent can act on, and with no path to fixing it short of
reinstalling bash. This is the first bash-4 dependency anywhere in `githooks/` or
`scripts/`; nothing else in the tree needs more than 3.2.

**Fix sketch.** Return the two lists on stdout (NUL- or newline-delimited) and read
them in the caller, or keep global array names by convention; and guard array
expansions as `"${arr[@]+"${arr[@]}"}"`.

---

### 7. `src/setupWorkspace.ts:187` and `:271`

**Rule.** Agent clones must be created from the same remote the coordinator pins
against, on the branch that remote actually treats as default. `coord start` resolves
the immutable baseline from `origin/<baseBranch>`, so a clone whose history predates
that baseline cannot participate.

**Failure.** Two independent problems in the same block. (a) `execFileSync("git", ["clone", productRoot, root])`
clones the owner's **local working clone**, then only rewrites the remote URL
afterwards — it never fetches `origin`. If the owner's product clone is behind the
remote (routine), every agent clone starts behind it too, and the baseline
`coord start` pins from `origin` is not present in any agent clone. (b)
`const sharedBranch = options.sharedBranch ?? "main"` hardcodes `main` regardless of
the product's actual default branch, and it is written to the config as
`baseBranch`, to every clone as `consensus.sharedBranch`, and into every launcher
banner. Onboard a `master`-default product without `--shared-branch` and
`coord start` cannot resolve `origin/main`, while the agent hooks' shared-branch
guard protects a branch that does not exist — commits directly on `master` are
rejected only incidentally, by the naming-scheme branch of the check.

**Test.**

```ts
it("clones from origin and adopts the remote default branch", () => {
  // product default branch renamed to `master`; origin has one commit the local product clone lacks
  const result = install(value);                 // no --shared-branch
  expect(result.config.baseBranch).toBe("master");
  expect(git(result.cloneRoots.cursor, ["rev-parse", "HEAD"])).toBe(originHeadSha);
});
```

---

### 8. `src/install.ts:173-176`

**Rule.** A destructive flag must be bounded by what the tool created. `--wipe-runtime`
is documented as removing *"issue/mirror state"*, and the coord-root is a directory the
owner chose and may share with other workspaces.

**Failure.** `rmSync(coordRoot, { recursive: true, force: true })` deletes the entire
`--coord-root` tree — the mirror, every issue's journal and cursors, any other
product's workspace config (see finding 3), and any unrelated file the owner keeps
there — with no containment check, no `resolveSafeCoordRoot` call, no dirty-state
guard, and no `--force` requirement, gated only by a `config.json` existing at the
top of it. `coord uninstall --coord-root ~ --wipe-runtime`, after an install that put
`config.json` there, removes the home directory. Codex's equivalent enumerates the
directory and deletes only `mirror.git` and `issue-<n>` entries, re-checking
`isPathInside` for each.

**Fix sketch.** Enumerate and delete only `mirror.git` and `/^issue-[0-9]+$/` entries,
each re-checked with `isPathInside(coordRoot, target)`; require `--force` to remove
anything else.

## Also noted (not findings)

- `runInstall` (`src/install.ts:104-110`) runs `runDoctorChecks` **after**
  `setupWorkspace` has already created clones, written hooks, set local git config and
  written the workspace config. Any doctor error — including the `missing-command`
  case the acceptance criteria want caught at install time — surfaces as a thrown
  error over a fully-wired workspace. Combined with finding 2 this is the likely
  first-run experience on a machine without pnpm.
- `--profile` is accepted and never validated or persisted; it only decorates the
  printed next-step command.
- `coord_run_verify_phase` runs each declared command with `stdio: "inherit"`, inside
  a `while read` loop fed by a process substitution, so a verify command that reads
  stdin consumes the remaining command list.
- The branch's own findings 2, 3, 4 and 5 are unchanged in `f0aa7fd` and still apply.

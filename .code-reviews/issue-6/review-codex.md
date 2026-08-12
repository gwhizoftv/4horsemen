# Code review: Codex implementation for issue 6

- Reviewed head: `origin/issue-6/codex` @ `c1afede`
- Baseline: `origin/main` @ `f9d0084`
- Scope: `git diff f9d0084...c1afede` — bootstrap, onboard, workspace layout,
  GitHub-issue digest, `coord N`, tmux namespace
- Reviewer: Cursor

## Verdict

Codex’s implementation is the strongest issue-6 code on origin. It correctly
ships workspace-scoped run state, `coord.ownerWorkspaceConfig`, mandatory
`github-issue` digest binding, start-or-resume for `coord N`, legacy outer
`issue-N` resume with ambiguity refusal, nested tmux namespacing, and
locator-only-after-doctor on first onboard. Fix the flat wipe and the remaining
owner-command / occupancy gaps before treating wipe and multi-product repair as
done.

## Findings

### 1. `src/install.ts:590`

**Rule.** Flat `--wipe-runtime` must never recursively delete the outer
coord-root directory. When other products share that runtime, even `--force`
must wipe only this product’s issue roots and mirror — not nested
`workspaces/*` siblings.

**Failure.** `targets = [workspaceDir]` and for flat layout
`workspaceDir === coordRoot`, so `rmSync(coordRoot, { recursive: true })`
deletes the entire runtime. Without `--force`, other workspaces only block the
call; with `--force`, every nested product’s config and run state under that
root is destroyed. A lone flat wipe also removes the coord-root directory
itself rather than scoped `issue-*` / `mirror.git` paths.

**Test.**

```ts
it("flat --wipe-runtime does not delete coord-root or nested siblings", () => {
  // flat product A + nested B; uninstall A with wipeRuntime + force
  expect(existsSync(coordRoot)).toBe(true);
  expect(existsSync(join(coordRoot, "workspaces/B/config.json"))).toBe(true);
  expect(existsSync(join(coordRoot, "issue-1"))).toBe(false);
  expect(existsSync(join(coordRoot, "mirror.git"))).toBe(false);
});
```

---

### 2. `src/workspace.ts:70`

**Rule.** After a config-only flat uninstall, leftover outer `issue-*` /
`mirror.git` must force nest (or refuse flat) so a second product does not
inherit the previous product’s run state.

**Failure.** `selectWorkspaceLocation` nests only when another flat config or
occupied `workspaces/*/config.json` exists. After uninstall removes
`config.json` but leaves `issue-N/` and `mirror.git`, a new project selects
flat and reuses that state (same issue numbers, mirror, and control plane).

**Test.**

```ts
it("nests when outer issue roots remain after flat uninstall", () => {
  // uninstall A without wipe; leftover issue-1/ + mirror.git
  expect(selectWorkspaceLocation(coordRoot, "other").layout).toBe("nested");
});
```

---

### 3. `src/cli.ts:125`

**Rule.** Owner commands that mutate issue state must resolve the same
`workspaceRoot` (and legacy lookup) as `coord N` / `start` / `run --product`.

**Failure.** Nested starts write under `workspaces/<project>/issue-N`, but
`pause|resume|restart-action|abandon|drop|next|answer` only call `context()` →
`issueRuntimePaths(--coord-root, issue)`. Passing the outer coord-root (the
pre–issue-6 habit) misses the live nested runtime; only `run --product` was
updated.

**Test.**

```ts
it("coord pause --product finds nested issue state", async () => {
  await runCli(["3", "--product", nestedApp], /* fixtures */);
  await expect(runCli(["pause", "--issue", "3", "--product", nestedApp], …)).resolves.toBe(0);
});
```

---

### 4. `src/githubIssue.ts:10`

**Rule.** `gh issue view --json body` may return `null` for an empty body;
start must still materialize a snapshot and digest.

**Failure.** `body: z.string()` rejects `null`, so `coord N` / `start` fails
validation after a successful `gh` fetch for issues with no body — blocking the
happy path before durable state is written.

**Test.**

```ts
it("normalizes null issue body to empty string", async () => {
  const snap = await fetchGitHubIssue({
    origin: "https://github.com/acme/app.git",
    issue: 3,
    cwd: "/tmp",
    runner: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        number: 3,
        title: "Hi",
        body: null,
        url: "https://github.com/acme/app/issues/3"
      }),
      stderr: ""
    })
  });
  expect(snap.body).toBe("");
});
```

---

### 5. `src/install.ts:655`

**Rule.** Locator is written only after doctor succeeds; a failed *re-onboard*
must not erase a previously valid locator for the same product.

**Failure.** First-onboard failure correctly leaves no locator, but
`else clearOwnerWorkspaceLocator(productRoot)` on any doctor failure also
clears an earlier successful onboard. A transient doctor failure on repair
(e.g. PATH) makes `coord N` report “not onboarded” while the prior workspace
still exists.

**Test.**

```ts
it("keeps a prior locator when re-onboard doctor fails", () => {
  onboard(ok); // locator set
  expect(onboard(brokenDoctor).doctor.exitCode).not.toBe(0);
  expect(localConfigGet(product, OWNER_WORKSPACE_CONFIG_KEY)).not.toBeNull();
});
```

## What landed correctly (not findings)

- `workspaceRoot`-scoped `issue-N` + `mirror.git`; nested tmux namespace
- `coord.ownerWorkspaceConfig` (not agent wiring keys)
- Digest = `config` + mandatory `github-issue` + `digestPaths` default `[]`
- `coord N` start-or-resume; explicit `start` refuses existing runtime
- `gh … --repo` before runtime/tmux effects
- Legacy outer `coord-root/issue-N` resume with dual-path ambiguity refusal
- Doctor refuses another product’s flat config for the requested project
- First failed onboard does not publish a locator

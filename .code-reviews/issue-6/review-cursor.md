# Code review: Cursor implementation for issue 6

- Reviewed head: `origin/issue-6/cursor` @ `eac4dcd`
- Baseline: `origin/main` @ `f9d0084`
- Scope: `git diff f9d0084...eac4dcd` — bootstrap, onboard, workspace layout,
  GitHub-issue digest, `coord N`
- Reviewer: Cursor (implementation self-review for peers)

## Verdict

Happy-path pieces land correctly: non-wiring owner locator, mandatory
`github-issue` digest source, config `profile`, start-or-resume for `coord N`,
`gh --repo` before runtime effects, and flat wipe refusal. Several
multi-product / upgrade defects remain and should be fixed before this is the
merge trunk without patches.

## Findings

### 1. `src/cli.ts:366`

**Rule.** Nested products may place new run state under `workspaceRoot`, but
existing issue runtimes created under the outer `<coord-root>/issue-N` (main /
issue-4 layout) must still resolve for resume, or migrate once. Silent path
changes must not orphan durable `start.json`.

**Failure.** `startIssue` always uses `location.workspaceRoot`. For a nested
install from `main`, that is `…/workspaces/<project>`, so `coord N` looks under
`workspaces/<project>/issue-N`, misses `<coord-root>/issue-N/start.json`, and
either creates a second runtime or leaves `coord run --coord-root <outer>` on
the old path while start used the new one.

**Test.**

```ts
it("nested product resumes a pre-migration coord-root issue runtime", async () => {
  // workspaces/app/config.json + coordRoot/issue-7/start.json (main layout)
  await expect(coordN(7, { product: app })).resolves.toBeDefined();
  expect(existsSync(join(coordRoot, "issue-7", "start.json"))).toBe(true);
  expect(existsSync(join(coordRoot, "workspaces/app/issue-7"))).toBe(false);
});
```

---

### 2. `src/cli.ts:472` / `src/tmux.ts:53`

**Rule.** Two products sharing an outer runtime must be able to start the same
GitHub issue number without sharing control-plane identity (tmux session) or
destroying each other's sessions.

**Failure.** Disk state is scoped to `workspaceRoot`, but
`tmux.startSession(input.issue)` names the session `coord-<n>` only. Product B
starting `#42` while A's `coord-42` exists throws “tmux session already exists”;
cleanup via `stopSession(issue)` can kill the wrong product's session.

**Test.**

```ts
it("two products can start issue 42 without tmux session collision", async () => {
  await startIssue({ issue: 42, product: appA, resumeIfPresent: false, /* fake tmux */ });
  await expect(startIssue({ issue: 42, product: appB, resumeIfPresent: false }))
    .resolves.toBeDefined();
});
```

---

### 3. `src/workspace.ts:99`

**Rule.** A second product must not inherit leftover outer `issue-*` /
`mirror.git` from a previous flat install. Flat occupancy detection must cover
run-state leftovers after config-only uninstall.

**Failure.** After flat uninstall without `--wipe-runtime`, `config.json` is
gone but `issue-*` and `mirror.git` remain. `chooseWorkspaceLocation` for
another project sees no flat config and no `workspaces/`, chooses flat again,
and reuses the previous product's run state and mirror.

**Test.**

```ts
it("refuses or nests when outer issue roots remain after flat uninstall", () => {
  // uninstall A without wipe; leftover issue-1/ + mirror.git
  expect(chooseWorkspaceLocation(coordRoot, "other").layout).not.toBe("flat");
});
```

---

### 4. `src/doctor.ts:395`

**Rule.** Flat-first doctor resolve must still diagnose the **requested**
product, not whichever `config.json` sits at the outer root.

**Failure.** When `resolveInstalledWorkspace(coordRoot, projectB)` is null but
`coordRoot/config.json` exists for product A, doctor picks the flat file.
`coord doctor --product B` reports A's findings or a false healthy status.

**Test.**

```ts
it("doctor for product B does not read product A's flat config", () => {
  // only flat config for "alpha"
  expect(() => doctor({ coordRoot, productRoot: beta })).toThrow(/No installed workspace/);
});
```

---

### 5. `src/cli.ts:132`

**Rule.** Owner commands that touch issue state (`run`, `pause`, `abandon`, …)
must resolve the same `workspaceRoot` that `start` / `coord N` used.

**Failure.** Nested start writes under `workspaces/<project>/`. Operators reuse
the outer `--coord-root` on `coord run`; `context()` builds
`<outer>/issue-N` and misses the live runtime.

**Test.**

```ts
it("coord run with --product finds nested issue state", async () => {
  await coordN(3, { product: nestedApp });
  await expect(runCli(["run", "--issue", "3", "--product", nestedApp], …)).resolves.toBe(0);
});
```

---

### 6. `src/cli.ts:602`

**Rule.** If onboard exits non-zero because doctor failed, the owner locator
must not leave `coord N` able to resolve a known-broken install as healthy
wiring.

**Failure.** `onboard()` / `install` writes `coord.ownerWorkspaceConfig` before
doctor runs. Doctor failure returns non-zero but the locator remains, so the
next `coord 42` resolves the product and fails later with a worse message than
“onboard did not finish.”

**Test.**

```ts
it("clears or ignores owner locator when onboard doctor fails", async () => {
  await expect(onboardBroken()).rejects.toMatchObject({ /* non-zero */ });
  expect(readOwnerWorkspaceConfig(product)).toBeNull();
});
```

## What landed correctly

- `coord.ownerWorkspaceConfig` (not agent wiring keys)
- Digest sources: `config` + `github-issue` + optional `digestPaths` (default `[]`)
- `coord N` start-or-resume; explicit `start` still refuses
- Profile on config; flat wipe does not `rm` the coord-root
- Issue fetch uses `gh … --repo` before creating runtime

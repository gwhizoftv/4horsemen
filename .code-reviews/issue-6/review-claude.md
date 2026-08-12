# Code review: Claude plan for issue 6

- Reviewed head: `origin/issue-6/claude` @ `51b9fe7`
- Baseline: `origin/main` @ `f9d0084`
- Scope: `.plans/issue-6/plan.md` only (no implementation commits)
- Reviewer: Cursor
- Also compared against: `origin/issue-6/codex` @ `c36a641`,
  `origin/issue-6/cursor` @ `14fdbdc`, Antigravity review of Codex at
  `origin/issue-6/antigravity` @ `7ba010f`

## Verdict

**Claude’s plan is the strongest base for continuing revisions.** It is the
only plan that simultaneously (a) keeps the product→runtime pointer outside
both the product tree and any single install-root, (b) names the flat-layout
uninstall/`--wipe-runtime` data-loss hazard and gates it, (c) makes `coord N`
start-or-resume so the daily command survives `Ctrl-C`, (d) keeps non-GitHub /
offline products startable via `--issue-snapshot`, and (e) sequences seven
green commits with an explicit R1–R8 trace. Codex remains valuable for
per-product nested run-state isolation; Cursor’s plan is a thinner peer of the
same surface.

Fix the multi-product run-state collision below before implementing Claude as
written; port Codex’s `workspaceRoot`-scoped issue/mirror paths into Claude’s
layout resolver.

## Findings

### 1. `.plans/issue-6/plan.md:138`

**Rule.** When more than one product shares an outer `coord-root`, issue run
directories and `mirror.git` must be scoped to that product’s workspace. Two
products must be able to start the same GitHub issue number without sharing or
refusing each other’s durable state.

**Failure.** D2 writes nested configs under `workspaces/<project>/` but D3
still materialises `<coord-root>/issue-N/issue.json` via the existing
`issueRuntimePaths(coordRoot, issue)` shape (`src/paths.ts`). After product A
starts `#42`, product B’s `coord 42` hits `existsSync(paths.issueRoot)` and
either refuses (“runtime state already exists”) or resumes A’s session against
B’s origin/digest. The plan’s nested-compat tests never assert two products
starting the same issue number on one runtime.

**Test.**

```ts
it("two products on one runtime can both start issue 42", async () => {
  await onboard(appA, { coordRoot });
  await onboard(appB, { coordRoot }); // second → nested
  await coordN(42, { product: appA, issueSnapshot: fixtureA });
  await coordN(42, { product: appB, issueSnapshot: fixtureB });
  expect(readStart(appA, 42).origin).not.toBe(readStart(appB, 42).origin);
  expect(readStart(appA, 42).automationDigest).not.toBe(readStart(appB, 42).automationDigest);
});
```

---

### 2. `.plans/issue-6/plan.md:63`

**Rule.** Ambiguous product resolution must fail closed. “Exactly one registry
entry” may be used only when that entry is the only plausible product for the
caller’s cwd/context; a machine-global singleton must not silently bind
`coord N` run from an unrelated directory.

**Failure.** Resolution step 4 says: no `--product`, exactly one registry entry
→ that entry. After onboarding a single app, any later `coord 42` from `/tmp`
or another repo starts that app’s issue. That is convenient until a second
product is onboarded (step 5 then errors), but it teaches a footgun: the daily
command’s target depends on global registry cardinality, not on where the
operator is standing. A CI job or second shell with one stale entry will drive
the wrong product without `--product`.

**Test.**

```ts
it("refuses flagless coord N when cwd is not inside the registered product", async () => {
  await onboard(app);
  await expect(coordN(1, { cwd: "/tmp", registry: oneEntry })).rejects.toThrow(/--product/);
});
```

---

### 3. `.plans/issue-6/plan.md:250`

**Rule.** If onboard exits non-zero because doctor failed, the operator-visible
contract must not report success, and any registry write must not make
`coord N` appear healthy while wiring is known-broken.

**Failure.** Onboard “returns [doctor’s] exit code (non-zero doctor ⇒ non-zero
onboard, and the registry entry is still recorded so `coord doctor` can be
re-run).” Recording the entry before/despite doctor failure means the next
`coord 42` resolves a product whose doctor findings include missing hooks or
`startCompatibility` errors, then fails mid-start with a worse message than
“onboard did not finish.” Either withhold the registry entry until doctor is
clean, or make `coord N` / `resolveRuntime` re-run a cheap doctor gate and
refuse with the onboard remediation.

**Test.**

```ts
it("does not let coord N resolve a product whose onboard doctor failed", async () => {
  // force doctor finding (e.g. missing launcher) during onboard
  await expect(onboard(broken)).rejects.toMatchObject({ exitCode: expect.any(Number) });
  expect(resolveProduct({ productPath: broken })).toBeNull(); // or throws repair hint
});
```

---

### 4. `.plans/issue-6/plan.md:62`

**Rule.** Resolving “cwd is inside … one of its agent clones” to a product
entry must not let an agent-controlled working directory select owner runtime
paths that `resolveSafeCoordRoot` would reject if the agent rewrote the
registry. Registry bytes are owner-written, but cwd selection is
agent-reachable.

**Failure.** Step 3 treats an agent clone cwd as sufficient to select the
registry entry (and thus `coordRoot` / `configPath`). That is intended for
owner convenience when attached inside an agent pane. If an implementation
later allows any registry field to be refreshed from clone-local state, or if
`coord N` is ever invoked by automation inside the clone, the clone becomes a
confused-deputy path into owner start/run. The plan should state that only the
owner-facing CLI uses cwd→registry mapping, and that hooks never call
`resolveProduct`.

**Fix sketch.** Document and assert: `resolveProduct` is imported only from
`src/cli.ts` owner commands; `hook-verify` / `hook-scope` keep using
`coord.workspaceConfig` only.

## Comparison notes

| Topic | Claude | Codex | Cursor |
| --- | --- | --- | --- |
| Pointer | XDG state registry | product `.git/config` locator | install-root registry |
| Flat uninstall guard | explicit | implied via workspace wipe scope | partial |
| Nested issue isolation | **missing** (finding 1) | **present** (`workspaceRoot`) | missing |
| `coord N` resume | start-or-resume | start then run only | start then run only |
| Offline / non-GH | `--issue-snapshot` | fails closed on non-GH | not specified |
| Bootstrap testability | `--source` / `--no-build` | temp origins | temp HOME |
| Depth / sequencing | strongest | strong | adequate |

**Continue on `issue-6/claude`**, after adopting Codex’s per-workspace run-state
paths (finding 1) and tightening flagless resolution (findings 2–3).

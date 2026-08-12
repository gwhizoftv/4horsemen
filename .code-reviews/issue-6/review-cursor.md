# Code review: Cursor plan for issue 6

- Reviewed head: `origin/issue-6/cursor` @ `34c803f` (this branch)
- Baseline: `origin/main` @ `f9d0084`
- Scope: `.plans/issue-6/plan.md` only
- Reviewer: Cursor (self-review for peer comparison)
- Also compared against: `origin/issue-6/codex` @ `c36a641`; Claude unpublished

## Verdict

Cursor’s plan is a complete R1–R8 sketch and is mergeable as a secondary
reference, but **it is not the strongest trunk.** Codex’s plan is stricter on
nested-product run-state isolation, first-class issue digest binding, and a
shared `startIssue` extraction. The defects below are reasons to prefer Codex
(or to patch Cursor before implementing from it).

## Findings

### 1. `.plans/issue-6/plan.md:69`

**Rule.** When more than one product shares an outer `coord-root`, issue run
directories and the bare mirror must not collide on GitHub issue numbers or
mirror contents. Per-product run state must be keyed by the product workspace,
not only by the outer runtime directory.

**Failure.** The plan keeps “Issue runtimes stay at `<coord-root>/issue-<n>/`”
for both flat and nested layouts. Two products onboarded into one runtime (the
nested multi-product case the plan itself allows) that both run GitHub `#42`
write the same `coord-root/issue-42/` tree and share `mirror.git`. Starting the
second product’s issue 42 either refuses (“runtime state already exists”) or
corrupts the first product’s session cursors / digest / origin binding.

**Test.**

```ts
it("two products on one runtime can both start issue 42", () => {
  onboard(appA, { coordRoot });
  onboard(appB, { coordRoot }); // second → nested workspaces/appB
  start(42, { product: appA });
  start(42, { product: appB });
  expect(existsSync(join(/* appA workspace */ "issue-42", "start.json"))).toBe(true);
  expect(existsSync(join(/* appB workspace */ "issue-42", "start.json"))).toBe(true);
  expect(readStart(appA, 42).origin).not.toBe(readStart(appB, 42).origin);
});
```

---

### 2. `.plans/issue-6/plan.md:76`

**Rule.** Product→runtime discovery for `coord N` must work for the `coord` on
`PATH` after bootstrap, independent of which checkout happened to run `onboard`.
Discovery state must not be trapped inside a single install-root that the daily
binary may not share.

**Failure.** The plan stores the registry under `<install-root>/registry/products/`.
Onboard run from a developer checkout (`./coord onboard …` in
`coordination-cursor`) writes registry files there. The operator’s daily
`~/.local/bin/coord` (bootstrap install root `~/.local/share/coordination`)
reads a different registry and reports the product as not onboarded. `coord N`
then fails with “run onboard” even though agent clones and `coord-root` already
exist.

**Test.**

```ts
it("PATH coord sees products onboarded by a different install root", () => {
  const dev = installRootA;
  const pathCoord = installRootB; // bootstrap root
  onboardWith(dev, product);
  expect(() => resolveProduct(pathCoord, product)).not.toThrow();
  // or: product-local locator readable without consulting install-root registry
});
```

---

### 3. `.plans/issue-6/plan.md:106`

**Rule.** The GitHub issue work statement must be a mandatory digest input even
when `digestPaths` is customized or emptied by `--declare`. Optional path lists
must not be the only mechanism that includes the issue snapshot.

**Failure.** Defaulting `digestPaths` to `["issues/issue-{issue}.md"]` and
“materialise then reuse `automationDigestMaterial`” means an operator who
passes `--declare` with `digestPaths: []` or a custom list that omits the
snapshot path silently drops the issue from the digest while still satisfying
schema. Start can succeed with a config-only digest, recreating the wrong UX
the issue exists to remove (session identity unbound from the GitHub work
statement).

**Test.**

```ts
it("declare with empty digestPaths still binds the GitHub issue into the digest", async () => {
  onboard(product, { declare: { digestPaths: [], checks: […] } });
  const started = await coordN(7, { issueFixture: { title: "T", body: "B" } });
  expect(started.automationDigestSources.some((s) => s.id.includes("issue") || s.id.includes("github"))).toBe(true);
});
```

---

### 4. `.plans/issue-6/plan.md:170`

**Rule.** Doctor must not require the GitHub issue snapshot file to exist before
the first `coord start` / `coord N`. Snapshots are created at start time.

**Failure.** The plan says doctor “may note that start materialises” the
snapshot, but still routes doctor through the same layout helpers and
`digestPaths` existence mindset used today (`doctor.ts` walks `digestPaths`).
If doctor continues to treat missing digest path files as
`startCompatibility` failures, onboard’s “run doctor at end; doctor failure ⇒
onboard non-zero” gate fails on every healthy fresh onboard before any issue is
started.

**Test.**

```ts
it("doctor passes after onboard with no issues/ tree yet", () => {
  onboard(product);
  expect(existsSync(join(coordRoot, "issues"))).toBe(false);
  expect(doctor({ coordRoot, productRoot: product }).exitCode).toBe(0);
});
```

## Trunk recommendation

Prefer **`issue-6/codex`** for implementation revisions. Keep this Cursor plan
as a peer artifact; cherry-pick the doctor-before-snapshot clarification (finding
4) into the Codex trunk if it is not already explicit enough there.

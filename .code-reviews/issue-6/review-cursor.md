# Code review: Cursor plan for issue 6

- Reviewed head: `origin/issue-6/cursor` @ `14fdbdc` (plan commit `34c803f`;
  this review file updates after peer plans landed)
- Baseline: `origin/main` @ `f9d0084`
- Scope: `.plans/issue-6/plan.md`
- Reviewer: Cursor (self-review for peer comparison)
- Also compared against: `origin/issue-6/claude` @ `51b9fe7`,
  `origin/issue-6/codex` @ `c36a641`

## Verdict

Cursor’s plan is a complete R1–R8 sketch but **should not be the revision
trunk.** Claude is stronger on registry placement, uninstall safety,
start-or-resume, and offline start; Codex is stronger on nested run-state
isolation. Keep this plan as a peer artifact only.

## Findings

### 1. `.plans/issue-6/plan.md:69`

**Rule.** When more than one product shares an outer `coord-root`, issue run
directories and the bare mirror must not collide on GitHub issue numbers.

**Failure.** The plan keeps “Issue runtimes stay at `<coord-root>/issue-<n>/`”
for both layouts. Two products on one runtime that both run `#42` share or
refuse the same `issue-42/` tree and `mirror.git`.

**Test.**

```ts
it("two products on one runtime can both start issue 42", () => {
  onboard(appA, { coordRoot });
  onboard(appB, { coordRoot });
  start(42, { product: appA });
  start(42, { product: appB });
  expect(readStart(appA, 42).origin).not.toBe(readStart(appB, 42).origin);
});
```

---

### 2. `.plans/issue-6/plan.md:76`

**Rule.** Product→runtime discovery for `coord N` must work for the `coord` on
`PATH` after bootstrap, independent of which checkout ran `onboard`.

**Failure.** Registry under `<install-root>/registry/products/` means onboard
from a developer checkout writes one registry, while `~/.local/bin/coord` reads
another and reports the product as not onboarded.

**Test.**

```ts
it("PATH coord sees products onboarded by a different install root", () => {
  onboardWith(installRootA, product);
  expect(() => resolveProduct(installRootB, product)).not.toThrow();
});
```

---

### 3. `.plans/issue-6/plan.md:106`

**Rule.** The GitHub issue work statement must be a mandatory digest input even
when `digestPaths` is customized or emptied by `--declare`.

**Failure.** Defaulting `digestPaths` to `["issues/issue-{issue}.md"]` and
relying on materialise-then-hash means `--declare` with `digestPaths: []` can
drop the issue from the digest while still satisfying schema.

**Test.**

```ts
it("declare with empty digestPaths still binds the GitHub issue", async () => {
  onboard(product, { declare: { digestPaths: [], checks: […] } });
  const started = await coordN(7, { issueFixture: { title: "T", body: "B" } });
  expect(started.automationDigestSources.some((s) => s.id === "github-issue" || s.id.includes("issue"))).toBe(true);
});
```

---

### 4. `.plans/issue-6/plan.md:112`

**Rule.** `coord N` after an interrupted start must resume, not demand a longer
explicit `coord run` invocation as the only path.

**Failure.** The plan defines `coord N` as start then run, with `start`
unchanged. Existing runtime ⇒ “already exists” error, so the daily command
fails after `Ctrl-C`. Claude’s start-or-resume decision is the correct daily
behaviour.

**Test.**

```ts
it("coord N resumes when issue runtime already exists", async () => {
  await coordN(5, { issueFixture });
  await expect(coordN(5, { issueFixture })).resolves.toBeDefined();
});
```

---

### 5. `.plans/issue-6/plan.md:170`

**Rule.** Doctor must not require the GitHub issue snapshot file to exist
before the first `coord start` / `coord N`.

**Failure.** If doctor still treats missing `digestPaths` files as
`startCompatibility` failures, onboard’s “doctor failure ⇒ onboard non-zero”
gate fails on every healthy fresh onboard before any issue is started.

**Test.**

```ts
it("doctor passes after onboard with no issues/ tree yet", () => {
  onboard(product);
  expect(doctor({ coordRoot, productRoot: product }).exitCode).toBe(0);
});
```

## Trunk recommendation

Prefer **`issue-6/claude`**, porting Codex’s `workspaceRoot` run-state isolation
and discarding Cursor’s install-root registry in favour of Claude’s XDG state
registry (or an equivalently machine-global, install-root-independent store).

# Code review: Claude branch for issue 6

- Reviewed head: `origin/issue-6/claude` @ `b802bc4`
- Baseline: `origin/main` @ `f9d0084`
- Scope: simplified plan only — **no implementation commits**
- Reviewer: Cursor
- Compared against Cursor implementation @ `eac4dcd`

## Verdict

Claude’s simplified plan is **not** a safe implementation guide and the branch
has no code. The simplify commit dropped the XDG registry in favour of writing
`coord.workspaceConfig` onto the product — an agent-wiring key. Cursor’s
implementation correctly used a distinct `coord.ownerWorkspaceConfig` instead.

Do not continue revisions from Claude’s current plan tip.

## Findings

### 1. `.plans/issue-6/plan.md:26` (simplified plan)

**Rule.** Product-master local Git config used only as an owner locator must not
be `coord.installRoot`, `coord.cliEntry`, or `coord.workspaceConfig`
(`githooks/lib/identity.sh` `consensus_wiring_present`).

**Failure.** Change 1 writes `coord.workspaceConfig` plus `coord.coordRoot` into
the **product** clone. Any later `--write-product` / vendored hooks, or a human
who enables hooks, makes `consensus_wiring_present` true with no
`consensus.agentId`, so every product commit fails closed as an unresolved
agent identity.

**Test.**

```ts
it("onboard does not set agent wiring keys on the product", () => {
  onboard(product);
  expect(localConfigGet(product, "coord.workspaceConfig")).toBeNull();
  expect(localConfigGet(product, "coord.ownerWorkspaceConfig")).toMatch(/config\.json$/);
});
```

---

### 2. `.plans/issue-6/plan.md:88` (simplified plan)

**Rule.** Nested multi-product run state must not share outer
`<coord-root>/issue-N` / `mirror.git` for the same GitHub issue number.

**Failure.** The simplified plan still materialises
`<coord-root>/issue-N/issue.json` via outer `issueRuntimePaths`. Two products on
one runtime cannot both start `#42`.

**Test.** Same as Cursor review finding 2 / Codex workspaceRoot requirement.

---

### 3. (branch tip) missing implementation

**Rule.** A revision candidate must ship code and tests for R1–R8, not only a
plan.

**Failure.** Diff vs `main` is a single `.plans/issue-6/plan.md`. No bootstrap,
onboard, or digest code exists on `origin/issue-6/claude`.

**Test.** `git diff --name-only origin/main...HEAD` must list `src/` / `scripts/`
/ `test/` paths.

## Recommendation

Ignore Claude’s simplified locator design. Prefer Cursor’s
`coord.ownerWorkspaceConfig` (already shipped) and Codex’s nested
`workspaceRoot` isolation for remaining fixes.

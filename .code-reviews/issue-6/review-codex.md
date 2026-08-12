# Code review: Codex branch for issue 6

- Reviewed head: `origin/issue-6/codex` @ `36acbda`
- Baseline: `origin/main` @ `f9d0084`
- Scope: plan + peer plan reviews only — **no implementation commits**
- Reviewer: Cursor
- Compared against Cursor implementation @ `eac4dcd`

## Verdict

Codex still has the strongest **design** for nested run-state isolation, but
this branch has **no code** to review against R8. Cursor’s implementation
adopted Codex’s plan plus agreed review patches; remaining Cursor defects (tmux
session keying, pre-migration issue path fallback) are exactly the gaps Codex’s
plan called out and Cursor has not finished.

Do not merge Codex as an implementation trunk until it contains production code.
Use it as the design reference for fixing Cursor finding #1 (legacy issue path)
and as the origin of the `workspaceRoot` model Cursor already ships.

## Findings

### 1. (branch tip) missing implementation

**Rule.** After the planning gate, the candidate revision trunk must publish
implementation that satisfies R1–R8 (bootstrap, onboard, flat layout, `coord N`,
issue-seeded digest, tests) on `origin`.

**Failure.** `git log origin/main..origin/issue-6/codex` is only the plan and
three review markdown files. There is no `scripts/bootstrap.sh`, no
`src/workspace.ts`, and no tests peers can run. Selecting Codex as the code
trunk today means re-implementing from the plan.

**Test.** `git diff --name-only origin/main...origin/issue-6/codex` must include
production paths under `src/` / `scripts/` / `test/` before code review of an
implementation can proceed.

---

### 2. `.plans/issue-6/plan.md:110` (still open on the plan)

**Rule.** A product-master owner locator must not use
`coord.installRoot` / `coord.cliEntry` / `coord.workspaceConfig`.

**Failure.** The plan still says “one owner-only locator” without naming the
key. Cursor implemented `coord.ownerWorkspaceConfig`; if Codex implements the
plan literally with `coord.workspaceConfig`, product clones become agent-wired
under `consensus_wiring_present` whenever hooks appear.

**Test.**

```ts
it("owner locator is not an agent wiring key", () => {
  onboard(product);
  for (const key of ["coord.installRoot", "coord.cliEntry", "coord.workspaceConfig"]) {
    expect(localConfigGet(product, key)).toBeNull();
  }
});
```

---

### 3. `.plans/issue-6/plan.md:176` (still open on the plan)

**Rule.** Daily `coord N` must start-or-resume; explicit `start` may stay strict.

**Failure.** Codex’s plan composes start then run without resume semantics.
Cursor implemented start-or-resume per review agreement; a Codex implementation
that follows the plan text literally will fail after `Ctrl-C`.

**Test.**

```ts
it("coord N resumes an existing issue runtime", async () => {
  await coordN(3, { issueFixture });
  await expect(coordN(3, { issueFixture })).resolves.toBeDefined();
});
```

## Recommendation

Keep Codex’s plan as the design authority for workspace-scoped run state; land
fixes on Cursor’s implementation (or wait for Codex code) rather than treating
this branch tip as mergeable code.

# Code review: Codex plan for issue 6

- Reviewed head: `origin/issue-6/codex` @ `c36a641`
- Baseline: `origin/main` @ `f9d0084`
- Scope: `.plans/issue-6/plan.md` only (no implementation commits)
- Reviewer: Cursor
- Also compared against: `origin/issue-6/cursor` @ `34c803f`; Claude has no
  published issue-6 plan

## Verdict

**Codex’s plan is the strongest base for revisions.** It alone makes
`WorkspaceLocation` a first-class value, isolates nested-product run state,
treats the GitHub issue as a mandatory first-class digest source (with
`digestPaths` demoted to optional extras), extracts a shared `startIssue`
operation, and specifies fail-before-effects cleanup. Cursor’s plan covers the
same R1–R8 surface but is weaker on multi-product isolation and product→runtime
discovery. Claude has not published a plan.

The defects below are design holes that would become code bugs if implemented
as written. Fix them in the plan (or in the first implementation commit) before
treating Codex as the merge trunk.

## Findings

### 1. `.plans/issue-6/plan.md:110`

**Rule.** A product-master local Git config key used only as an owner locator
must not be any of `coord.installRoot`, `coord.cliEntry`, or
`coord.workspaceConfig`. Those three keys are exactly what
`githooks/lib/identity.sh` (`consensus_wiring_present`) treats as proof that a
clone is an agent clone.

**Failure.** The plan records “exactly one owner-only locator in the product
clone's local Git config” and claims it “is not one of the keys that marks an
agent clone,” but it never names the key. The only existing config-path key in
the codebase is `coord.workspaceConfig`. If onboard writes that key onto the
product (the natural reading), then any later `--write-product` / vendored-hook
path — or a human who copies hooks while debugging — makes
`consensus_wiring_present` true with no `consensus.agentId`, so every product
commit fails closed with “agent identity is unresolved.” A fresh human clone
stays clean only because it lacks both the key and the hooks; the onboarded
owner product becomes unsafe the moment hooks appear.

**Test.**

```ts
it("owner locator key is not agent wiring", () => {
  onboard(product);
  for (const key of ["coord.installRoot", "coord.cliEntry", "coord.workspaceConfig"]) {
    expect(localConfigGet(product, key)).toBeNull();
  }
  expect(localConfigGet(product, "coord.ownerWorkspaceConfig" /* or named key */)).toMatch(/config\.json$/);
});
```

---

### 2. `.plans/issue-6/plan.md:79`

**Rule.** Changing where issue run state lives for nested layouts must either
preserve the existing `<coord-root>/issue-<n>/` location for already-started
issues, or provide an explicit one-time migration. Silent path changes must not
orphan durable `start.json` / mirror state.

**Failure.** Today `issueRuntimePaths` always places run state under the outer
`--coord-root` (`src/paths.ts`). The plan moves nested products to
`workspaces/<project>/issue-N` and `…/mirror.git` for new starts, while saying
old runs remain operable via “recorded/explicit runtime root.” An operator who
re-resolves via `--product` / locator after this lands will get the new
`workspaceRoot` and look under `workspaces/<project>/issue-N`, missing an
in-flight `coord-root/issue-N` from before the change. `coord run` / `resume`
then behave as “no such issue” or start a second divergent runtime for the same
GitHub issue number.

**Test.**

```ts
it("nested product still finds a pre-existing coord-root issue runtime", () => {
  // fixture: workspaces/app/config.json + coordRoot/issue-7/start.json (old layout)
  // resolve via --product and run/resume issue 7
  // expect: reads the old start.json, does not create workspaces/app/issue-7
});
```

---

### 3. `.plans/issue-6/plan.md:130`

**Rule.** If `digestPaths` may be empty, every start path that builds
`automationDigest` must still bind the GitHub issue snapshot as a mandatory
source. No caller may hash config alone and treat that as a valid session
digest.

**Failure.** The plan defaults `digestPaths` to `[]` and extends
`automationDigestMaterial` to take “canonical issue bytes.” Existing call sites
and tests (`test/cli.test.ts`, doctor’s `digestPaths` `{issue}` check) still
assume digest identity comes from the path list. A partial refactor that empties
`digestPaths` before the issue-bytes parameter is threaded through every start
entry (including recovery / re-digest helpers, if any) produces sessions whose
digest ignores the work statement — agents can join with matching config while
disagreeing about which GitHub issue they are implementing.

**Test.**

```ts
it("start digest changes when only the issue body changes", async () => {
  const a = await startWithIssue({ number: 7, title: "A", body: "one" });
  abandon(a);
  const b = await startWithIssue({ number: 7, title: "A", body: "two" });
  expect(b.automationDigest).not.toBe(a.automationDigest);
  expect(b.automationDigestSources.map((s) => s.id)).toContain(/* issue source id */);
});
```

---

### 4. `.plans/issue-6/plan.md:398`

**Rule.** A “fresh human clone of the same origin has no … local locator” must
be true by construction: onboard may write local config only in the clone that
was passed as `--product`, never into a template, tracked file, or hook that a
subsequent `git clone` would copy.

**Failure.** Acceptance item 3 asserts the human clone has no local locator.
That holds for Git’s normal clone (local config is not transferred). It fails
if implementation “helps” by writing the locator into a tracked file, an
`include.path`, or a setup script under the product tree. The plan correctly
rejects a tracked pointer, but acceptance only checks hooks + locator after a
fresh clone — it should also assert `git status --porcelain` on the onboarded
product remains empty *and* that the locator key is absent from any committed
tree blob (so a mistaken tracked helper cannot sneak in).

**Test.**

```ts
it("human clone has neither hooks nor owner locator", () => {
  onboard(product);
  const human = cloneFresh(product.origin);
  expect(localConfigGet(human, ownerLocatorKey)).toBeNull();
  expect(existsSync(join(human, ".git/hooks/pre-commit"))).toBe(false); // or no coord shim
  expect(git(product, "status", "--porcelain")).toBe("");
});
```

## Comparison notes (not separate findings)

| Topic | Codex | Cursor | Claude |
| --- | --- | --- | --- |
| Published plan | yes @ `c36a641` | yes @ `34c803f` | **none** |
| Flat-first resolver | `WorkspaceLocation` module | `workspaceLayout.ts` | — |
| Nested run-state isolation | yes under `workspaceRoot` | no — all `coord-root/issue-N` | — |
| Product→runtime pointer | product-local Git key | install-root registry | — |
| Issue digest | first-class bytes; `digestPaths` optional | materialise into default `digestPaths` entry | — |
| `startIssue` extraction | explicit | implied by `coord N` sugar | — |
| R8 acceptance detail | strongest | solid checklist | — |

**Continue revisions on `issue-6/codex`,** after addressing findings 1–3 in the
plan or as the first implementation fixes. Port Cursor’s clearer “doctor must
not require a pre-existing snapshot” note and bootstrap PATH-wrapper details if
useful; do not switch trunk to Cursor solely for the install-root registry.

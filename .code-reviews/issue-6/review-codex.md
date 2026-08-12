# Code review: Codex plan for issue 6

- Reviewed head: `origin/issue-6/codex` @ `c36a641`
- Baseline: `origin/main` @ `f9d0084`
- Scope: `.plans/issue-6/plan.md` only
- Reviewer: Cursor
- Peer reviews considered: Antigravity `.code-reviews/codex.md` @ `7ba010f`;
  Cursor’s earlier Codex review (superseded by this file after Claude published)

## Verdict

Codex remains the **best source for nested multi-product run-state isolation**
(`workspaceRoot`-scoped `issue-N` / `mirror.git`) and for extracting a shared
`startIssue` operation. It is **no longer the preferred revision trunk** now
that Claude’s plan is published: Claude’s XDG registry, flat uninstall guard,
start-or-resume `coord N`, and `--issue-snapshot` are stronger operator-surface
decisions. Port Codex’s workspace-scoped run paths into Claude; do not implement
Codex’s product-local Git locator as written.

Antigravity’s review claims any product `.git/config` write violates zero
footprint. That overstates the issue: local config is not cloned to a fresh
human checkout and does not dirty `git status --porcelain`. The real defect is
**which** key is written (finding 1).

## Findings

### 1. `.plans/issue-6/plan.md:110`

**Rule.** A product-master local Git config key used only as an owner locator
must not be any of `coord.installRoot`, `coord.cliEntry`, or
`coord.workspaceConfig`. Those three keys are exactly what
`githooks/lib/identity.sh` (`consensus_wiring_present`) treats as proof that a
clone is an agent clone.

**Failure.** The plan records “exactly one owner-only locator in the product
clone's local Git config” and claims it “is not one of the keys that marks an
agent clone,” but never names the key. The only existing config-path key in the
codebase is `coord.workspaceConfig`. If onboard writes that key onto the
product, then any later `--write-product` / vendored-hook path — or a human who
enables hooks while debugging — makes `consensus_wiring_present` true with no
`consensus.agentId`, so every product commit fails closed with “agent identity
is unresolved.”

**Test.**

```ts
it("owner locator key is not agent wiring", () => {
  onboard(product);
  for (const key of ["coord.installRoot", "coord.cliEntry", "coord.workspaceConfig"]) {
    expect(localConfigGet(product, key)).toBeNull();
  }
  expect(localConfigGet(product, "coord.ownerWorkspaceConfig")).toMatch(/config\.json$/);
});
```

---

### 2. `.plans/issue-6/plan.md:79`

**Rule.** Changing where issue run state lives for nested layouts must either
preserve the existing `<coord-root>/issue-<n>/` location for already-started
issues, or provide an explicit one-time migration. Silent path changes must not
orphan durable `start.json` / mirror state.

**Failure.** Today `issueRuntimePaths` always places run state under the outer
`--coord-root`. The plan moves nested products to `workspaces/<project>/issue-N`
for new starts. An operator who re-resolves via `--product` / locator after this
lands will look under the new `workspaceRoot` and miss an in-flight
`coord-root/issue-N` from before the change.

**Test.**

```ts
it("nested product still finds a pre-existing coord-root issue runtime", () => {
  // fixture: workspaces/app/config.json + coordRoot/issue-7/start.json (old layout)
  // resolve via --product and run/resume issue 7
  // expect: reads the old start.json, does not create workspaces/app/issue-7
});
```

---

### 3. `.plans/issue-6/plan.md:176`

**Rule.** The daily `coord N` entry must be usable after an interrupted run.
`start` may keep refusing an existing issue runtime; the numeric command must
not inherit that refusal as its only behaviour.

**Failure.** Codex composes “shared `startIssue`, then run.” `startIssue`
presumably preserves today’s “runtime state already exists” error
(`src/cli.ts:440-441`). After `Ctrl-C` during `coord 42`, the next `coord 42`
fails and tells the operator to resume with a longer `coord run --issue …`
invocation — undermining R4’s daily command. Claude’s plan correctly makes
`coord N` start-or-resume while leaving explicit `coord start N` strict.

**Test.**

```ts
it("coord N resumes an existing issue runtime then runs", async () => {
  await coordN(3, { issueSnapshot: fixture });
  // simulate interrupt after start.json exists
  await expect(coordN(3, { issueSnapshot: fixture })).resolves.toBeDefined();
  // must not throw "Runtime state already exists"
});
```

---

### 4. `.plans/issue-6/plan.md:130`

**Rule.** If `digestPaths` may be empty, every start path that builds
`automationDigest` must still bind the GitHub issue snapshot as a mandatory
source.

**Failure.** The plan defaults `digestPaths` to `[]` and extends
`automationDigestMaterial` to take issue bytes. A partial refactor that empties
`digestPaths` before the issue-bytes parameter is threaded through every start
entry produces sessions whose digest ignores the work statement.

**Test.**

```ts
it("start digest changes when only the issue body changes", async () => {
  const a = await startWithIssue({ number: 7, title: "A", body: "one" });
  abandon(a);
  const b = await startWithIssue({ number: 7, title: "A", body: "two" });
  expect(b.automationDigest).not.toBe(a.automationDigest);
});
```

## What to keep from Codex

- `WorkspaceLocation.workspaceRoot` isolation for nested products (port to Claude).
- Shared `startIssue(...)` extraction (avoid subprocess choreography).
- Fail-before-tmux/runtime effects on unreadable issues.
- Bootstrap ownership metadata that does not dirty `git status` of the install
  checkout.

# Code review: Claude implementation for issue 4

- Reviewed branch: `origin/issue-4/claude`
- Reviewed tip: `72db53ab67d2ac788ea682302e6492e98c531d88`
- Baseline: `origin/main` (merge-base with the tip)
- Reviewer: Cursor

## Verdict

Default install keeps the product master clean, places fail-closed shims only in agent `.git/hooks/`, and drives verification from declared argv. The serious gaps are an intentional identity pass-through that ungates a still-wired agent clone, proposer-written empty `verify` that silently opts out, and hook mode bits falling outside drift detection so git can stop running gates without doctor noticing.

## Findings

### 1. `githooks/lib/identity.sh:48-50` (consumed at `githooks/pre-commit:12`)

**Rule:** Under revised Option C, presence of coordination hooks in an agent clone’s `.git/hooks/` means the clone is an agent clone. Missing or cleared `consensus.agentId` must fail closed while install wiring (`coord.installRoot` / workspace config / shims) remains.

**Failure:** Unsetting only `consensus.agentId` on a fully installed shim clone sets `CONSENSUS_AGENT_CLONE=false`; pre-commit/pre-push/commit-msg then `exit 0`. Branch ownership, commit-prefix, and declared `verify` are all skipped. `test/hookSync.test.ts` currently asserts this ungated commit succeeds, encoding the defect.

**Test:**

```ts
it("blocks when agentId is unset but coord wiring remains", () => {
  const { clone } = installed();
  stageWork(clone);
  git(clone, "config", "--local", "--unset", "consensus.agentId");
  // installRoot / cliEntry / workspaceConfig still set
  expect(tryGit(clone, "commit", "-m", "ungated").exitCode).not.toBe(0);
});
```

---

### 2. `src/setupWorkspace.ts:147-153` (Node) and `165-168` (Make)

**Rule:** Missing top-level `verify` must stay undeclared (fail closed). Only an operator-authored `"verify": { "precommit": [], "prepush": [] }` may opt out. “Found nothing to propose” must not be recorded as an explicit empty allow-list.

**Failure:** `proposeProjectPolicy` always returns a `verify` object for Node/Make trees. A `package.json` with only `"test"` (no `check:fast`/`check`/`lint`/`test:e2e`) yields `verify: { precommit: [], prepush: [] }`. Install writes that into coord-root config; hooks treat it as deliberate opt-out and allow commits with no local checks. Same for a Makefile with `test` but no `check`.

**Test:**

```ts
it("omits verify when no precommit/prepush commands were recognized", () => {
  const root = mkdtempSync(...);
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "echo ok" } }));
  const proposal = proposeProjectPolicy(root);
  expect(proposal.verify).toBeUndefined(); // not { precommit: [], prepush: [] }
});
```

---

### 3. `src/hookSync.ts:120-128` and `src/hookSync.ts:205-219` (doctor path via `inspectCloneHooks`)

**Rule:** Presence of coordination hooks must mean git actually runs them. Lost execute bits must be diagnosed and repaired; content-equal alone is not “healthy.”

**Failure:** Git silently ignores non-executable files under `.git/hooks/`. `writeCloneHooks` skips `chmod` when bytes already match, so a lost `+x` is never repaired on reinstall. `inspectCloneHooks` only compares digests (and doctor reports `ok` when digests match), so `coord doctor` can report healthy while commits and pushes are ungated.

**Test:**

```ts
it("reports and repairs hooks that lost the executable bit", () => {
  const { clone } = installed();
  chmodSync(join(clone, ".git", "hooks", "pre-commit"), 0o644);
  expect(inspectCloneHooks(...).kind).not.toBe("ok");
  // reinstall / doctor repair
  expect(statSync(join(clone, ".git", "hooks", "pre-commit")).mode & 0o111).toBeTruthy();
});
```

## Material test gaps

- No coverage that Node/Make “recognized tree, zero matching scripts/targets” leaves `verify` undefined.
- No coverage that non-executable `.git/hooks/*` is diagnosed or fixed on reinstall.
- Existing test asserts ungated commit when `consensus.agentId` is unset while install wiring remains; that assertion should reverse.

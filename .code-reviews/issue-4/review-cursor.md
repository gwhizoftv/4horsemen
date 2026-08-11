# Code review: Cursor implementation for issue 4

- Reviewed branch: `issue-4/cursor` (`df64e30`)
- Baseline: `origin/main` (`a673383`)
- Scope: installable deploy (zero product-master footprint), Option C shims, declared `verify`, doctor/uninstall
- Issue body was not modified

## Verdict

The two-mode install shape is largely right (agent `.git/hooks` shims, coord-root config stamp, no default product-master diff). Several fail-open paths remain in the new pre-push / verify wiring: a missing workspace config can still yield a successful push, install can turn “missing `verify`” into an explicit empty allow-list, and empty `workflowCritical*` silently disables a declared `verify.prepush`. Fix those before treating the acceptance criteria as met.

## Findings

### 1. `githooks/pre-push:21`

**Rule:** On an agent-wired clone, a missing or unreadable `coord.workspaceConfig` must fail closed for `pre-push` (non-zero exit with remediation). Printing “HOOK BLOCKED” is not sufficient if the process still exits 0.

**Failure:** `coord_load_workflow_critical` returns 1 when the config is unset, but `pre-push` deliberately omits `set -e` and does not check that return. The hook keeps empty critical-path lists, decides `verify.prepush skipped`, prints `pre-push checks passed`, and exits 0. An agent can push after `coord.workspaceConfig` is deleted or never set.

**Test:**

```ts
it("blocks push when coord.workspaceConfig is unset", () => {
  // agent clone with shims + identity + installRoot; no workspaceConfig
  // create commit on issue-1/cursor with remote-tracking main as base
  // expect: git push (or direct pre-push stdin) exits non-zero
  // expect stderr includes "coord.workspaceConfig"
});
```

---

### 2. `src/setupWorkspace.ts:250`

**Rule:** Absence of a top-level `verify` key must remain distinguishable from an explicit empty `verify` object. Install must not synthesize `{ precommit: [], prepush: [] }` for a missing declaration; only an explicit empty object may allow ungated agent commits.

**Failure:** `verify: template.verify ?? { precommit: [], prepush: [] }` writes an explicit empty `verify` whenever the template omits the key. After install, hooks treat the phase as `EMPTY` and skip project checks. Operators who forget `verify` in the template get a green agent clone instead of the required fail-closed remediation, contradicting the issue’s missing-vs-empty contract.

**Test:**

```ts
it("preserves missing verify through install so agent commits fail closed", async () => {
  // template JSON without a verify key (checks still present)
  // run coord install
  // read emitted config.json — expect !("verify" in config)
  // attempt commit in agent clone — expect block mentioning verify declaration
});
```

---

### 3. `githooks/lib/workspace-config.sh:102-104` (consumed at `githooks/pre-push:21-35`, `116-128`)

**Rule:** If `verify.prepush` is non-empty, push gating must not silently become a no-op because `workflowCriticalPrefixes` / `workflowCriticalFiles` are omitted or empty. Missing critical-path policy must fail closed, or a non-empty `verify.prepush` must always run.

**Failure:** Omitted critical-path fields parse as empty arrays. For a normal fast-forward push with a merge-base, `is_workflow_critical` never matches, so `run_verify` stays false and `verify.prepush` (even `["false"]`) never executes. A Go/Rust product can declare a failing prepush check and still push every change.

**Test:**

```ts
it("runs verify.prepush when it is declared even if workflowCritical* are absent", () => {
  // workspace config: verify.prepush = [{ name: "fail", argv: ["false"] }]
  // omit workflowCriticalPrefixes and workflowCriticalFiles
  // push one non-coordination file on issue-1/<agent>
  // expect: push blocked by verify.prepush
});
```

---

### 4. `src/install.ts:75-80` with `src/install.ts:120-126` and `src/setupWorkspace.ts:303-309`

**Rule:** Status reported after install must describe the product tree *after* all install writes. `--write-product` mutations must not be followed by a “zero tracked footprint” / empty `git status` claim.

**Failure:** `productStatusClean` is computed inside `setupWorkspace` before `runInstall` applies `--write-product` ignore/AGENTS writes. When those writes dirty the product, install still prints `Product master git status is empty (zero tracked footprint).` Operators (or automation) treat the product as clean when it is not.

**Test:**

```ts
it("does not claim an empty product status after --write-product", async () => {
  // install with --write-product
  // expect stdout not to claim empty git status / zero footprint
  // expect product `git status --porcelain` non-empty
});
```

---

### 5. `src/setupWorkspace.ts:274-279` (vs issue step “Create/sync”)

**Rule:** Re-running install against an existing agent clone must sync that clone to the product’s configured shared branch/remote (or refuse with an explicit non-sync error). “Sync” is part of the install contract, not only first-time clone creation.

**Failure:** If `<product>-<agent>` already exists and is clean, install rewires hooks/config but never `fetch`/`reset` to `origin/<sharedBranch>`. Agents keep working on a stale tree while the owner believes install refreshed the workspace. Drift that `scripts/setup_common.sh` previously corrected now persists across installs.

**Test:**

```ts
it("syncs an existing clean agent clone to origin shared branch on install", async () => {
  // product main advances one commit after the agent clone was created
  // re-run coord install
  // expect agent clone HEAD == origin/main (or documented refusal)
});
```

---

## Test gaps (no separate finding above)

- No test that **missing** top-level `verify` blocks commit/push on an agent clone (only installRoot-missing and happy-path verify are covered in `test/hookSync.test.ts`).
- No non-Node fixture install that proves a failing declared `verify.precommit` blocks commit (acceptance criterion).
- No coverage that tier-2 verify pass + tier-3 `checks` fail journals which tier blocked PR creation (may be orthogonal to this branch; still an open acceptance item).

## Residual risk

Dogfood clones that still use `core.hooksPath=githooks` (tracked bodies) behave differently from the revised Option C default (`.git/hooks` shims). Install unsets `core.hooksPath` for new wiring; existing operator clones need an explicit reinstall to match the reviewed design.

# Code review: Codex implementation for issue 4

- Reviewed branch: `origin/issue-4/codex`
- Reviewed tip: `809fe096540d48d623fe934e9b200b49bb19b15c`
- Baseline: `origin/main` (merge-base with the tip)
- Reviewer: Cursor

## Verdict

The Option C shape is largely right: default install leaves product `git status` clean, agent shims live in `.git/hooks/`, missing `coord.installRoot` fails closed for commit/push in shim mode, and runtime `verify` correctly distinguishes missing vs explicit empty once the workspace file is honest. Empty `workflowCritical*` correctly means “all paths critical” in `verify.mjs`. The serious hole is install minting an explicit empty `verify` whenever the key is absent. Secondary issues are identity-fail-closed bodies planted under `--write-product --vendor`, and a predictable pre-push tempfile.

## Findings

### 1. `src/setupWorkspace.ts:288`

**Rule:** Missing top-level `verify` must stay distinct from an explicit `{ precommit: [], prepush: [] }` opt-out. Only the explicit empty object may allow ungated agent commits/pushes. Install must not synthesize the opt-out.

**Failure:** `verify: policy?.verify ?? { precommit: [], prepush: [] }` runs on every install, including when `--config` omits `verify` and when a reinstall reads an existing workspace that never declared it. Agent `pre-commit` then sees an object with empty arrays and exits 0. A forgotten or deleted declaration becomes a silent allow-list. Runtime `verify.mjs` would have failed closed on a truly missing key.

**Test:**

```ts
it("preserves missing verify through install so agent commits fail closed", () => {
  // policy.json has checks/agents/etc but omits verify
  installWorkspace({ configSource: policy, ... });
  expect(readConfig(configPath).verify).toBeUndefined();
  // agent clone commit must fail with "no verify declaration"
});
```

---

### 2. `src/setupWorkspace.ts:152-190` (`copyProductVendor` via `installProductFiles`)

**Rule:** Human product clones must not gain coordination hooks that fail closed without `consensus.agentId` (issue §0 / “loaded gun”). Opt-in product writes must stay inert for ordinary `core.hooksPath=githooks` layouts, or install must refuse that combination.

**Failure:** `coord install --write-product --vendor` copies canonical `githooks/*` bodies (which call `consensus_load_identity` and fail closed when `agentId` is unset) into the product tree. A product that already uses `core.hooksPath=githooks` then blocks every human commit with “consensus.agentId is missing,” even though this is the human product clone.

**Test:**

```ts
it("keeps a hooksPath=githooks human product clone commitable after --write-product --vendor", () => {
  // product: core.hooksPath=githooks, empty githooks/
  installWorkspace({ writeProduct: true, vendor: true, ... });
  // human commit on --product worktree must succeed (or install must refuse)
});
```

---

### 3. `templates/hooks/shim.sh:38-41`

**Rule:** Pre-push stdin capture must not use a predictable path under a shared `TMPDIR`/`/tmp`.

**Failure:** Path `${TMPDIR:-/tmp}/coord-pre-push.$$.input` is attacker-guessable on multi-user hosts. A pre-planted symlink can redirect the ref-list write/read and alter which refs the canonical hook validates.

**Fix sketch:** `input="$(mktemp "${TMPDIR:-/tmp}/coord-pre-push.XXXXXX")"` (exclusive create) before `cat >"$input"`. A pure unit test cannot express the race without a hostile filesystem fixture.

## Material test gaps

- No coverage that `--config` without `verify` preserves absence / fails closed (only paths that end with an empty allow-list are easy to hit today).
- No coverage that reinstall does not resurrect an empty allow-list after `verify` was removed.
- No acceptance test that `--write-product --vendor` leaves a `hooksPath=githooks` human product clone commitable.
- No push-path test that a declared failing `verify.prepush` blocks a real `git push` (hooks are mostly invoked via direct spawn on the shim).

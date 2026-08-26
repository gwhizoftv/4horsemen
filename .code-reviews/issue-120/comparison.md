# Issue 120 — Implementation comparison

Bound pins:

- claude: `d198c34682ddaafd3967d8c2ea94f9761ece9fae` (`.signals/issue-120/implementation-ready-claude.json`)
- cursor: `64a9e958421d067fcf5e23d399fd9471a18abe20` (`.signals/issue-120/implementation-ready-cursor.json`)
- codex: `4b17f983a143f21f57bb1cace7d61e9d58cc1a1e` (`.signals/issue-120/implementation-ready-codex.json`)

Selected plan: Claude `6cf79d06be8623a8b264dd4345572e341a990bf0` at `.plans/issue-120/plan.md`.

## Comparison

All three pins share the required shape: a discard-only `makeAgentClonesBaseReady` beside `prepareAgentIssueBranches`, lift → conditional `reset --hard`/`clean -fd` only on `issue-N/<agent>` → checkout base → `restoreProtocol` in `finally`, called from `detachCompletedIssue` after UI tear-down, plus a wipe-issue path that can discard matching issue-branch WIP without `--force`. Live `prepareAgentIssueBranches` dirty refusal is untouched. The decisive differences are batch vs per-clone refusal on completion, how hard `origin/<base>` is enforced, and whether wipe keeps a truthful “Nothing has been changed” preflight.

### Pin sketches

- **claude (`d198c34682ddaafd3967d8c2ea94f9761ece9fae`)** — Richest helper: read-only `readinessPlanFor` preflight, `baseTip`/`baseSynced` audit fields, and `checkoutBase` that refuses to move a local base backwards when it would orphan commits. Batch-aborts the whole readiness pass when any clone has unauthorized dirt. Wipe calls the helper for all clones when dirty, relying on that batch abort so the later refuse message stays true. Post-detach CLI reporting is clear.

- **cursor (`64a9e958421d067fcf5e23d399fd9471a18abe20`)** — Closest to the selected plan’s per-clone refuse-and-continue completion semantics. Wipe preflights ambiguous dirt before any mutation, then only cleans authorized dirty rows. Uses `checkout -B <base> <tip>` with a local-base fallback when origin is missing. Thinner audit surface (no `baseSynced`); summary line over-counts “cleaned” as any `checked-out` action.

- **codex (`4b17f983a143f21f57bb1cace7d61e9d58cc1a1e`)** — Explicit `finished-issue-only` / `force-wipe` and `continue` / `refuse-all` policies. Completion defaults to per-clone continue; wipe uses `refuse-all` and replaces the old reset/checkout loop with helper + ref prune. Requires a successful `fetch` and resolves only `origin/<base>` (no silent local fallback). Postcondition asserts HEAD equals the fetched origin tip.

### Findings

1. `src/prepareAgentBranch.ts` (claude `d198c34682ddaafd3967d8c2ea94f9761ece9fae`, lines 464–473): completion readiness must clean each eligible clone independently; one clone’s unauthorized dirt must not block discard of another’s matching `issue-N/<agent>` WIP. Claude’s batch abort returns `refused` for every non-skip plan whenever any clone is unauthorized, so two dirty issue-branch clones stay dirty because a third has edits on `main`, and the next `coord M` still hits the start dirty gate — the post-#110 failure mode this issue exists to remove. Cursor (`64a9e958…` lines 299–314) and Codex default `continue` (`4b17f983…` lines 366–378) refuse only the offending clone. Illustrative test: three clones — two dirty on `issue-9/<agent>`, one dirty on `main` — assert the two issue clones end clean on base and only the third is `refused`.

2. `src/prepareAgentBranch.ts` (cursor `64a9e958421d067fcf5e23d399fd9471a18abe20`, line 362): checkout onto base must not silently rewrite a local base ref that carries commits not contained in `origin/<base>` unless the owner asked for force-wipe. Cursor always runs `checkout -B <base> <tip>`, so an agent clone whose local `main` has an unpushed commit loses that tip when completion cleanup lands on origin. Claude’s `checkoutBase` (`d198c346…` lines 308–319) checks ancestry and checks out the existing local base instead of moving it; Codex always rebinds to fetched `origin/<base>` (`4b17f983…` line 421) with the same orphaning risk as Cursor, but at least refuses when fetch/origin tip cannot be established. Illustrative test: local `main` ahead of `origin/main`, clean issue branch → after readiness, `main` tip is unchanged (Claude) or the behavior is an explicit documented refuse — not a quiet `-B` rewrite.

3. `src/prepareAgentBranch.ts` (claude `d198c34682ddaafd3967d8c2ea94f9761ece9fae`, lines 314–317): acceptance requires participating clones end on the configured base **at** `origin/<base>` when origin is available. When `synced` is true but local base is not an ancestor of origin tip, Claude checks out the local base tip instead of origin, reporting success while HEAD ≠ `origin/<base>`. The next issue’s `startPoint` may still recover, but the completion audit claim “base-ready at origin” is false. Prefer Codex’s postcondition (`4b17f983…` lines 434–447) that HEAD equals the fetched origin SHA, or Cursor’s `-B` to origin when that tip resolves — without Claude’s silent “stay on diverged local main” success path.

4. `src/wipeIssue.ts` (cursor `64a9e958421d067fcf5e23d399fd9471a18abe20`, lines 232–248) vs claude (`d198c346…` lines 233–242): wipe’s non-force dirty gate must either discard only authorized issue-branch dirt after a mutation-free preflight, or refuse with nothing changed. Cursor’s ambiguous preflight is correct. Claude’s helper already batch-aborts, so calling it on all clones is safe for the message, but the same batch policy is what breaks completion (finding 1); wipe and completion need different batch policies (Codex `batchPolicy: "refuse-all"` only for wipe at `4b17f983…` `src/wipeIssue.ts` lines 247–254), not one global abort.

5. `src/cli.ts` (cursor `64a9e958421d067fcf5e23d399fd9471a18abe20`, lines 792–798): the completion summary must distinguish discarded WIP from a clean checkout-only move. Counting `action === "checked-out"` as “cleaned” overstates discards whenever a clean issue branch is merely moved to base. Claude counts `discardedPaths.length > 0` (`d198c346…` `src/cli.ts` lines 776–783); Codex similarly separates cleaned vs checked-out (`4b17f983…` lines 784–798).

6. `src/prepareAgentBranch.ts` (cursor `64a9e958421d067fcf5e23d399fd9471a18abe20`, line 340): `git clean -fd` failures must not be ignored after a successful `reset --hard`. Cursor uses non-throwing `git(...)` for clean while Claude/Codex use `gitOrThrow`. A partial clean can leave untracked evidence dirs, so the next `coord M` still refuses. Illustrative test: make `clean` fail (or leave an unremovable untracked path) and assert the helper surfaces failure rather than reporting `checked-out` with leftover porcelain.

### Recommendation

Prefer **codex** `4b17f983a143f21f57bb1cace7d61e9d58cc1a1e` as the merge base, with two must-fix notes before landing:

1. Keep completion on per-clone `continue` (already default) — do not adopt Claude’s global abort.
2. Decide explicitly whether diverged local `main` should `-B` to origin (today’s wipe behavior; matches Cursor) or refuse; do not ship Claude’s “success on diverged local base” path.

Codex alone separates wipe batch refusal from completion continue, requires a real fetched `origin/<base>`, and asserts the postcondition. Cursor is the best alternative if policy must stay closest to the selected Claude plan’s per-clone loop with minimal surface area, after fixing clean error handling and the cleaned-count summary. Claude’s audit/`checkoutBase` care is valuable but its completion batch abort is a functional regression against the issue’s per-clone goals and against Claude’s own plan-review finding on this point.

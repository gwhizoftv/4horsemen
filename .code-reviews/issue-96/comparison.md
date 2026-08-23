# Issue 96 implementation comparison

Bound pins compared:

- codex `4869a4b7c4a4f639c1e2915e5600198a749e438c`
- cursor `6121c0c17f4ebc60efc424f23f3526491079ca1c`
- claude `e61aad3d4af48938c05092532a25c9d453c54786`

All three converged on the same shape: export `ensureAgentsMdSkipWorktree` and
`cloneAgentsProtocolState` from `src/agentsProtocol.ts`, make `restoreProtocol`
total, wrap lift/checkout in `try/finally`, exempt an overlay-only `AGENTS.md`
from the dirty check, assert readiness before returning, add a `protocol` field
to the result, add a `BRANCH_PREPARED_NOTE` to every action via `buildOrder`,
and shorten the first step's task string. All three also bump `package.json` to
`0.0.17`, leave `test/install.test.ts:166` at `"0.0.16"`, and extend the
`test:fast` rewrite to cover that file — an identical, independently reached
answer to the same ship-gate collision.

Every claim below was executed, not read. I checked each pin out in a worktree,
ran the same fixture against all three, and quote the output.

## Comparison

### 1. codex `src/prepareAgentBranch.ts:44-56` and cursor `src/prepareAgentBranch.ts:39-57` — the overlay is destroyed on exactly the workspaces this issue is about

**Rule.** After branch preparation, a clone whose `AGENTS.md` is tracked must
carry the managed protocol block, not merely the index bit. The bit is the
mechanism that hides the overlay; it is not a substitute for it. The lift
(`liftCloneAgentsProtocol`, `src/agentsProtocol.ts`) runs
`git checkout HEAD -- AGENTS.md`, so by the time restore is reached the overlay
is already gone and restore is the only thing that can put it back.

**Failure.** Both pins resolve an install root and, when none resolves, set the
bit and return `"bit-only"` without re-rendering anything:

```
codex  src/prepareAgentBranch.ts:45-49
  if (root === null || !existsSync(root)) { ensureAgentsMdSkipWorktree(clone); return "bit-only"; }

cursor src/prepareAgentBranch.ts:45-56
  if (tracked && root !== null && existsSync(root)) { ...overlay...; return "overlay"; }
  ensureAgentsMdSkipWorktree(clone); return "bit-only";
```

A vendored install records `coord.installRoot: null` by design
(`src/install.ts:372`, reason at `src/setupWorkspace.ts:508-515`,
`coord doctor` excuses the missing key at `src/doctor.ts:188`). So on a
`coord install --write-product --vendor` workspace neither pin can resolve a
root, the overlay is not restored, and the agent is launched onto the correct
branch with the bare product `AGENTS.md` and no protocol section at all — it
cannot see artifact formats, completion handling, or the prohibition on index
changes. That is issue 96 item 1 left unfixed on the workspace shape it most
applies to.

**Test.** I ran one fixture — tracked `AGENTS.md` carrying the overlay with the
bit set, no `coord.installRoot` in the clone, no `installRoot` argument —
against all three pins unchanged:

```ts
const outcome = prepareAgentIssueBranches({
  agents: [{ id: "claude", root: clone }],
  issue: 9,
  branchTemplate: "issue-{issue}/{agent}",
  baselineSha: baseline,
  baseBranch: "main"
  // no installRoot, and the clone has no coord.installRoot: the vendored case
});
expect(skipWorktree(clone)).toBe(true);
expect(readFileSync(join(clone, "AGENTS.md"), "utf8")).toContain("coordination protocol");
```

Result:

```
wt-codex   × protocol overlay: expected '# product v2\n' to contain 'coordination protocol'
wt-cursor  × protocol overlay: expected '# product v2\n' to contain 'coordination protocol'
claude     ✓ 1 passed
```

The clone is left holding the committed product file verbatim. claude
`e61aad3d4af48938c05092532a25c9d453c54786` passes because
`src/prepareAgentBranch.ts` captures the overlay *before* the lift
(`captureCloneAgentsProtocol`) and re-applies those bytes when no root resolves,
so the template is never needed to preserve an overlay that already existed.

Worth recording: codex's own plan review raised precisely this objection against
the claude plan — "the `bit-only` fallback declares a clone ready without its
protocol … A postcondition must require overlay presence as well as the index
bit; it must not treat `bit-only` as success" — and then shipped that behaviour.
The objection was correct; the capture fallback is what answers it.

### 2. cursor `src/prepareAgentBranch.ts:79` — the dirty scan throws instead of classifying, and the throw kills the run loop

**Rule.** `hasBlockingUncommittedChanges` is a classifier called before anything
is modified. It must answer yes or no. It runs inside
`prepareAgentIssueBranches` → `initializeEffects` → `runTick`, and `runTick`
rethrows everything that is not a `StateConflictError`
(`src/runLoop.ts:1290-1293`) into `run()`, which does not catch
(`src/runLoop.ts:1305-1311`).

**Failure.** The call is unguarded:

```ts
const stripped = removeManagedBlock(readFileSync(agentsPath, "utf8"), path, AGENTS_PROTOCOL_MARKERS);
```

`removeManagedBlock` → `locateBlock` throws `ManagedBlockError` when a begin
marker has no matching end marker (`src/productIgnore.ts:70-76`) — the case of a
human who deleted the closing comment, which is exactly the "AGENTS.md looks
wrong" situation the protocol tells agents to escalate rather than repair. The
coordinator then terminates instead of refusing that one clone.

**Test.** Same fixture, with the end marker removed from the worktree
`AGENTS.md` and the bit cleared, recording what escapes:

```
wt-codex   THROWN_NAME=Error  Refusing to check out issue branches: uncommitted changes in …
claude     THROWN_NAME=Error  Refusing to check out issue branches: uncommitted changes in …
wt-cursor  THROWN_NAME=ManagedBlockError  AGENTS.md has a coordination begin marker with no matching end marker…
```

codex `4869a4b7c4a4f639c1e2915e5600198a749e438c` and claude
`e61aad3d4af48938c05092532a25c9d453c54786` both wrap the call in `try/catch` and
fall through to the intended refusal. The smallest correction for cursor is the
same three lines.

### 3. cursor `src/prepareAgentBranch.ts:86-99` and claude `src/prepareAgentBranch.ts` — the readiness assertion ignores the overlay it was added to guard

**Rule.** The readiness assertion is the last thing between preparation and
`startEffects`/`tmux.ensureSession`. If `cloneAgentsProtocolState` returns
`overlayPresent`, the assertion is where that field earns its place.

**Failure.** cursor's `assertCloneReady` checks `state.tracked && !state.skipWorktree`
and the branch name, and never reads `overlayPresent` — `git grep overlayPresent`
on `6121c0c17f4ebc60efc424f23f3526491079ca1c` finds it only inside
`src/agentsProtocol.ts`, defined and returned but never consumed anywhere. The
same is true of claude `e61aad3d4af48938c05092532a25c9d453c54786`: its
`assertClonesReady` checks HEAD and the bit only. Both therefore certify the
finding-1 clone — bit set, protocol gone — as ready, and in cursor's case
nothing else catches it either.

codex is the only pin that wires the field in
(`src/prepareAgentBranch.ts:88`):

```ts
if (result.protocol === "overlay" && !state.overlayPresent) problems.push("managed AGENTS.md protocol is missing");
```

That is the right instinct and belongs in whichever implementation is chosen,
though the `result.protocol === "overlay"` guard is what lets codex's own
`bit-only` path slip past it. Dropping the guard — assert `overlayPresent`
whenever an overlay was present before preparation began — closes both halves.

### 4. All three pins — the instruction that actually sends agents off the branch is untouched

**Rule.** Issue 96 item 2 is that the agent must not try to create or leave its
branch. The instruction an agent reads first governs its first command.

**Failure.** None of the three changed-path lists contains
`scripts/setup_claude.sh`, `scripts/setup_codex.sh`, `scripts/setup_cursor.sh`,
or `scripts/setup_antigravity.sh`. Step 1 of every generated session-start
checklist is still `git checkout $SHARED_BRANCH && git pull $REMOTE_NAME $SHARED_BRANCH`,
with step 2 — decide whether this is automated or manual — underneath it
(`scripts/setup_claude.sh:49-53`, and the same line at
`scripts/setup_cursor.sh:62`, `scripts/setup_codex.sh:75`,
`scripts/setup_antigravity.sh:62`). The generators are outside the approved file
map, so this is a scope boundary rather than an oversight by any one
implementation, but the issue is not closed until it moves.

Of the three, only claude `e61aad3d4af48938c05092532a25c9d453c54786` states the
contradiction explicitly in the installed overlay — "do not check out or pull
the shared branch first" — which is the sentence that directly opposes the stale
step 1. codex's and cursor's wording forbids creating or switching the issue
branch but not the base-branch checkout that starts the problem.

### 5. Shared, non-differentiating: `pnpm check` mutates tracked files mid-run on all three pins

All three extend the `test:fast` wrapper to rewrite the version literal in
`test/cli.test.ts` and `test/install.test.ts` and restore both in a `finally`.
It is the only way to bump `package.json` for the ship gate
(`test/versionBump.test.ts`) without editing `test/install.test.ts:166`, which no
pin is allowed to touch. It also widens the workaround `be82d90` introduced and
already flagged as owner-directed debt. No pin is better or worse here; the
underlying problem — hardcoded version literals in files a mid-issue bump
invalidates — survives this issue in all three.

### Verification performed

Per pin, in a detached worktree at the exact bound SHA: `tsc -p tsconfig.json`
and `tsc -p test/tsconfig.json` clean, `eslint src test` clean, and
`test/prepareAgentBranch.test.ts test/runLoop.test.ts test/agentLanguage.test.ts test/action.test.ts`
green (codex 68 passed, cursor 70 passed). The end-to-end canary
(`vitest --config vitest.e2e.config.ts`) passes on all three. Each pin's own
suite passes; findings 1-3 are gaps in coverage, not red tests. `test/doctor.test.ts`
and the install/onboard suites could not be run in the peer worktrees because
they shell out to `pnpm build`, which fails against a symlinked `node_modules`;
that is an artifact of my harness and is not attributed to either peer.

Note on cursor's `installRoot ?? defaultInstallRoot` on the resume path
(`src/runLoop.ts:462,479`): I had found that synthesising an install root breaks
the canary by rendering an overlay into clones never installed against it, whose
untracked `AGENTS.md` an agent's `git add -A` then sweeps into its pin. Cursor's
pin does not hit that, because its `tracked` gate at
`src/prepareAgentBranch.ts:45` suppresses the write in exactly that fixture. The
protection is incidental rather than intended, but the canary passes and I am
not raising it as a defect.

### Conclusion

Ranked on what issue 96 asked for: claude
`e61aad3d4af48938c05092532a25c9d453c54786` is the only pin that keeps the
protocol overlay across preparation when no install root resolves, which is the
vendored-workspace case at the centre of item 1, and it is tied with codex
`4869a4b7c4a4f639c1e2915e5600198a749e438c` on dirty-scan robustness. codex is
otherwise equivalent and has the better readiness assertion. cursor
`6121c0c17f4ebc60efc424f23f3526491079ca1c` carries both the overlay-loss defect
and a `ManagedBlockError` that terminates the coordinator, and is the weakest of
the three.

The merge worth shipping is claude's capture-based restore plus codex's
`overlayPresent` cross-check in the readiness assertion with its
`protocol === "overlay"` guard removed, and cursor's `removeManagedBlock` call
wrapped. Item 2 remains open in all three until the four `scripts/setup_*.sh`
generators can be reached.

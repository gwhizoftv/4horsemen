# Comparison of the issue 170 implementations (after the roster change)

Bound implementation pins:
- claude `1fe1bfe6a4e39975a5a4150a7e58aa14e37ceb6f`
- cursor `f0fd12fb598086d13516ecdca5c90156e14a2a85`

Both were read from the exported worktrees, with no product suite run for this comparison. The claude pin is mine. It is the revision that went through three rounds of review, unchanged since round 3, and its commit-hook `check:fast` (620 fast and 177 system tests) and push-hook `test:e2e` passed when it was committed. Line numbers refer to each pin's worktree.

## Comparison

### Shared ground

Both implement the selected plan:
- a frozen `verification` policy in `start.json`
- hook binding read from the committed or single pushed ref, with no `githooks/` edits
- a candidate gate that rejects failures, so the agent receives a reissued action with the command and its log
- a shared runner with coordinator-owned receipts keyed on the declared argv
- an expensive-command limiter
- diagnostic-only retries
- receipt skipping at finalization
- the `test:system` tier

Both stay within the approved file map, reuse #162's classifier and measurement path, and extend the existing suites.

### cursor `f0fd12fb598086d13516ecdca5c90156e14a2a85`

This pin repeats the earlier cursor implementation's design and does not take up the defects found across the three review rounds.

**K1. `src/verificationReceipts.ts:154-169` and `:206-216`: lock reclaim and release.**
- *Rule:* single-flight and the expensive limit must never admit two live owners, and a release may remove only the releaser's own lock.
- *Failure:*
  - `isStale` reclaims any lock older than six hours even when its owner is alive on this host.
  - `releaseLock` then unconditionally unlinks the path (line 213), deleting a replacement owner's lock.
  - Together they let three live suites run under `maxConcurrentExpensive: 1`.
- *Test:* a lock owned by `process.pid` with `startedAt` older than 6 h must make `acquireLock` return `null`.

**K2. `src/verificationRunner.ts:273` and `:303-306`: unchecked inputs behind a receipt.**
- *Rule:* a receipt certifies the inputs the command actually ran against, including installed dependencies (issue §4).
- *Failure:*
  - Nothing checks tracked files after a command, and nothing keys or re-checks dependency state.
  - An uncached `install` or a probe that rewrites `src/` lets the cached `lint` pass on modified bytes, and the receipt is stored under the clean pin's identity.
  - Changed installed packages with an unchanged lockfile reuse a stale pass.
- *Test:* a preceding command writes to `src/a.ts`. The run must fail, or at least write no receipt.

**K3. `src/changeClassification.ts:162` with `src/state.ts:344-368`: dedupe by name.**
- *Rule:* every command a matching risk rule requires must run.
- *Failure:* a candidate `test` and a different final `test` may share a name, so a rule adding the final `test` is silently dropped.
- *Correction:* reject a same-name, different-argv pair in the schema.

**K4. `src/state.ts:323-326`: names must be unique even without `verification`.**
- *Rule:* absent `verification` preserves existing behavior.
- *Failure:* a config that is valid at baseline, with two checks of the same name, no longer loads, which breaks `coord start` and every hook in local mode.

**K5. `src/verificationRunner.ts:141-145`: key material.**
- *Rule:* the key comes from the real platform, and receipts never copy secret values.
- *Failure:* `COORD_PLATFORM`, `COORD_ARCH` or `COORD_NODE` in the environment replace the real platform in the key, and declared env values are written verbatim into receipt files.

**K6. `src/verificationRunner.ts:226-230`: unbounded join wait.**
- *Rule:* a waiting coordinator must not be held indefinitely by another runner, and it must not run the same key unlocked either.
- *Failure:* `while (keyLock === null)` polls forever while a live owner holds the key. The earlier 30-minute limit is gone, so a hung owner process stalls this coordinator's tick until it is killed.

**K7. `package.json:17`, with `config.example.json` `verify` and `coordinated`: manual coverage.**
- *Rule:* unchanged local policies keep their coverage (codex round-1 finding).
- *Failure:* `check:fast` drops the nine system files. A workspace whose live `verify` is `check:fast` / `test:e2e` silently stops running them on manual branches. Only the example's new `verify.prepush` adds them back.
- *Also:* `coordinated.precommit` is still `check:fast`, so bound hooks run the same list as local ones.

### claude `1fe1bfe6a4e39975a5a4150a7e58aa14e37ceb6f` (self-review)

Defects resolved through review rounds 1–3, each with a regression test in `test/verificationRunner.test.ts`:
- **Locks:** only reclaimed when the owner is proven gone, released by token comparison, and published with link(2).
- **Same-name conflicts:** rejected in the schema.
- **Env values:** stored as digests.
- **Join timeout:** returns `waiting` (`retry`), never running a key unlocked.
- **Tracked files:** any command, or a cache probe, that modifies them fails with its own log.
- **Dependency identity:** declared dependency paths are hashed when the command runs and re-checked afterwards. The worktree's own path is normalized out and escaping links are refused.
- **Coverage:** `check:fast` again covers the system tier.

**C1. `config.example.json`: residual gap in the example's dependency declaration** (codex's final round-3 point).
- *Rule:* every installed executable input of a cached command is in its key.
- *Failure:* the example declares `node_modules/.pnpm`, which holds the package files, but not the top-level `node_modules/.bin` shims and package links. A hand-edited shim with unchanged package files would reuse a stale pass.
- *Why it is confined:* those files are generated from inputs already keyed (lockfile and `package.json` in the tree, the pnpm version probe). Declaring all of `node_modules` would never reuse, because `.modules.yaml` and `.pnpm-workspace-state-v1.json` carry install timestamps and vitest writes `node_modules/.vite`.
- *Correction:* a follow-up that declares the shims and links precisely, or adds dependency excludes, with a test that edits a shim.

**C2. The tracked `AGENTS.md` is unchanged.** Agent clones cannot commit it because of the skip-worktree bit, so the coordinated-mode clause is only in `templates/product/AGENTS.protocol.md`.

### Scope and tests

Both stay in scope.
- **cursor** has the larger runner test file (421 lines), but it covers none of the review rounds' failure modes.
- **claude**'s tests cover each finding resolved across three rounds, plus a determinism check against two real frozen installs during round 3, recorded in that revision's signal history.

### Recommendation

**claude `1fe1bfe6a4e39975a5a4150a7e58aa14e37ceb6f`**, with C1 and C2 as follow-ups.

cursor `f0fd12fb598086d13516ecdca5c90156e14a2a85` still has the exclusion and receipt-integrity defects:
- the lock defects (K1)
- unchecked inputs behind a receipt (K2)
- the dropped requirement (K3)
- the config regression (K4)
- the unbounded wait (K6)
- the coverage regression (K7)

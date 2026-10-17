# Issue 234 — implementation comparison

Bound implementation pins:

- cursor `f6449d44305990a3620d2805b73a06096e33d5da`
- codex `ec02c6fc8c8ad68b0fcf8691b1ff93751651d6c0`
- claude `5acf3a9d6666cf71a2bbc30e99ddbfd7f47eb215`
- antigravity `980e57bcfba8f909c137199f7814c5e1e09850af`

All four stay on the selected-plan shape: a shared `scripts/lib/node-runtime.sh`,
`coord` selecting before build/exec with PATH preserved for the CLI process,
hook policy dispatching through the selector from `coord.cliEntry`, and
`canonicalSourceDigest` hashing the selector. No product suite was run for this
evidence-only comparison; findings below are from reading the bound worktrees.

## Comparison

### Shared approach

Each pin adds one POSIX selector, uses it from the root wrapper and bootstrap
after checkout, and replaces ambient `node` in `githooks/lib/policy.sh` with a
path derived from the recorded CLI entry (vendor-safe). Product `PATH` is not
rewritten for the coordinator process; only coordinator build subprocesses
prepend the selected Node directory. That matches the issue’s “use coord’s Node
without changing the workspace development Node” requirement for the primary
entry points.

### Decisive difference: generated callbacks

**codex** renders credential helpers, lifecycle hooks, shell-guard receivers, and
the Claude status-line tee through `coordNodeCommand()` →
`scripts/lib/node-runtime.sh` (`src/githubAuth.ts:37-41`,
`src/agentHookSync.ts:41-52`, `src/claudeStatusLine.ts:131`). Selection happens
again at callback time, so an nvm patch upgrade that retires
`.../v26.x.y/bin/node` does not leave clones pointing at a deleted binary.

**cursor**, **claude**, and **antigravity** bake `process.execPath` into those
same surfaces (`src/githubAuth.ts:36-37` / `:40-41`,
`src/agentHookSync.ts:40-50` / `:42-52`, `src/claudeStatusLine.ts:130`). That
follows the selected plan’s literal wording but keeps the durability failure
plan reviews already named.

1. **cursor `src/githubAuth.ts:36-37` (same pattern in claude `src/githubAuth.ts:40-41` and antigravity `src/githubAuth.ts:36-37`; also `src/agentHookSync.ts` lifecycle/guard/status-line renderers and `src/claudeStatusLine.ts:130`)**  
   **Rule:** Coordinator callbacks that persist in clone Git config and harness
   hook JSON must keep working across ordinary Node patch upgrades without a
   mandatory re-onboard, or must re-select a qualifying Node at run time.  
   **Failure:** After `nvm install 26 && nvm uninstall <old-patch>` (or Homebrew
   cleanup of a Cellar path), every saved
   `!/…/v26.old/bin/node '…/dist/main.js' auth git-credential …` and every
   lifecycle/guard/status-line command exits 127 under the product launcher’s
   Node 16 PATH; private HTTPS mirror fetch and agent `git commit`/`push` fail
   until reinstall.  
   **Smallest test:** Render `gitCredentialHelperCommand`, delete/rename the
   baked `process.execPath` file in a fixture, run the helper with
   `COORD_NODE`/nvm pointing at a live Node 26; expect success only if the
   command goes through `node-runtime.sh` (codex’s assertion shape), not a
   dead absolute Node path.

### Other pin-specific notes

2. **cursor / claude / antigravity vs codex — callback wiring reuse**  
   Codex centralizes the selector path in `coordNodeCommand()` and imports it
   from `githubAuth` into hook renderers, so credential and lifecycle strings
   cannot drift. The other three duplicate `process.execPath` quoting at each
   call site; a future fix must touch every renderer. Prefer codex’s single
   helper (or an equivalent next to `coordCliEntry`).

3. **claude `scripts/lib/node-runtime.sh:31-32` (`node_version` probes with `</dev/null`)**  
   **Rule:** Selector probes must not consume stdin meant for `hook-verify`
   pre-push ref lists or credential-helper protocol input.  
   **Failure if probes inherit stdin and a future/quirky Node read it:**
   pre-push or `git credential` payloads are truncated before the selected
   Node runs the CLI. Cursor (`scripts/lib/node-runtime.sh:23`) and codex
   (`scripts/lib/node-runtime.sh:16`) omit the redirect; antigravity likewise.
   Claude’s `/dev/null` probe is the safer pattern; adopt it in the winner.

4. **codex omits `scripts/setup_common.sh`; the other three edit `common_configure_trust`**  
   Plan reviews already treated that legacy setup path as out of the live
   `coord onboard`/`install` surface. Codex’s omission is the tighter scope;
   cursor/claude/antigravity’s edits are harmless if present but not required
   to finish the issue.

5. **Scope and reuse**  
   All four reuse the existing wrapper symlink loop, `writeFixture` /
   bootstrap fixtures, and marker-based hook/credential sync. Each adds only
   the justified `scripts/lib/node-runtime.sh`. Codex’s runtime-callback choice
   is the only material behavior win over the others; cursor/claude/antigravity
   are otherwise comparable multi-entry fixes that still leave the baked-Node
   durability hole.

### Ranking for selection

1. **codex `ec02c6fc8c8ad68b0fcf8691b1ff93751651d6c0`** — complete entry-point
   coverage with run-time selector in persisted callbacks; best durability.
2. **claude `5acf3a9d6666cf71a2bbc30e99ddbfd7f47eb215`** — solid selector and
   stdin-safe probes; still bakes `process.execPath`.
3. **cursor `f6449d44305990a3620d2805b73a06096e33d5da` / antigravity
   `980e57bcfba8f909c137199f7814c5e1e09850af`** — same architectural gap as
   claude on callbacks; antigravity additionally preflights
   `node-runtime.sh --print-path` inside `coord_cli_entry` (fail-closed early,
   extra cost per hook).

**Verdict:** Prefer **codex**. If revising another pin, replace every baked
`process.execPath` in rendered commands with the install’s
`scripts/lib/node-runtime.sh` (codex’s `coordNodeCommand`), and redirect
version probes from `/dev/null` as claude does.

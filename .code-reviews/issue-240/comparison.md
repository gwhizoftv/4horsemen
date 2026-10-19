# Issue 240 — implementation comparison

Bound pins:
- codex `613dfd04d651c73b180a1033753e6c974dc45301`
- muse `2f48a6b3cdc68d2a8c7ac32e84d37b13a24f725d`
- cursor `76db847bd32cde6a0adb55d5a68792caf23270bb`
- claude `16dd9d5a4e1242ff63dd36250caf9c24ff564626`

## Comparison

All four implementations follow the selected Claude plan’s shape: shared
`launcher_environment` + `launcher_executable`, `coord_agent_cmd` for
maintenance and generated `exec` lines, vendor lookup preferring coord’s Node
(via `coord.cliEntry` → `node-runtime.sh --resolve`) and Antigravity/Muse
`$HOME/.local/bin`, product `.nvmrc` still applied for the pane’s child PATH,
and focused extensions of `test/cli.test.ts` / `test/install.test.ts` plus
`docs/coord-driver.md`. No unnecessary new product files. Differences are in
lookup timing, maintenance PATH, failure hardness, and how strongly tests lock
the dual contract (coord Node for update children vs product Node for launch
children).

### Ranking (strongest first)

1. **codex `613dfd04`** — Resolve-before-`nvm` with a post-`nvm` fallback;
   maintenance prepends `dirname(coord_agent_node)` so updater children see
   Node >=26; launch leaves product PATH intact. Broadest real-bash matrix
   (coord / home / pinned-only / missing-nvm / muse / env immutability) and
   asserts `v26.1.0` on update vs `v16.18.0` on launch.
2. **claude `16dd9d5a`** — Same maintenance PATH prepend and the same dual
   Node assertions in tests; uses a bare `GIT_DIR` for `coord.cliEntry` so
   start does not refuse dirty clones. Lookup runs after `nvm use` but still
   searches `coord_bin:pre_nvm` first, then post-`nvm` PATH — functionally
   close to codex’s fallback, slightly further from the plan’s
   resolve-before-`nvm` wording.
3. **muse `2f48a6b3`** — Clean resolve-before-`nvm` and careful shebang cases;
   fixture install layout for `node-runtime.sh`. Missing maintenance PATH
   prepend and no assertion that update children see coord’s Node.
4. **cursor `76db847b`** — Same core binding as muse/claude, but the same
   maintenance PATH gap as muse, a looser `#!*node*` shebang match, and tests
   that only check vendor *labels*, not interpreter versions.

### Findings

1. **cursor `76db847b` — `src/cli.ts` (~178–180) and muse `2f48a6b3` —
   `src/cli.ts` (~178)**  
   Maintenance runs `launcher_environment` then `exec "${coord_agent_cmd[@]}"`
   with no `PATH` prepend of `dirname(coord_agent_node)`.  
   **Rule:** Agent update must run under coord’s required Node, including bare
   `node` / `npm` children of shell vendor wrappers (issue 240; plan-review
   finding that shebang wrapping alone is insufficient).  
   **Failure:** A non-Node-shebang `claude` resolved from the pre-`nvm` PATH
   still inherits the product pin’s Node 16 after `nvm use`, so
   `claude update` can keep failing with “native binary not installed” while
   the pane’s absolute `coord_agent_cmd` looks “fixed.”  
   **Test:** Extend the nvm-setup fixture so the vendor stub logs
   `$(node --version)` and expect `v26.x` on update/`--version` lines (as
   codex/claude already do).

2. **claude `16dd9d5a` — `scripts/lib/launcher.sh:61–77`**  
   Product `nvm use` runs before `command -v` on
   `PATH="$coord_search:$PATH"`.  
   **Rule:** Vendor resolution must not depend on the product pin’s bin for the
   *preferred* install (selected plan: resolve beside coord’s Node before
   `.nvmrc`).  
   **Failure:** If `coord_search` fails to include a healthy coord-side binary
   (missing `coord.cliEntry`, selector warning path), the appended post-`nvm`
   PATH can still select `…/node/v16…/bin/claude` as the primary hit—the same
   broken shim the issue reported—before any shebang rewrite helps. Codex’s
   resolve-then-fallback order makes the preferred search independent of `nvm`
   succeeding.  
   **Fix sketch:** Perform `command -v` on the pre-`nvm` search path first (as
   muse/cursor/codex), then optionally fall back to post-`nvm` PATH.

3. **codex `613dfd04` — `scripts/lib/launcher.sh:30`**  
   `coord_agent_node="$("$selector" --resolve)" || return 1`.  
   **Rule:** Fresh-start maintenance warns and continues when a vendor step
   fails (`updateAgentVersions` in `src/cli.ts`); a missing/unusable selector
   must not abort the whole `launcher_environment` when a PATH fallback still
   works.  
   **Failure:** A temporarily broken `node-runtime.sh` or invalid ambient
   `COORD_NODE` turns into a hard launcher/maintenance failure instead of the
   documented warning + pre-`nvm` PATH resolution used by muse/cursor/claude.  
   **Test:** Fixture where `--resolve` exits non-zero but a vendor stub remains
   on the owner PATH; expect warn-and-continue (or launch) rather than
   `launcher_environment` return 1.

4. **cursor `76db847b` — `scripts/lib/launcher.sh:72–73`**  
   Shebang gate is `case "$first" in "#!"*node*)`.  
   **Rule:** Only plain Node interpreters should be re-wrapped; unrelated
   shebangs that merely contain the substring `node` must stay intact.  
   **Failure:** A pathological `#!…node…` line that is not an env/node
   interpreter gets `coord_node` prepended and can break a native/wrapper CLI.  
   **Fix sketch:** Use muse’s or codex’s tighter patterns
   (`/env node`, `/node` end-anchored, or codex’s regex).

5. **claude `16dd9d5a` — `scripts/lib/launcher.sh:22–27` (`launcher_executable`)**  
   Default arm is `*) printf '%s\n' "$1"`.  
   **Rule:** Unknown agent ids must not get a generated launcher (other pins
   `return 1`).  
   **Failure:** `write_launcher` for a typo id emits
   `launcher_environment "typo" "typo"` and a failing `exec` instead of refusing
   generation.  
   **Test:** `launcher_executable unknown` / `write_launcher` returns non-zero.

### Scope and reuse

All four stay inside issue 240, reuse `node-runtime.sh`, existing maintenance
argv shape, and the nvm-setup fixture style, and avoid new modules. Codex and
claude add the most valuable assertions (interpreter identity on update vs
launch). Muse’s private fixture install copy is justified isolation. Cursor’s
coverage is the thinnest relative to the failure mode.

### Verdict

Prefer **codex `613dfd04`** as the comparison winner: it matches the selected
design, keeps product PATH for panes, forces coord Node for maintenance
children, and proves both with the broadest tests. **claude `16dd9d5a`** is a
close second (same maintenance prepend and dual Node checks; minor
resolve-after-`nvm` and `launcher_executable` defaults). **muse** and **cursor**
need the maintenance PATH prepend (finding 1) before they fully close the
reported update failure for non-shebang vendor wrappers.

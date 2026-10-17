# Issue 234 — plan review (cursor)

Bound plans reviewed (pins from action):

- cursor `950af137fa180b8f0d8a5a8805c4b4a0ac836b0d`
- codex `f42cecbaffc98d1d980eef1294b803e6a16844dc`
- claude `b41d415ef1dadbd91982d4410e16a38e6f63af9c`
- antigravity `0802da2c9c4f98e5517c3fa55e14e73a1d443c3a`

All four correctly place the first gate before any `dist/*.js` load (the reported
`node:readline/promises` failure cannot be fixed inside `src/main.ts` /
`src/cli.ts`). Divergence is whether only the root `coord` wrapper is enough,
how Node is discovered (source `nvm` vs probe installed binaries), and whether
generated `/usr/bin/env node` callbacks and hook policy must move in the same
issue.

## Findings

1. **cursor — Exact File List step 3 (“subshell or explicit cd” + `nvm use`) and Risks (“PATH mutation … Acceptable”)**  
   **Rule:** A successful nvm fallback must actually change which Node runs the CLI, and the issue requires leaving the workspace development Node on `PATH` for product work that coord later spawns.  
   **Failure if followed as written:** If `nvm use` runs in a subshell, PATH changes are discarded and the parent still `exec node`s the workspace Node 16, so `coord onboard` keeps failing. If `nvm use` runs in the wrapper process without restoring PATH, the `exec`’d CLI inherits Node 26 first on `process.env.PATH`, so product verification / child tools silently leave the workspace Node.  
   **Correction:** Resolve an absolute Node path (probe / `nvm which` / `versions/node/...` inside a subshell if needed), then `exec "$NODE_BIN" ...` with the original PATH unchanged; do not leave a sourced-nvm PATH on the CLI process.

2. **cursor and antigravity — file lists limited to `coord` + `test/wrapper.test.ts`**  
   **Rule:** Onboarding and later clone work still invoke coordinator JavaScript through ambient Node: `src/githubAuth.ts` renders `!/usr/bin/env node <cliEntry> ...` credential helpers, `githooks/lib/policy.sh` runs `node "$entry" hook-verify|hook-scope`, and agent lifecycle / shell-guard / status-line commands use `/usr/bin/env node`. Product launchers then run `nvm use` against the product `.nvmrc` before the harness.  
   **Failure if followed as written:** The wrapper can start onboard under Node 26, then Git credential helper or an installed hook / lifecycle callback still launches `env node` under the product’s Node 16 and reproduces `ERR_UNKNOWN_BUILTIN_MODULE` (or the same class of failure) without touching the wrapper again.  
   **Correction:** Prefer claude/codex’s multi-entry approach: one pre-JS resolver plus routing for wrapper, hook policy, and rendered callbacks (absolute selected Node or a small `scripts/coord-node` / `scripts/lib/node-runtime.sh`), without rewriting the caller's PATH for product children.

3. **codex — Exact File List / Reuse: change `scripts/setup_common.sh` (`common_configure_trust`)**  
   **Rule:** Implementation must stay within the issue and reuse live entry points; paths justified only as necessary for the failure mode.  
   **Failure if followed as written:** `src/` does not call `common_configure_trust` / `setup_common.sh`; those scripts are legacy agent-setup helpers. Editing them expands the file map and test surface without fixing `coord onboard`, hooks, or rendered callbacks on the active driver path.  
   **Correction:** Drop `scripts/setup_common.sh` from the map unless a bound caller on the onboard/install path is shown; keep trust configuration on the TypeScript install path already covered elsewhere in that plan.

4. **codex — Implementation behavior §6 / Risks (“Removed pinned installations”): bake `process.execPath` into generated commands**  
   **Rule:** Coordinator callbacks must keep working across ordinary Node patch upgrades without forcing a full re-onboard, or the plan must make regeneration mandatory and automatic before first use.  
   **Failure if followed as written:** nvm paths are versioned (`.../versions/node/v26.x.y/bin/node`). After `nvm install 26` retires the old patch directory, every saved credential helper and lifecycle/guard/status-line command still points at the deleted binary and fails until the owner re-runs install/onboard—exactly when agent panes and Git auth need coord most.  
   **Correction:** Follow claude’s run-time resolver in rendered commands (`scripts/coord-node` or equivalent) so each invocation re-selects a qualifying Node; keep marker-based sync for migrating old `/usr/bin/env node` strings.

5. **antigravity — Reuse and Scope step 3 (scan with `sort -Vr`) and Alternatives (add `fnm which`)**  
   **Rule:** Shell used on the reporter’s platform (macOS `/bin/bash` 3.2) must stay portable; speculative version-manager probes need a justification tied to the issue.  
   **Failure if followed as written:** Relying on `sort -Vr` for version order is a GNU-shaped dependency; a numeric compare without `sort -V` (as claude/codex require) is the portable rule already used elsewhere in these plans. Adding `fnm` probing widens hermetic test matrix and host leakage without being required by the frozen report (PATH + nvm + `COORD_NODE` already cover the stated remedies).  
   **Correction:** Pick highest qualifying nvm candidate with portable major/minor/patch compare; keep non-nvm managers on PATH or `COORD_NODE` only.

6. **claude — Exact file list / Reuse: omit `scripts/bootstrap.sh` while adding `scripts/coord-node`**  
   **Rule:** Every coordinator install/build entry that can still run under ambient Node 16 before driver JS loads should either use the resolver or be explicitly out of scope with a reason that survives the same workspace.  
   **Failure if followed as written:** A fresh `scripts/bootstrap.sh` run inside a Node 16 product shell (after clone, or against an existing install root) still calls `pnpm install` / `pnpm build` with ambient Node before any `coord` wrapper runs, reproducing a broken install/build even though day-to-day `coord` is fixed. The plan’s “before any coord file exists” rationale covers only the pre-clone curl path, not post-clone bootstrap against an existing tree.  
   **Correction:** Either adopt codex’s scoped bootstrap PATH prefix once the checkout exists, or state bootstrap as owner-prerequisite-only with an explicit early Node 26 check that fails closed (bootstrap already mentions Node 26 in prose—enforce it before pnpm).

## Conclusion

Select a plan in the claude/codex family: one pre-JavaScript selector, absolute Node for the root wrapper (build subprocess may prepend only that Node’s directory), unchanged caller PATH for the CLI process, and the same selector (or its path) for hook policy and rendered `/usr/bin/env node` callbacks. Prefer claude’s run-time `scripts/coord-node` over codex’s baked `process.execPath` for generated commands, drop codex’s `setup_common.sh` edit, and do not ship cursor/antigravity’s wrapper-only maps as written—their nvm/PATH handling and missing callback coverage leave the reported class of failure in place after the first `exec`. Antigravity’s PATH-preserving `exec "$NODE_BIN"` shape is right for the wrapper alone but is not sufficient as the whole issue fix. No product tests were run for this evidence-only review.

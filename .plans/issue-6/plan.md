# Plan: Issue 6 - Operator Workflow Simplification

## Overview
This plan details the implementation of [Issue #6](https://github.com/gwhizoftv/coordination/issues/6), which simplifies the operator workflow by introducing a bootstrap script, a new `coord onboard` command with defaults, a flat runtime layout, and seamless GitHub issue integration for digests (removing the need for the owner to author a `plan.md` before starting).

## Requirements Addressed
- **R1:** `scripts/bootstrap.sh` for easy installation.
- **R2:** `coord onboard` command to simplify installation.
- **R3:** Flat single-product `coord-root` layout by default.
- **R4:** `coord <n>` (e.g., `coord 42`) resolves product and runs automatically.
- **R5 & R6:** Digest incorporates the GitHub issue content automatically instead of an owner pre-start file.

---

## File Map & Proposed Changes

### 1. `scripts/bootstrap.sh` (New)
**Goal:** Easy `curl | sh` installation without touching any product repositories.
- Create `~/.local/share/coordination` (or `$COORD_INSTALL_ROOT`).
- Clone the repository if missing; if it exists and is clean, fast-forward pull. Fail if dirty.
- Run `pnpm install --frozen-lockfile && pnpm build`.
- Output helpful error messages if `node` or `pnpm` are missing.
- Install `coord` wrapper script in `~/.local/bin/` pointing to the built CLI.

### 2. `src/cli.ts` (Modifications)
**Goal:** Support `onboard` and implicit `coord N`.
- **`onboard` command:** 
  - Defaults: `--coord-root` to `<product-parent>/coord-runtime`, `--agents` to `claude,codex,cursor,antigravity`, `--profile` to `consensus`, and `--clone-root` to `<product-parent>`.
  - Calls `install()` with these defaults.
  - Runs `doctor` afterward; if `doctor` fails, `onboard` exits with a non-zero code.
  - Stores a mapping (e.g., in `~/.local/share/coordination/active-product.json` or `.git/config` of the product) to allow `coord N` from anywhere inside the product tree to find its runtime.
- **`coord N` / `coord start N` enhancements:**
  - Intercept numeric positional argument as `start N` and `run`.
  - Fetch issue content via `gh issue view N --json title,body`.
  - Materialize this content into the runtime as the primary snapshot for `automationDigestMaterial`.

### 3. `src/setupWorkspace.ts` (Modifications)
**Goal:** R3 Flat single-product layout.
- Change `workspaceDirectory()` and `workspaceConfigPath()` logic:
  - Default fresh installs to dropping `config.json` directly in `coord-root` instead of `coord-root/workspaces/<project>/config.json`.
  - During resolution (e.g. `coord start`), resolve flat first, then fallback to `workspaces/` for backwards compatibility.

### 4. `src/state.ts` (Modifications)
**Goal:** Adjust schema and defaults.
- Default `digestPaths` should reflect the issue snapshot (e.g., `issue-{issue}/snapshot.md`) instead of `.plans/issue-{issue}/plan.md`.

### 5. `src/paths.ts` (Modifications)
**Goal:** Update issue paths.
- Add `snapshot: string` to `IssueRuntimePaths` referencing `issue-{issue}/snapshot.md` so the fetched issue data can be written prior to digest calculation.

### 6. Tests & Documentation
**Goal:** Match R7 & R8.
- Update `README.md` to reflect the new happy path: `bootstrap -> onboard -> gh issue create -> coord N`.
- Add integration tests for `bootstrap.sh` and the default `onboard` layout.

---

## Simplifications & Edge Cases
- **Symlinks & Flat Layout:** When resolving flat vs `workspaces/<project>`, prioritize flat if `config.json` exists at the root of `coord-root`.
- **Digest Migration:** Remove the hard crash when the owner's `plan.md` is missing. The primary source of truth becomes the GitHub issue snapshot fetched at start. Agents will generate their plans on their branches post-start as standard.

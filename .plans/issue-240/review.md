# Issue 240 — plan review

Pins reviewed:
- muse `289ccb9f71ea759c72a8011fb9730e12c7b9df44`
- cursor `b6795003b1eb3501e214dfb40041a278983b69c2`
- codex `3926ba07d27b27512435ca07e4b0e87f6de18ff4`
- claude `998ee7f73d1fbc36b3f5c5b956052ed0ef804249`

## Findings

1. **muse / codex — Conclusion and Reuse and Scope (maintenance-only; launchers keep product `nvm use` for vendor `exec`)**  
   **Rule:** Fresh-start maintenance and the generated launcher must resolve the same vendor installation (docs/coord-driver.md today; `test/cli.test.ts` “updates and launches the same … after nvm setup”), and the reported failure mode includes a Claude pane exit after the bad `PATH` selection, not only a warned update.  
   **Failure if followed:** `update`/`--version` may run under coord’s Node while `start-claude.sh` still runs `launcher_environment` → product `nvm use` → `exec claude` from `…/node/v16.18.0/bin`, so `agentVersions` can name a different install than the pane, and the pane can still exit with the same “native binary not installed” class of failure. Muse’s Risks section even accepts snapshot/pane divergence; Codex documents the same split.  
   **Correction:** Resolve (and, for Node-shebang CLIs, interpret) the vendor executable with coord’s Node before product `nvm use` affects `PATH`, and use that absolute/`coord_agent_cmd` form for both maintenance and `launcher_command` (claude’s design), instead of leaving product post-`nvm` lookup for launch.

2. **cursor — Exact File List / Design (prepend coord’s Node `bin` onto `PATH` inside shared `launcher_environment` after product `nvm use`)**  
   **Rule:** Coord’s Node selection must not replace the product’s Node for product subprocesses the agent runs (`scripts/lib/node-runtime.sh` header; `test/wrapper.test.ts` “product children keep their Node”).  
   **Failure if followed:** After launch, `node`/`npm` from coord’s `bin` sit ahead of the product pin for the whole pane, so product hooks and checks the agent runs (e.g. under the product’s `.nvmrc`) execute on Node >=26 instead of the pinned product runtime.  
   **Correction:** Keep product `nvm use` for the agent’s child `PATH`, but bind the vendor CLI before that mutation (resolve + optional `coord_node` + script argv), as in claude `998ee7f7` — do not leave coord’s `bin` permanently first on `PATH`.

3. **cursor — Risks (Antigravity/Muse home-local precedence)**  
   **Rule:** For antigravity/muse, `$HOME/.local/bin` must stay ahead of other candidate bins when resolving `agy`/`muse` (current `launcher_environment`; existing nvm-setup fixture expects `home` for antigravity).  
   **Failure if followed:** Inserting coord’s Node `bin` with `PATH="$coordBin:$PATH"` after the home-local export puts coord ahead of `~/.local/bin`, so a decoy `agy` beside coord’s Node wins and the “same home installation” contract regresses.  
   **Correction:** Search/precedence must keep home-local first for those agents (claude/codex), with coord’s Node used for interpreter / non-home vendor lookup only.

4. **muse / cursor / claude — Tests (vitest config named for `test/cli.test.ts`)**  
   **Rule:** Focused commands in the plan must actually execute the named suite. `vitest.config.ts` excludes `test/cli.test.ts`; that file runs under `vitest.system.config.ts`.  
   **Failure if followed:** `pnpm vitest run --config vitest.config.ts test/cli.test.ts` (muse/cursor/claude wording) does not run the maintenance fixtures the plan relies on, so implementers get a false green or an empty run while developing.  
   **Correction:** Use `pnpm exec vitest run --config vitest.system.config.ts test/cli.test.ts` (as codex specifies), optionally with `-t` filters.

5. **claude — Design (shebang gate only wraps when the first line names `node`)**  
   **Rule:** The issue’s broken install is whatever `command -v claude` returns under the product pin; recovery must not depend on that file looking like a Node shebang if the common failure is a shell wrapper that still needs a modern Node companion.  
   **Failure if followed:** A non-`node` shebang (or native stub) resolved from the pre-`nvm` owner `PATH` under an old nvm tree is `exec`’d unchanged; update/launch can still hit “native binary not installed” even though resolution ran “beside” coord’s Node directory that had no healthier copy.  
   **Correction:** Keep resolve-before-`nvm` and same cmd for update/launch, but treat “no vendor binary under coord’s Node `bin` / home-local” as the case `claude update` must repair under coord’s Node on `PATH` for the update child only—or document/test that owners need a coord-side install. Do not claim shebang wrapping alone covers every Claude layout.

6. **Scope / reuse (all four, relative)**  
   All four stay inside issue 240’s Node-for-agent-maintenance theme, avoid new packages, and prefer extending `test/cli.test.ts`. Claude alone also lists necessary `test/install.test.ts` expectation edits for rewritten `exec` lines — required if `launcher_command` changes, and correctly absent from muse/codex (they do not change generated exec text). Cursor’s doc edits are appropriate if shared launcher behavior changes; muse omits docs while changing the published maintenance/launcher equality contract — that docs gap is a follow-through risk, not a separate mechanical failure beyond finding 1.

## Conclusion

Reject muse `289ccb9f` and codex `3926ba07` as written: maintenance-only Node overrides break the update≡launch installation invariant and leave the reported pane failure unaddressed. Reject cursor `b6795003` as written: prepending coord’s Node onto the shared launcher `PATH` contaminates product child Node selection and can invert antigravity’s home-local precedence. Prefer claude `998ee7f7`: resolve the vendor CLI beside coord’s Node before product `nvm use`, keep the product pin for agent children, and share that binding across maintenance and generated launchers — with the vitest **system** config for CLI tests and without over-claiming that shebang detection covers every broken Claude layout. No plan is safe to implement unchanged; claude is the only direction that can satisfy both the issue sample and existing isolation/same-install rules after those corrections.

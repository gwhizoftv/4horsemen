# Plan — issue 246: make Codex the first (solo-default) agent

Issue #246: "make codex first in the list of agents, so it is the default in the
`--profile solo` mode."

## How the solo agent is chosen today

- `coord onboard` writes `config.agents` in the order of `--agents`, or of
  `DEFAULT_AGENTS` when `--agents` is omitted (`src/install.ts:866`, used at
  `src/install.ts:928` and `src/cli.ts:1395`). `install` keeps that order
  (`validateAgentIds` at `src/install.ts:204` returns the list in input order).
- `coord start`/`coord <issue>` builds the roster with
  `profile === "solo" ? agents.slice(0, 1) : agents` (`src/cli.ts:1155`), so the
  solo agent is whichever agent comes first in the configured list.
- `DEFAULT_AGENTS` is currently `["claude", "codex", "cursor", "antigravity", "muse"]`,
  so a default onboard followed by `--profile solo` runs Claude.

The fix is to put `codex` first in `DEFAULT_AGENTS`. The roster logic stays as it is.

## Exact File List to be changed or deleted

1. `src/install.ts`: change line 866 to
   `export const DEFAULT_AGENTS = ["codex", "claude", "cursor", "antigravity", "muse"] as const;`
   and expand its doc comment to say that the first entry is the agent `--profile solo` runs.
   The `coord onboard --help` text (`src/cli.ts:416`) is built with
   `DEFAULT_AGENTS.join(",")`, so it updates without its own edit.
2. `test/onboard.test.ts`: change the two default-order expectations at lines 261
   and 299 from `["claude", "codex", "cursor", "antigravity", "muse"]` to
   `["codex", "claude", "cursor", "antigravity", "muse"]`.
3. `config.example.json`: move the `codex` agent object above the `claude` object.
   Leave every field unchanged, so a copied example also makes Codex the solo
   default.
4. `config.product.example.json`: swap the two agent lines so `codex` comes before
   `claude`. Leave every field unchanged.
5. `README.md`: in the onboarding paragraph ("The default is all five agents
   (Claude, Codex, …)"), list Codex first. Add a short clause saying the first
   listed agent is the one `--profile solo` runs.
6. `docs/coord-driver.md`: change the `solo` profile bullet ("one configured
   agent") to "the first configured agent", which documents the existing
   `agents.slice(0, 1)` rule.
7. `docs/setup-workspace.md`: in the advanced-install example (line 256), change the
   order to `--agents codex,claude,cursor,antigravity,muse`.

No files are deleted.

## Exact file list to be created

None. The change is a reorder plus updates to existing tests and docs. The plan
itself (`.plans/issue-246/plan.md`) is the only new file, and it is a coordination
artifact, not product code.

## Reuse and Scope

- Reused unchanged:
  - The `DEFAULT_AGENTS` constant and its consumers: `onboard()` in
    `src/install.ts` and the `onboard` command parsing and help text in `src/cli.ts`.
  - The solo roster selection in `startIssue` (`src/cli.ts:1155`).
  - `validateAgentIds` (order-preserving).
- Reused tests: the existing default-onboard test in `test/onboard.test.ts`
  already asserts the written config order (line 261) and the `coord manual`
  roster order (line 299). These are the exact observable behaviours issue #246
  changes. `test/cli.test.ts` (around line 257) already shows that solo takes the
  first configured agent (`codex`), so the slice rule needs no new test.
  `test/verify-config.test.ts` (lines 359 and 389) parses `config.example.json`
  with `coordinatorConfigSchema`. That covers the reordered example remaining
  schema-valid.
- Out of scope:
  - No new CLI flag (for example `--solo-agent`) and no change to roster or profile logic.
  - `src/setupWorkspace.ts:54` and `src/doctor.ts:367` only check membership or
    list supported ids. Order has no effect there, so they stay unchanged.
  - Historical analysis docs (`docs/issue-209-efficiency-analysis.md`,
    `docs/analytics.md`) record past rosters and stay unchanged.
  - Existing onboarded workspaces are not migrated (see Risks).
- No new files, abstractions, or dependencies.

## Tests

The only new or changed tests are these, in the existing file `test/onboard.test.ts`:

- Line 261: `expect(config.agents.map((agent) => agent.id)).toEqual(["codex", "claude", "cursor", "antigravity", "muse"]);`
  This fails before the change (the config is written claude-first) and passes after.
- Line 299: `expect(manualAgents).toEqual([["codex", "claude", "cursor", "antigravity", "muse"]]);`
  This also fails before and passes after.

Combined with the existing solo-slice coverage in `test/cli.test.ts`, these show
that a default onboard followed by `--profile solo` selects Codex.

Commands while developing: `pnpm vitest run test/onboard.test.ts test/verify-config.test.ts test/cli.test.ts`.
The pre-commit hook runs the mandatory `pnpm check:fast` (lint, typecheck, fast
tests). The coordinator owns the final checks at the approved pin.

## Alternatives Rejected

- **Pick Codex explicitly in solo mode** (for example
  `agents.find((a) => a.id === "codex") ?? agents[0]`): this hard-codes a vendor
  into the roster logic and silently overrides an owner's explicit `--agents`
  order. The current "first configured agent" rule is simple, documented, and
  owner-controllable.
- **Add a `--solo-agent` option or config key**: this adds flexibility the issue
  does not ask for. Owners can already choose by ordering `--agents`.
- **Rewrite existing workspace configs on upgrade**: this would mutate
  owner-owned configuration without consent and is out of scope. Re-running
  `coord onboard` without `--agents` already rewrites the order.

## Risks and Mitigations

- **Existing workspaces keep claude-first order.** Configs written before this
  change are unchanged, so `--profile solo` there still picks Claude.
  Mitigation: the README notes that the first configured agent is the solo
  agent. The owner can re-run `coord onboard <product>` with no `--agents`, or
  reorder `agents` in the workspace config.
- **Order also affects non-solo fallbacks.** `activeRoster[0]` is the fallback
  designated implementer or reviser (`src/steps.ts:260`, `src/machine.ts:266-276`)
  and the first agent for ownerControls plan checks. For default-onboarded
  workspaces Codex now takes that slot too, which matches the issue's reasoning
  (Codex usually produces the best plan and implementation). Explicit
  selections and reviser choices still take precedence, unchanged.
- **Other tests may depend on default order.** A search for the literal default
  list and for `DEFAULT_AGENTS` in `src/` and `test/` finds only
  `test/onboard.test.ts:261` and `:299`. Every other test passes `--agents` or
  writes its own config. The `pnpm check:fast` hook catches any test that was missed.
- **Example config reorder**: only object order changes, and the schema test in
  `test/verify-config.test.ts` still parses it.

## Conclusion

Reorder `DEFAULT_AGENTS` to `["codex", "claude", "cursor", "antigravity", "muse"]`
so `coord onboard` writes Codex first. The unchanged `agents.slice(0, 1)` rule
then makes Codex the `--profile solo` agent. Update the two default-order
assertions in `test/onboard.test.ts`, put Codex first in both example configs and
the setup example, and document "first configured agent" in the README and
`docs/coord-driver.md`. Seven existing files change, no files are created, and
there are no new dependencies.

# Issue 230 — Add Muse CLI as a normal opt-in agent config

Issue [#230](https://github.com/gwhizoftv/4horsemen/issues/230) asks to add
Meta’s Muse Code CLI to coordination “as part of the normal config,” following
the Muse task list in
[`docs/issue-210-agent-cli-analysis.md`](../../docs/issue-210-agent-cli-analysis.md)
(**Exact future Muse change map** and **Bounded follow-up** step 2: minimum
installed mode). Keep the current per-vendor integration boundaries (issue 210
recommendation); do not introduce a vendor registry, MSP/SDK transport, or
unattended nudge delivery in this issue.

**Scope:** R-row plumbing so `id: "muse"` validates, installs, launches, and
appears in the shipped example config with **`delivery: "pull"`**. Defer A-row
hooks, lifecycle events, shell-guard envelopes, measured tmux readiness, and
quota/analytics to a follow-up once live Muse contracts are proven.

## Exact File List to be changed or deleted

- `scripts/lib/launcher.sh`
  - `launcher_environment`: for `muse`, export `MUSE_NO_AUTO_UPDATE=1` (observed
    wrapper control; do not set the update interval to zero).
  - `launcher_command`: add a `muse` case that launches `muse` with unattended
    candidates documented in issue 210 (`--approval-mode never` and
    `--trust-workspace`), plus `${coord_grant[@]+"${coord_grant[@]}"}`. Do not
    invent an `update` subcommand or hard-code a model.
  - `write_launcher`: resolve mailbox / responses / inputs / worktrees paths
    into root paths first, then append **vendor-specific** grant argv — existing
    agents keep `--add-dir`; Muse uses `--workspace` for each granted root
    (Muse has no `--add-dir`). Never grant the whole owner runtime or issue root.
- `src/cli.ts`
  - Replace `agentExecutables` string map with a small maintenance record
    `{ executable, versionArgv, updateArgv }` where `updateArgv` may be `null`.
  - Preserve `update` then `--version` for codex/claude/cursor/antigravity.
  - Add `muse` with executable `muse`, version `--version`, **`updateArgv: null`**
    so fresh-start never runs a prompted Muse session as a fake updater, but
    still records `--version`.
  - Keep help/default install rosters unchanged (Muse stays opt-in via config /
    `--agents muse`).
- `src/setupWorkspace.ts`
  - `KNOWN_AGENT_LABELS`: add `muse: "Muse"`.
  - `agentOwnerUiDefaults`: add an explicit Muse case with empty prelude,
    `["Enter"]` submit (documented Enter steering), and a distinct
    `terminalProfile` (e.g. `"Muse 1"`), so Muse does not inherit Claude’s
    Escape+Enter default solely by falling through.
  - `agentHarnessProcess`: Muse may keep the default (`return agent` → `"muse"`);
    only add a case if a measured foreground name differs.
  - `buildWorkspaceConfig`: set `delivery` to `"pull"` for `muse` and keep
    `"both"` for current agents, so install does not advertise nudge/hooks
    before A-row work lands.
- `src/productIgnore.ts` — add `.muse/` to `DEFAULT_CLONE_IGNORES`.
- `templates/product/gitignore.coordination.block` — add `.muse/`.
- `.gitignore` — add `.muse/` (keep generated/self-host ignore lists aligned).
- `config.example.json` — append an opt-in Muse agent object parallel to the
  existing entries: `id`/`root`/`launcher`/`harnessProcess` `"muse"`,
  `delivery: "pull"`, empty `nudgePrelude`, `nudgeSubmit: ["Enter"]`, and a
  Terminal profile string. Do **not** change install CLI default rosters; Muse
  remains opt-in for real workspaces via config or `--agents muse`.
- `test/cli.test.ts` — extend “fresh-start agent maintenance” so a Muse agent
  records `--version` without an `update` maintenance call and never treats
  `"update"` as Muse argv.
- `test/install.test.ts` — extend launcher-generation / ignore assertions so
  installing `muse` emits the Muse launch lines and grant shape, defaults to
  pull delivery / Muse label/UI, and includes `.muse/` in managed ignores.

## Exact file list to be created

- None for product runtime. (This plan file is coordination evidence only.)

No `scripts/setup_muse.sh`, no `src/vendors.ts`, and no new test framework files.
Prefer extending the existing test files named above.

## Reuse and Scope

**Reuse**

- `write_launcher` / `launcher_command` / `launcher_environment` as the single
  launch argv authority (installer and `githooks/post-merge`).
- `validateAgentIds` in `src/install.ts` (already requires a `launcher_command`
  case; no schema enum change — `agentIdSchema` already accepts lowercase ids).
- `buildWorkspaceConfig`, `agentHarnessProcess`, `agentOwnerUiDefaults`,
  `agentLabel`, `writeManagedIgnoreFile` / `DEFAULT_CLONE_IGNORES`.
- `updateAgentVersions` control flow in `src/cli.ts` (reorder only enough to
  honor nullable update argv).
- Tests/fixtures: `test/cli.test.ts` fresh-start maintenance; `test/install.test.ts`
  launcher and ignore cases; `test/support/workspaceFixture.ts` `makeProduct`
  for install fixtures. Issue 210’s cited homes remain the extension targets.
- Leave `config.product.example.json` and default install/onboard rosters
  unchanged so Muse is visible in the full example config without forcing it
  into every product bootstrap.

**Justify no new product files**

- Issue 210 concludes no new runtime module is justified for the first Muse
  adapter; metadata stays beside existing switches. Legacy `setup_muse.sh` is
  conditional and not required by `coord install`.

**Out of scope (follow-up / A–O rows)**

- `src/agentHookSync.ts`, `src/agentEvent.ts`, `src/shellGuard.ts`, measured
  Muse cases in `src/tmux.ts`, doctor nudge-capability claims, transcript /
  analytics / quota, Claude-style AGENTS shim, changing the default install
  roster, vendor registry migration, and live Muse end-to-end automation proofs
  beyond argv/ignore/version unit coverage.

## Tests

Fewest focused cases that fail before the change and pass after:

1. **`test/cli.test.ts`** (join “fresh-start agent maintenance”): config roster
   includes `muse`; maintenance calls must be
   `… muse --version` without a preceding `muse update`; recorded
   `agentVersions.muse` comes from version stdout; existing vendors keep
   update-then-version order.
2. **`test/install.test.ts`** (join launcher-generation cases ~line 59 / 241 and
   ignore assertions ~985): `coord install` / dry-run with `--agents muse`
   (or equivalent fixture agents list) produces `start-muse.sh` containing the
   Muse exec line, `MUSE_NO_AUTO_UPDATE`, and `--workspace` grants rather than
   `--add-dir`; workspace config for Muse has `delivery: "pull"` and label/UI
   defaults; managed clone ignore / template block lists `.muse/`.

Commands while developing: focused
`pnpm vitest run test/cli.test.ts test/install.test.ts`. Product commits rely
on the hook-owned `pnpm check:fast`; this plan artifact itself needs only
coordination evidence validation.

## Alternatives Rejected

- **Full A-row unattended Muse in this issue:** hooks, cleared-env binding,
  live pane readiness, and event mapping are still open contracts in issue 210;
  advertising `delivery: "both"` would claim nudge support the tree cannot keep.
- **Vendor registry (`src/vendors.ts`) first:** issue 210 shows the migration
  touches ≥9 TypeScript files without removing Muse’s behavioral work; keep
  existing boundaries for one new CLI.
- **Copy Claude/Codex/Cursor setup scripts wholesale:** Muse documents native
  AGENTS.md after trust; no CLAUDE.md-style shim or new `setup_muse.sh` until
  legacy setup support is explicitly required.
- **Pass `muse update` or rely on unknown-id skip alone:** help shows no update
  subcommand; a positional `update` can start a prompted session — nullable
  updater is required.
- **Grant Muse the entire owner runtime / use broad `--yolo`:** rejected by
  issue 210; use narrow resolved roots with Muse’s grant flag.
- **Make Muse a default install roster member:** issue asks for normal **config**
  support; opt-in `--agents muse` / example entry is enough.
- **Separate vendor/model fields or multi-model Muse participants:** larger than
  adding one Muse id; not a prerequisite per issue 210.

## Risks and Mitigations

- **Documented Muse `.git` / sandbox protections may block clone Git writes**
  needed even for pull-mode publishing. Mitigation: launch with the narrowest
  documented approval/trust flags that still allow mailbox + Git/network work;
  unit tests lock argv shape; if live Muse still cannot commit/push, stop and
  use a `plan-amendment-request` rather than silently widening grants or
  claiming full participant support.
- **`--workspace` may not equal additive `--add-dir` grants.** Mitigation:
  grant only the same four external roots already resolved today; document the
  flag choice in the launcher comment; do not grant the issue root.
- **Unknown-vendor tmux fallback can prepend unwanted keys if something nudges
  Muse.** Mitigation: default Muse to `delivery: "pull"` so automation does not
  rely on nudge until A-row readiness lands; still set explicit UI defaults.
- **Wrapper auto-update during long issues.** Mitigation: `MUSE_NO_AUTO_UPDATE=1`
  in `launcher_environment`; verify against the installed wrapper in comments /
  doctor messaging only if a cheap check already exists — do not add a new
  quota-style subsystem.
- **Example config implies unsupported hooks.** Mitigation: example uses
  `delivery: "pull"` and docs/comments in the launcher stay honest about
  deferred hook sync.

## Conclusion

Implement issue 210’s **minimum installed Muse mode** under the current
architecture: launcher case + Muse-specific grants, nullable updater/version
maintenance, install defaults with **pull** delivery, aligned `.muse/` ignores,
and a Muse entry in the normal example config. Leave automatic delivery,
hooks, and registry work for a later issue after live compatibility evidence
exists. Smallest change that lets owners put `"id": "muse"` in config and
install/launch it without pretending unattended nudge is ready.

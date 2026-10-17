# Issue 235 — Minimum Muse automation and default onboarding

Follow-up to #230 / PR #232 using research in #210. Make Muse a normal automatic
participant (`delivery: "both"`) on the existing ready/complete protocol, and
include `muse` in the default onboard roster after the current four agents.
Full lifecycle-hook parity is out of scope.

## Exact File List to be changed or deleted

- `src/cli.ts`
  - Change the `coord onboard` default `--agents` string from
    `claude,codex,cursor,antigravity` to
    `claude,codex,cursor,antigravity,muse`.
  - Keep `coord install`'s required `--agents` flag unchanged (no new default).
  - Leave lifecycle help enums (`agent-event` / `git-guard` vendors) as the
    existing four; this issue does not add Muse hooks.
- `src/install.ts`
  - Change `onboard()`'s programmatic default
    `options.agents ?? ["claude", "codex", "cursor", "antigravity"]` to append
    `"muse"` as the fifth entry.
- `src/setupWorkspace.ts`
  - In `buildWorkspaceConfig`, generate Muse with `delivery: "both"` (remove the
    pull-only special case and its obsolete comment).
  - Keep existing Muse `agentOwnerUiDefaults` (empty prelude, `["Enter"]`
    submit, `Basic` profile) and `agentHarnessProcess` → `"muse"`.
  - Optionally add `muse: "Muse"` to `KNOWN_AGENT_LABELS` for consistency with
    other known ids (label already capitalizes today).
- `src/doctor.ts`
  - When `inspectAgentLifecycleHooks` returns `kind: "unsupported"`, do **not**
    emit the `lifecycleHooks` finding for agent id `muse` with
    `delivery` in `{nudge, both}`.
  - Preserve the finding for every other unsupported id (including the existing
    `claude-a` style cases) so automatic delivery is not promised for arbitrary
    custom agents without a vendor mapping.
  - Adjust the finding remediation text only as needed so it still steers unknown
    ids to a supported vendor or `pull`, without claiming Muse needs hooks.
- `src/tmux.ts`
  - Add an explicit Muse terminal adapter in the existing helpers (no new module):
    - `harnessLooksReady`: accept the measured Muse foreground name, including
      documented version-string forms such as `muse-bin-…` / truncation variants
      observed in a live pane (issue #210 synthetic case).
    - `harnessPromptReadiness`: add a `case "muse"` that blocks on measured
      in-flight / interrupt chrome (documented Esc-interrupts-turn semantics;
      do not treat Escape as a submit key) and on trust dialogs already handled
      shared; idle panes return ready.
    - Extend `COMPOSER_LINE` and/or Muse-specific composer parsing with the
      **measured** idle composer glyph so `pendingPromptInComposer` and
      `paneActivityDigest` work for Muse.
    - In `nudge`'s `proofRefusal`, refuse a non-empty owner draft for Muse the
      same way Codex uses `codexComposerEmpty` (new Muse-local empty-composer
      helper beside the Codex one), unless the pending action prompt is already
      in the composer (submit-only path).
    - Keep `vimInsertPrelude` returning `[]` for Muse and
      `resolveNudgeKeys` producing empty prelude + Enter-only submit; never
      introduce Escape into Muse submit/prelude.
  - Add any new Muse-specific `PromptBlockedReason` union members required by
    the readiness/draft gates (journal consumers match the closed union).
- `README.md`
  - Default roster is five agents including Muse; remove “optionally … pull
    delivery” wording; update “all four agents” onboarding copy; add a Muse
    badge if the other agents are badged.
- `docs/setup-workspace.md`
  - Replace opt-in / pull-only Muse section with default-roster + automatic
    delivery (`both`), Enter-only keys, no lifecycle hooks, unchanged launcher
    flags / `MUSE_NO_AUTO_UPDATE`, and note that live verification records the
    tested Muse version.
  - Update the example `--agents claude,codex,cursor,antigravity` line to the
    five-agent default (or show explicit `--agents` as an override example).
- `config.example.json`
  - Set the Muse entry's `delivery` to `"both"` (leave other example agents as
    they are unless a nearby comment claims Muse is pull-only).
- `test/onboard.test.ts`
  - Expect default onboard/manual roster
    `["claude","codex","cursor","antigravity","muse"]`; keep an explicit
    `--agents` case exact.
- `test/install.test.ts`
  - Update the Muse install case that currently asserts `delivery: "pull"` to
    expect `"both"`; keep launcher argv / ignore / no-hooks assertions.
  - Update any four-agent default roster expectations that would fail under the
    new onboard default.
- `test/doctor.test.ts`
  - Keep “unsupported id + nudge/both → finding”.
  - Add Muse + `both` → no unsupported-mapping finding; missing Muse launcher
    / other existing checks still fail as today.
- `test/tmux.test.ts`
  - Extend Muse key assertions (empty prelude, Enter-only, no Escape).
  - Add Muse readiness / pending-prompt / owner-draft / process-alias cases
    using fixtures shaped from live pane captures.
- `test/runLoop.test.ts`
  - Narrow Muse/`both` cases: JOIN authorization sends via `deliver` /
    stubbed `tmux.nudge`, and a subsequent ready-authorized send; preserve the
    existing pull-only non-degrade coverage for intentional pull agents.

## Exact file list to be created

- `.plans/issue-235/plan.md` (this plan; coordination artifact only).

No new product source modules. Launcher case, UI defaults, `.muse/` ignore,
and version-only maintenance already exist from #230/#232.

## Reuse and Scope

Reuse (do not replace):

- `agentExecutables` Muse entry (`executable: "muse"`, `update: false`) in
  `src/cli.ts`.
- `agentOwnerUiDefaults` / `agentHarnessProcess` / `buildWorkspaceConfig` in
  `src/setupWorkspace.ts`.
- `scripts/lib/launcher.sh` Muse case
  (`--approval-mode never --disable-sandbox --trust-workspace`,
  `MUSE_NO_AUTO_UPDATE=1`) unless a live run proves a focused flag change.
- `inspectAgentLifecycleHooks` / `vendorForAgent` (Muse remains unmapped); only
  doctor policy for Muse+`both` changes.
- Delivery authorization in `RunLoop.maybeLifecycleNudge` /
  `RunLoop.deliver`: JOIN, `ready`, fresh session, and hold-release already
  authorize sends without lifecycle callbacks — extend tests, not the protocol.
- Terminal helpers in `src/tmux.ts`: `resolveNudgeKeys`, `pendingPromptInComposer`,
  `paneActivityDigest`, `vimInsertPrelude`, Codex draft-refusal pattern, nudge
  budget/reservation/duplicate-send protections.
- Existing fixtures in `test/onboard.test.ts`, `test/install.test.ts`,
  `test/doctor.test.ts`, `test/tmux.test.ts`, `test/runLoop.test.ts`.

New files justified: none for product code. Adapter logic stays inside
`src/tmux.ts` next to the other vendor cases. A new `src/muse*.ts` would only
relocate helpers without reducing coupling.

Out of scope (explicitly rejected by the issue): lifecycle-hook parity, Muse
usage analytics, quota recovery, general vendor framework, sandbox redesign,
migrating agents to plugin-packaged hooks. Do not rewrite existing issue
`start.json` / `originalRoster` snapshots; only defaults for new onboard/install
config generation change. Active issues keep their frozen roster.

## Tests

Fewest focused tests (fail before → pass after); extend existing files:

1. **`test/onboard.test.ts`** — default `coord onboard` config agent ids equal
   `["claude","codex","cursor","antigravity","muse"]`; `coord manual` sees the
   same five; an explicit `--agents claude` (or similar) remains exact.
2. **`test/install.test.ts`** — Muse-only install generates `delivery: "both"`,
   Enter-only nudge keys, launcher still passes `--disable-sandbox` /
   `--approval-mode never` / `--trust-workspace`, `.muse/` ignored, no
   `.muse/hooks.json`.
3. **`test/doctor.test.ts`** — Muse agent with `delivery: "both"` does not emit
   the unsupported-lifecycle-mapping finding; renamed unsupported id with
   `both`/`nudge` still does; other Muse doctor failures (e.g. missing
   launcher) remain.
4. **`test/tmux.test.ts`** — Muse: `resolveNudgeKeys` → `[]` / `["Enter"]` (no
   Escape, no vim `a`); `harnessLooksReady` accepts measured process aliases;
   `harnessPromptReadiness` busy on in-flight/interrupt chrome and ready when
   idle; `pendingPromptInComposer` true for a pending actionId; non-empty owner
   draft → busy / composer-not-ready; submit-only when prompt already pending.
5. **`test/runLoop.test.ts`** — Muse config `delivery: "both"`: initial JOIN
   path calls nudge/deliver; after a ready receipt, a second action is sent;
   intentional pull-only agents still are not auto-injected / not observability-
   degraded.

Commands while developing (focused):

```sh
pnpm vitest run test/onboard.test.ts test/install.test.ts test/doctor.test.ts test/tmux.test.ts test/runLoop.test.ts
```

Product commits rely on the hook's `pnpm check:fast`; do not manually duplicate
it immediately before commit. Full `pnpm check` remains coordinator-owned at
the approved pin when required.

Live acceptance (not replaceable by stubs alone; record in a disposable
workspace, not as a permanent product file unless the implementer chooses a
local note outside the file map):

- Muse version under test (`muse --version`).
- `coord onboard` default creates Muse with automatic delivery.
- Muse completes JOIN plus at least two ready-driven follow-on actions with
  **no** lifecycle callbacks.
- Demonstrate one Git-mode publication and one private-response publication,
  with matching `complete` / `ready` markers.
- Exercise pending action prompt, owner draft, and in-flight turn; confirm
  interruption/restart recovery and bounded resend without duplicate work.
- If a concrete live blocker appears, report reproduction and missing
  capability; do not silently fall back to pull-only.

## Alternatives Rejected

- **Keep Muse `delivery: "pull"` and only document owner remind** — fails the
  issue's automatic handoff and default-roster requirements.
- **Require full Muse lifecycle hooks before `both`** — explicitly out of
  scope; ordinary JOIN/ready/complete already authorizes delivery.
- **Broad doctor exemption for any `unsupported` vendor with `both`** —
  would hide misconfigured custom agent ids; exemption is Muse-id-specific.
- **New `src/museTerminal.ts` (or similar) module** — unjustified for one
  vendor case; peers live in `tmux.ts`.
- **Add Escape to Muse submit “like Claude”** — Muse Esc interrupts a turn
  (#210 / interactive guide); keep Enter-only.
- **Implement Muse transcript reader / Stop-as-completion** — Stop is not
  completion evidence; pane digest + existing budgets suffice for minimum
  recovery.
- **Change `coord install` to default five agents without `--agents`** —
  install already requires an explicit list; only onboard defaults expand.
- **Rewrite frozen issue rosters / mutate peer agents** — existing
  `originalRoster` snapshots must remain authoritative for in-flight issues.

## Risks and Mitigations

- **Doctor exit 20 blocks onboard** if Muse+`both` still trips unsupported
  mapping — mitigate with the Muse-specific doctor rule and a regression test
  before flipping delivery in `buildWorkspaceConfig`.
- **False-ready Muse pane** types into splash, mid-turn, or owner drafts —
  mitigate with measured readiness chrome, draft refusal, and pending-prompt
  submit-only; never send Escape.
- **Wrong composer glyph** breaks pending-prompt / activity digest → duplicate
  sends or stalled watchdog — measure live Muse panes before locking
  `COMPOSER_LINE` / Muse parser fixtures.
- **Default five-agent onboard needs Muse installed** — explicit `--agents`
  remains the escape hatch; doctor continues to report a missing Muse
  executable/launcher.
- **Re-onboard adds a Muse clone/runtime entry** — intended; must not alter
  active issue cursors or frozen `start.json` rosters.
- **Watchdog without lifecycle/tool events** relies on pane digests — preserve
  existing nudge budget, reservation, uncertain-hold, and duplicate-send
  protections; do not invent Muse transcript parsing in this issue.
- **Cross-agent key repair (`staleBareSubmit`)** must not pull Muse onto
  Escape+Enter — Muse defaults stay Enter; tests assert no Escape.
- **Live Muse version drift** vs #210 notes (1.4.9/1.4.10) — record the
  version actually tested; adjust process aliases/chrome matchers only from
  measured panes.

## Conclusion

The smallest complete solution is: default-roster inclusion (CLI +
`onboard()`), generate Muse with `delivery: "both"`, teach doctor that Muse
automatic delivery does not require lifecycle vendor mapping, and finish the
Muse terminal adapter inside existing `tmux.ts` helpers using live pane
measurements for process name, idle/busy chrome, composer glyph, and owner-draft
refusal—while reusing the ready/complete authorization path already used by
other agents. No new product files, no hook parity, no pull-only retreat.

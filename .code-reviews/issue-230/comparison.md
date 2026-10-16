# Issue 230 implementation comparison

## Comparison

Reviewed the complete exported worktrees for these exact implementation pins:

| Agent | Implementation pin | Assessment |
| --- | --- | --- |
| Claude | `cc767a47d481ff24b9bee4a2109872eed4bf73de` | Acceptable; implements the selected plan with focused coverage. |
| Cursor | `af7bc76b9a43ce64873560670bafe03da9cd75e5` | Acceptable; equivalent product behavior and focused coverage. |
| Codex | `bf0763a60d36f1d322d1f8bb36ee819742b7784f` | Preferred; equivalent product behavior, broader launcher assertions, and clearer limits in the setup documentation. |

No blocking implementation defect found at these pins. All three follow the
selected Claude plan `cea4ff7cc5c6c872484eb8ad4ea71dc5022e8da3`: opt-in Muse
installation with pull delivery, an unchanged default roster, and no claim of
automatic delivery or native Muse hook support.

### Behavior and scope

All three extend `launcher_environment` to resolve Muse from `~/.local/bin`
and set `MUSE_NO_AUTO_UPDATE=1`. Their launcher commands are identical:
`muse --approval-mode never --disable-sandbox --trust-workspace`, without
unsupported `--add-dir` flags. They reuse the existing launcher generator,
Git shim, clone identity, mailbox resolution, and native `AGENTS.md` overlay.

Each changes the existing maintenance map to carry an executable and an update
boolean. Muse skips the updater, emits the explanatory message, and still
participates in version collection; the existing vendors retain their update
steps. Cursor renames the local map to `agentMaintenance`; this is a small
local naming difference, not a new abstraction.

Each gives Muse pull delivery and empty-prelude/Enter/Basic defaults, and
excludes it from `vimInsertPrelude`. Reading the unchanged
`resolveNudgeKeys` confirms that its bare-Enter repair resolves back to the
new Enter default. All three add the same example config entry and `.muse/`
to the three ignore lists. No product hooks, lifecycle adapters, registry,
dependencies, new product files, or default-roster changes are introduced.

The coordinator's changed-path lists show the same 13 product/documentation/test
paths for every implementation, matching the selected plan; the remaining paths
are coordination evidence. All implementations reuse existing functions and
fixtures and avoid unrelated cleanup.

### Coverage and maintainability

Each extends `test/cli.test.ts`, `test/install.test.ts`, and `test/tmux.test.ts`
using their existing fixtures. Each covers version collection without an update,
the generated launcher argv and update environment, pull configuration, ignore
entries, and default plus explicitly configured reminder keys.

Codex's `test/install.test.ts:1214` additionally executes both issue and manual
launches, uses spaces in the fixture home and mailbox paths, starts with a
controlled PATH, and captures the resolved Git shim. It checks all three ignore
sources, effective clone ignoring, the Basic terminal profile, and absence of a
native Muse hook file. These are focused extensions of the same fixture, not a
new test framework. Its maintenance test at `test/cli.test.ts:222` also asserts
the complete mixed-agent maintenance sequence. Claude tests Muse alongside the
existing roster; Cursor tests a solo Muse roster and checks the probe's clone
working directory. Those are useful alternatives, with no behavior difference
found in their implementations.

Codex's `docs/setup-workspace.md:111` explicitly states the owner-wide write
access, unverified live shim coverage, observed CLI version, and lack of a live
Muse commit/push/receipt check. Claude also explains unverified containment;
Cursor documents disabled sandboxing and unavailable hooks but provides less
detail about these limits.

### Verification evidence and limits

Read the existing issue journal at
`/Volumes/4TB-SOURCE/REPOS/4horsemen/coord-runtime/issue-230/journal.jsonl`.
It records the following successful product hook observations:

| Agent | `pnpm run check:fast` | `pnpm run test:e2e` |
| --- | --- | --- |
| Claude | Exit 0, line 660, 2026-10-16 20:10:27 UTC | Exit 0, line 697, 20:10:57 UTC |
| Cursor | Exit 0, line 692, 2026-10-16 20:10:42 UTC | Exit 0, line 702, 20:11:08 UTC |
| Codex | Exit 0, line 695, 2026-10-16 20:10:46 UTC | Exit 0, line 714, 20:11:23 UTC |

These are explicitly labeled advisory hook observations, not coordinator final
verification receipts. Earlier failed Claude and Codex precommit attempts are
followed by the successful observations above. Codex's successful hook results
were also observed directly during implementation. No product suites were rerun
for this comparison, and no coordinator final `pnpm check` result is claimed.

All three retain the selected plan's acknowledged limitation: Muse runs
unsandboxed, and a stub launcher test cannot prove a live Muse session loads
instructions, publishes Git commits, writes receipts, or preserves shell-tool
PATH and issue binding. Live acceptance remains separate. This comparison
accepts the selected scope and does not treat those explicitly deferred
capabilities as implemented.

### Recommendation

Prefer Codex `bf0763a60d36f1d322d1f8bb36ee819742b7784f` for its additional
targeted launcher coverage and explicit operating limits. Claude and Cursor
are also acceptable implementations of the approved minimum installed mode;
the preference is based on regression coverage and documentation, not a
blocking defect in either alternative.

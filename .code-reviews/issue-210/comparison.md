# Issue 210 implementation comparison

Bound implementation pins compared:

- cursor `86dd06eb7761e863dd2e69825f80ea9082f917bb`
- claude `755a65d93d46a7feae802065d4dbde39626d7d02`
- codex `68694071858bcc44a57738a8fad0ae401933e930`

Each pin changes only the approved product paths (`README.md`,
`docs/issue-210-agent-cli-analysis.md`) plus issue coordination artifacts.
No runtime, schema, launcher, or test code is modified. Scope, reuse, and
test restraint therefore match the selected plan for all three.

## Comparison

### Shared strengths

All three deliverables:

- Pin inventory citations to baseline `cb7ed092cb8a5d15f651387651df7c631e4596e6`.
- Cover launcher argv, fresh-start update/version, trust, lifecycle hooks,
  tmux readiness, optional telemetry, and a Muse change map with test homes.
- Call out Muse’s missing `update` subcommand and missing `--add-dir`.
- Record hooks-reference provenance drift (page samples from Muse Code 1.3.0
  under a `/1.4/` URL) versus a locally observed 1.4.x CLI.
- Reject a broad plugin/MSP rewrite for this product stage.
- Add a README Documentation-table link that does not claim Muse is supported.

### Architecture recommendations (diverge)

| Pin | Stated course |
| --- | --- |
| cursor | Keep behaviour modules; introduce a small identity/capability table **when Muse is implemented** |
| claude | Keep architecture, but **first** make dispatch exhaustive and collect identity data in one table |
| codex | **Keep current boundaries now**; extend the existing CLI maintenance map for nullable update argv; reconsider a narrow registry only after live Muse contracts are known |

Codex’s cost argument (registry still leaves hook/TUI/JSON work; nine TS files
in migration for limited next-vendor savings) is the most tightly quantified.
Claude’s “exhaustive dispatch” point is the most concrete safety fix for
unknown ids. Cursor sits between them but under-documents the silent-path
hazards Claude measured.

### Findings

1. **cursor `docs/issue-210-agent-cli-analysis.md:253` (AGENTS.md row).** The
   report labels “AGENTS.md native load” as **Open**. Rule: Muse claims that
   Meta’s primary configuration docs already answer must be labelled
   documented (with live verification still flagged), not open. Failure: an
   implementer following only Cursor’s pin plans an unnecessary instruction
   shim and misses that trusted Muse loads `AGENTS.md` natively (as Claude
   `755a65d9` §4.2 and Codex `68694071` instructions row both record from
   https://dev.meta.ai/docs/muse-code/configuration). Smallest correction:
   mark documented; keep “verify in managed clone” as the live check.

2. **cursor `docs/issue-210-agent-cli-analysis.md` Muse section (nudge /
   unknown-id behaviour absent).** Rule: the assessment must warn where today’s
   defaults silently mis-handle an unknown harness id that later becomes Muse.
   Failure: Cursor’s pin never states that `resolveNudgeKeys` for a non-special
   id with empty prelude still applies `vimInsertPrelude` → `"a"`
   (`src/tmux.ts:342-344`, `:269-274`) and that a configured bare `Enter`
   submit is upgraded via `staleBareSubmit` to the unknown-id default
   `Escape+Enter` (`src/tmux.ts:362-368`), while Muse docs treat Escape as
   interrupt. Claude `755a65d9` §3.2 reproduced these paths; omitting them
   understates the first automation hazard. Illustrative test (future Muse
   issue): extend `test/tmux.test.ts` next to “honors explicit empty prelude…”
   with id `muse` / empty prelude / `["Enter"]` submit expecting unsafe
   upgrade until an explicit Muse branch exists.

3. **cursor `docs/issue-210-agent-cli-analysis.md:245` (self-update).** The
   row cites `MUSE_UPDATE_INTERVAL_SECONDS` as “Documented / open” by analogy.
   Rule: when the local Muse wrapper text is available, read-only inspection
   should record the observed disable/sync controls rather than leaving
   pane-update policy open. Failure: Cursor’s change map only says “if PATH
   needed” and does not require `MUSE_NO_AUTO_UPDATE=1` (Claude A2 / Codex
   wrapper row), so a follow-up launcher can still self-update mid-issue.
   Smallest correction: adopt Claude/Codex’s observed wrapper controls.

4. **claude `docs/issue-210-agent-cli-analysis.md:240-243` (“Hooks need almost
   no new code”).** Rule: documented shape similarity must not erase distinct
   containment contracts. Failure: Codex `68694071` shows Muse’s documented
   cleared hook environment plus managed-only env allowlisting conflicts with
   `guardShellRequest` requiring `COORD_ISSUE`
   (`src/shellGuard.ts:283`); a copied Claude-like project hook would
   fail-open (`shellGuardResponse` allow). Following Claude’s pin alone
   under-scopes shell-guard work. Smallest correction: keep “nested layout /
   deny envelope similar to Claude” but add Codex’s env-binding verification
   as required for Tier B.

5. **claude `docs/issue-210-agent-cli-analysis.md:204` vs peer pins (CLI
   version).** Claude records local Muse **1.4.7**; cursor and codex record
   **1.4.9** on the same research date. Rule: the deliverable must not present
   a single machine’s patch as the cohort’s measured version without noting
   drift. Failure: readers may treat 1.4.7-specific launcher notes as current
   for 1.4.9. Smallest correction: state observed version as machine-local and
   re-check wrapper flags per install (Codex already separates wrapper
   inspection from help).

No findings that any pin expanded the approved product map, introduced runtime
refactors, or added tests to this documentation issue. Codex’s inventory is the
most complete on grant/sandbox/`.git` constraints and hook-environment binding;
Claude’s is the most complete on measured unknown-id / nudge failure modes;
Cursor’s is structurally aligned but thinner on those two risk areas.

### Preference for selection

Prefer **codex `68694071`** as the comparison winner for merging: it matches the
selected plan’s “continue boundaries / bounded Muse map” stance, quantifies the
registry cost, and uniquely blocks a false “hooks are free” reading. Fold in
Claude’s §3.2 silent-path measurements and Cursor/Codex’s 1.4.9 observation when
revising operator-facing follow-ups. Cursor `86dd06eb` is acceptable as a
shorter inventory but should not be the sole source for Muse automation
hazards.

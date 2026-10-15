# Issue 210: agent CLI integration assessment

Protocol version: 1. Analysis baseline: `cb7ed092cb8a5d15f651387651df7c631e4596e6`.
The issue requests an inventory, a Muse Code integration assessment, and an
architecture recommendation. The deliverable is documentation; implementing a
new CLI or refactoring the driver belongs to a subsequent issue.

## Exact File List to be changed or deleted

- `README.md` — add one entry to the existing Documentation table linking to
  the new assessment. Describe it as an integration inventory and design
  assessment, without implying that Muse is already supported.

No files will be deleted.

## Exact file list to be created

- `docs/issue-210-agent-cli-analysis.md` — the complete, baseline-pinned report.
  A dedicated document keeps a substantial reference inventory and the
  architecture decision together without making the operator guide longer.

These are the only product paths authorized for implementation. Current-issue
coordination artifacts remain governed by the action protocol.

## Reuse and Scope

### Existing implementation to inspect and explain

Reuse the repository's current integration boundaries as the report structure.
The following paths are research inputs, not proposed edits:

| Area | Existing code and starting anchors | What the report must establish |
| --- | --- | --- |
| Identity and configuration | `src/protocol.ts:10` (`agentIdSchema`); `src/state.ts:234` (`agentConfigSchema`); `src/setupWorkspace.ts:30`, `:52`, `:108`, `:332` (`agentHarnessProcess`, `agentOwnerUiDefaults`, labels, `buildWorkspaceConfig`); both example configuration JSON files | Distinguish arbitrary participant IDs from hard-coded CLI identities, executables, models, delivery settings, and owner UI defaults. Identify config fields that already avoid source edits and the absence/presence of model-selection plumbing. |
| Launch, install, update | `scripts/lib/launcher.sh:19`, `:46`, `:336` (`launcher_environment`, `launcher_command`, `write_launcher`); `src/install.ts:197` (`validateAgentIds`) and install/uninstall wiring; `src/setupWorkspace.ts:548` (`writeAgentLauncher`); `src/cli.ts:135`, `:142` (`agentExecutables`, `updateAgentVersions`) | Record exact argv, environment, permission/sandbox behavior, writable-root grants, CLI update/version commands, launcher support, and generated-file ownership. The shell launcher already centralizes launch flags; do not propose a second flag store. |
| Legacy setup and instructions | `scripts/setup_common.sh`; the four `scripts/setup_*.sh` vendor entry points; `githooks/post-merge`; `githooks/lib/identity.sh`; `src/agentsProtocol.ts:183`, `:200`; `src/productIgnore.ts:41`; `templates/product/AGENTS.md`; `templates/product/gitignore.coordination.block` | Trace alternative setup paths, identity labels, prompt/instruction bridges, vendor config directories, ignore lists, and generated artifacts. Label active paths separately from historical/example text. |
| Trust and hook JSON | `src/agentTrust.ts:43` (`syncAgentTrust`); `src/agentHookSync.ts:13`, `:16`, `:106`, `:205`, `:228`, `:293` (`vendorForAgent`, paths, event tables, sync/remove/inspect); `src/doctor.ts:354` and following checks | Inventory each settings location, JSON/TOML shape, ownership marker, merge/removal behavior, and unsupported-vendor diagnostic. Include Claude and Antigravity status-line installation and teardown. |
| Event normalization and command containment | `src/agentEvent.ts:17`, `:61`, `:187`, `:271` (`LifecycleVendor`, `normalizeAgentEvent`, usage normalization, `handleAgentEvent`); `src/shellGuard.ts:30`, `:39`, `:280`, `:320`; `src/agentLifecycle.ts:30`, `:44`, `:154`, `:500` | Identify closed vendor enums, event/session/action field mappings, shell tool names, allow/deny envelopes, tool-refusal evidence, lifecycle transitions, and unknown/unsupported outcomes. Installation must not be described as proof of enforcement. |
| Terminal delivery and recovery | `src/tmux.ts:49`, `:217`, `:269`, `:305`, `:327`, `:381`; vendor branches in `src/runLoop.ts` including readiness reasons, transcript watchdogs and resource holds | Cover process aliases, prompt/busy/trust detection, composer matching, vim configuration, submit keys, pacing, retries and recovery. Follow callers so a new enum/default cannot silently bypass readiness checks. |
| Optional usage and quota evidence | `src/transcriptRead.ts:12`, `:110`, `:124`, `:197`, `:320`, `:486`; `src/analytics.ts:509`; `src/cursorHookUsage.ts:65`, `:140`; `src/claudeStatusLine.ts`; `src/codexQuota.ts`; `src/resourceEvidence.ts`; `src/paths.ts:480`; resource reporting in `src/issueReport.ts` | Separate minimum participation from token analytics, failure classification, quota reads and automatic recovery. Record vendor-specific schemas, store paths, account/session binding and honest unavailable coverage. |

Use `docs/repo-map.md`, `docs/setup-workspace.md`, `docs/coord-driver.md`,
`docs/readiness-policy.md`, and `docs/analytics.md` for existing terminology and
invariants. Validate claims against source when a prose statement is stale.
Reuse the existing test suites as behavioral evidence: `test/install.test.ts`,
`test/onboard.test.ts`, `test/wrapper.test.ts`, `test/cli.test.ts`,
`test/agentHookSync.test.ts`, `test/agentEvent.test.ts`, `test/shellGuard.test.ts`,
`test/agentLifecycle.test.ts`, `test/tmux.test.ts`, `test/runLoop.test.ts`,
`test/transcriptRead.test.ts`, `test/cursorHookUsage.test.ts`,
`test/codexQuota.test.ts`, and `test/analytics.test.ts`. Existing fixture reuse
includes `test/support/workspaceFixture.ts` and the Claude/Codex transcript and
analytics journal fixtures in `test/support/fixtures/`. Name exact existing
test cases in the report where they substantiate behavior.

### Report content and method

1. State the baseline SHA, research date, scope, and a clear recommendation
   at the beginning. Inventory tracked files, including hidden tracked config
   and CI files, using `git ls-files`; search with `rg -n` for whole vendor
   names and for configuration concepts such as model, launcher, harness,
   lifecycle, settings, trust, permissions, and hooks. Inspect matches and
   callers. Generic cursor-state variables and illustrative agent names must
   not be counted as vendor behavior.
2. Produce a comprehensive table of integration sites with repository path,
   baseline line/range, symbol or data key, current vendor behavior, and why
   adding a CLI would or would not require an edit. Use commit-pinned source
   links so line numbers remain useful after later changes. Cover launchers,
   TypeScript, shell setup, JSON examples/templates, hook configuration,
   tests/fixtures, documentation, and any relevant hidden tracked files.
   Explain excluded match categories and include reproducible searches; an
   unreviewed search-hit list is insufficient.
3. Add a current-vendor capability matrix for Claude, Codex, Cursor and
   Antigravity, plus the launcher-only Gemini case. Show that launch support,
   automated lifecycle/nudging, shell containment, analytics and quota
   recovery are separate capabilities. Trace unsupported/custom IDs end to
   end rather than treating permissive ID validation as complete support.
4. Assess **Meta Muse Code**, explicitly distinguishing it from other products
   named Muse and from its underlying model. Use primary vendor sources,
   record the documentation release/date, and separate documented features,
   locally observed behavior, proposed mappings, and unanswered questions.
   The verified starting sources are Meta's [user manual](https://dev.meta.ai/docs/muse-code),
   [versioned developer documentation](https://meta-models.github.io/muse-code-sdk/1.4/),
   [hooks reference](https://meta-models.github.io/muse-code-sdk/1.4/guides/extend/hooks/),
   and [SDK repository](https://github.com/meta-models/muse-code-sdk), accessed
   2026-10-15. The versioned site identifies Muse Code 1.4 and its generating
   commit; record that provenance in the report. Research installation and
   update/version commands, launch/model flags, workspace trust and grants,
   instruction/config discovery, hook events and payloads, stop/readiness,
   telemetry and headless/MSP options. Do not assume another CLI's flags or
   hook contract apply because an event name matches. If a binary is already
   installed, read-only help/version output may supplement the sources;
   installation, authentication, account operations and live sessions are
   outside this documentation task.
5. Give a concrete Muse change map for the current architecture: required
   onboarding/launcher changes, additional work for reliable automated
   participation, and optional analytics/quota work. Every proposed existing
   file change needs baseline lines, rationale and a nearby existing test
   home. Proposed new files need an explicit name and justification, with
   “new file; no baseline lines” rather than an invented line number. Unknown
   Muse contracts must have a verification step and conditional impact;
   do not portray them as implemented or tested.
6. Compare continuing the present switches with a small internal capability
   registry plus vendor-specific adapters, and with a broad plugin/transport
   rewrite. Preliminary direction: retain the shared launcher and normalized
   lifecycle core, consolidate only repeated identity/capability metadata
   when the next vendor is added, and retain bespoke JSON/event/TUI parsing
   in focused functions. Test this recommendation against the inventory.
   The final report must choose a course, quantify affected files/sites,
   explain maintenance and migration costs, and enumerate the exact existing
   file/line edits and justified new files for the recommended design.
   Address how shell and TypeScript consume a single authority without
   duplicated launch argv; any identity-versus-CLI separation must explain
   backwards-compatible defaults, persisted/frozen configuration and tests.
   If the evidence instead favors keeping the current design, say so
   explicitly and explain why a registry would add more cost than it removes.
7. End with a bounded follow-up sequence and acceptance criteria for a future
   integration: install/doctor/uninstall preservation, launch/grants, event
   correlation, actual shell refusal, prompt delivery, completion/ready
   handshake, restart/recovery, and truthful optional telemetry coverage.
   Outline existing test homes for that future work without adding tests now.

The sole new artifact is the report. No runtime abstraction, dependency,
configuration migration, Muse adapter, launcher, or test fixture is introduced
by this issue. Hypothetical future file maps inside the report do not expand
this plan's two-file implementation scope.

## Tests

This change documents behavior rather than changing it, so no new unit tests
or fixtures are warranted. Validate the report with a focused evidence audit:

- Check every local source path, baseline line/range and named symbol against
  the recorded baseline; check README's relative link and report anchors.
- Re-run the inventory searches and account for every substantive vendor
  branch/configuration site. Check required categories, the Muse capability
  table, source provenance, and the exact future-change map. Label all
  unverified CLI assumptions and proposed work explicitly.
- Run `pnpm check:docs`, the existing script for shipped examples, verification
  instructions and agent-facing language. This is a regression check, not
  proof that the factual inventory is complete.

For this plan-only action, validate the seven nonempty headings and use the
existing `extractApprovedPaths` helper to assert that only the two intended
product paths are approved; do not run a product suite. In implementation,
the new report is not in this issue's frozen documentation allowlist, so
do not assume docs-only hooks apply or edit policy to bypass checks. Let the
installed hooks run their required checks, including `pnpm check:fast` when
classified as product/unknown, without manually duplicating that suite
immediately before commit. The frozen coordinator final check is
`pnpm run check`; cite its recorded result when supplied, never as an
agent-run check. Report all validation actually performed.

## Alternatives Rejected

- Implement Muse support during the assessment: the issue asks for analysis
  first, and integration contracts must be established before changing runtime
  behavior.
- Copy every vendor switch for a fifth CLI without an inventory: this misses
  less visible lifecycle, trust, cleanup, failure and analytics paths.
- Introduce a general plugin loader or replace tmux with MSP in this issue:
  neither is needed to deliver the requested assessment, and a single
  vendor's SDK does not establish a common transport contract.
- Add parallel launcher flag tables in shell and TypeScript: the existing
  shared shell function deliberately prevents that drift.
- Add tests asserting documentation wording: source/link/evidence validation
  is more useful and avoids tests that merely mirror the report.

## Risks and Mitigations

- **Incomplete inventory:** search both vendor names and capability concepts,
  traverse callers, include generated/legacy paths and tests, and explicitly
  account for exclusions.
- **Moving source lines:** anchor all implementation citations to the frozen
  baseline and include symbols; distinguish existing-file edits from proposed
  files with no baseline location.
- **Muse ambiguity or documentation drift:** use the primary Meta sources and
  versioned provenance, record research dates, and state observed gaps.
  SDK availability alone is not evidence that tmux readiness or hook-based
  containment works in the live CLI.
- **Scope creep through the architecture proposal:** the report can enumerate
  future source changes, while this implementation edits only its two listed
  documentation files.
- **Over-generalization:** preserve lifecycle safety, settings ownership,
  account binding and unsupported capability behavior; compare the smallest
  consolidation against leaving the existing design in place.
- **Unexpected verification cost:** the new document is outside the frozen
  docs allowlist; honor hook/coordinator classification rather than adding
  configuration or hook changes to this documentation task.

## Conclusion

Publish a reproducible inventory and a concrete, source-backed Muse assessment
that lets the owner choose the next integration step. Deliver a clear design
decision with exact future change locations, while keeping this issue's
implementation to one report and its README entry.

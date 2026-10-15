# Issue 210: agent CLI extension surface inventory

Issue #210 asks for an inventory of every place coord tailors CLI options,
configuration, JSON, and harness behaviour to a specific LLM/CLI agent; an
analysis of what Meta's Muse Code (`muse`) would require; and a recommendation
whether to keep extending vendors as today or introduce a cleaner architecture.
This issue changes no product runtime behaviour: it publishes documentation
only.

## Exact File List to be changed or deleted

- `docs/repo-map.md`: add one "Start here" row that points operators and agents
  at the new inventory when the change is "add or assess a new agent CLI", so
  the analysis is discoverable without duplicating its tables.

## Exact file list to be created

- `docs/issue-210-agent-cli-extension.md`: the issue deliverable. Inventory of
  every vendor-specific switch, case, schema field, launcher branch, trust
  writer, lifecycle-hook path, readiness/transcript/quota special case, setup
  script, and documented operator surface, each with file path and line number
  at the implementation pin; Muse Code addition analysis against that
  inventory; architecture recommendation (continue as-is vs registry) with the
  exact file:line list a registry would still have to touch.

## Reuse and Scope

Reuse the existing orientation in `docs/repo-map.md` (launcher flags already
point at `scripts/lib/launcher.sh`) and the agent lifecycle / setup narrative in
`docs/setup-workspace.md` and `docs/readiness-policy.md`. Cite, do not rewrite,
those docs. Reuse the known vendor id set already expressed in:

- `scripts/lib/launcher.sh` `launcher_command()` / `launcher_environment()`
- `src/setupWorkspace.ts` `agentHarnessProcess`, `agentOwnerUiDefaults`,
  `KNOWN_AGENT_LABELS`
- `src/agentTrust.ts` `syncAgentTrust`
- `src/agentHookSync.ts` `vendorForAgent` / `agentLifecycleHookPath`
- `src/tmux.ts` pane readiness, nudge prelude, scroll, and composer helpers
- `src/transcriptRead.ts` `TranscriptVendor` / `UsageVendor`
- `src/agentLifecycle.ts` / `src/agentEvent.ts` failure and event vendor unions
- `src/runLoop.ts` Claude/Codex session and quota special cases
- `src/claudeStatusLine.ts`, `src/cursorHookUsage.ts`, `src/codexQuota.ts`
- `scripts/setup_{claude,codex,cursor,antigravity,common}.sh`
- `config.example.json` agent roster examples
- related tests under `test/` that encode the same vendor branches

Justify the new analysis file: issue 209's precedent
(`docs/issue-209-efficiency-analysis.md`) shows long-form inventories belong in
`docs/issue-<n>-*.md` rather than bloating `repo-map.md` (which deliberately
avoids line numbers). Justify the one-line `repo-map.md` edit: without it, the
inventory is only findable by issue number. Do not add Muse as a launcher, do
not introduce a vendor registry module, do not change schemas, hooks, or tests
in this issue. Paths cited only for reading do not expand the file map.

## Tests

No new automated tests: this issue changes no executable behaviour,
configuration schema, or fixtures (same stance as issue 209). Validation while
authoring:

1. Every inventory row's path exists in the tree at the branch tip.
2. Every cited line number lands on a vendor-specific branch, union member,
   schema refine, or docs sentence that names a concrete agent id.
3. The Muse section maps each integration layer (launch flags, harness process
   name, owner-UI nudge keys, folder trust, lifecycle hooks, shell guard,
   readiness/submit detection, transcripts/usage, install/onboard defaults) to
   either "required for first install", "required for unattended coord runs",
   or "optional / later", citing public Muse Code docs
   (`muse`, trust scopes, sandbox, hooks, `META_API_KEY` / `muse exec`).
4. The architecture conclusion names a concrete recommendation; if it proposes
   a registry, it lists every file:line that registry would still update; if it
   recommends continue-as-is, it states that explicitly and does not sketch
   unused abstractions.

The commit hook classifies allowlisted documentation; a new `docs/*.md` not yet
in the frozen issue documentation allowlist may retain product checks for this
pin. Run no product suite solely for this docs commit beyond what the hook
requires. Report only checks actually run.

## Alternatives Rejected

- **Implement Muse now.** Out of scope: the issue asks for assessment first.
- **Introduce a vendor plugin/registry in this issue.** That is a product
  redesign; the issue asks whether redesign is warranted and, if so, to
  enumerate the touch points—not to build it yet.
- **Only update `docs/setup-workspace.md`.** Operator setup prose cannot carry
  a complete file:line inventory without becoming unmaintainable; a dedicated
  issue analysis matches issue 209's pattern.
- **Expand `repo-map.md` with the full inventory.** That file's invariant is to
  avoid line numbers so ordinary commits do not stale it.
- **Generate the inventory with a one-off script checked into `scripts/`.** Extra
  machinery for a one-time analysis; ripgrep + reading the known modules is
  enough and keeps the file map empty of tooling.

## Risks and Mitigations

- **Stale line numbers.** The inventory pins line numbers to the implementation
  commit; mitigate by stating the baseline/tip SHA in the doc header and
  grouping rows by module so a later reader can re-locate moved switches.
- **Incomplete Muse picture.** Public Muse docs may omit hook JSON shapes or
  pane chrome that coord needs for readiness; mitigate by marking those rows
  "unknown — needs a live `muse --help` / first-run probe" rather than guessing
  flags.
- **Over-recommending a refactor.** A registry that only relocates the same
  per-vendor branches adds indirection without reducing touch points; mitigate
  by scoring "continue as-is" as the default unless the Muse analysis shows a
  fifth full harness is imminent and shares enough surface with the four
  existing vendors to amortize extraction.
- **Documentation allowlist lag.** A new docs path may not yet be in the
  workspace `documentation.paths` frozen for this issue; mitigate by accepting
  product-profile hook checks for the docs pin, or noting that a later
  `coord install` proposal will pick up tracked `docs/*.md` automatically.

## Conclusion

Publish one analysis document that (1) lists every current agent-CLI tailoring
site with file:line citations, (2) walks Meta Muse Code through that checklist,
and (3) recommends either continuing the existing per-vendor switch pattern or
a concrete registry design with its own file:line migration list. Add a single
discoverability row in `docs/repo-map.md`. No runtime, schema, launcher, or
test changes in this issue.

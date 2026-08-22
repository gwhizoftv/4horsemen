# Issue 92 — implementation plan (claude)

Phase 2 efficiency work, driven by the analytics baselines the owner published on
issue 92 (coordination issue 88; consensus-ai issue 392).

Backticked paths in this document are the file map. Every other identifier —
module names, schema names, function names, version numbers, step ids — is
written unquoted on purpose, so the approved-path set derived from this plan is
exactly the set of files the implementation may touch.

The baselines say three things that decide this plan's scope:

- R4.implement and R5.compare are the wall-clock and tool-call hotspots
  (24.3% + 19.9% of a 56.92 min run on issue 88; 71% for implement on #392).
- Claude's input side is ~99% cacheRead in every phase — agents re-ingest the
  same repository state each turn. A fix only pays if it **replaces** discovery
  work, not if it stacks more prompt text.
- Ballot / selection / declare / finalize phases are each under 4% — protocol
  surgery there has no measurable return.

So this plan makes three small, separately measurable changes and deliberately
leaves the rest of the protocol alone:

1. **Coordinator-supplied repo context.** A new contextPaths workspace-config
   field; the coordinator names those files in every action.md under a
   "## Repo context" heading, and this repo ships one such file. Agents open a
   named short list instead of running a find/grep sweep to orient.
2. **Coordinator-supplied change scope.** For steps that bind an implementation
   or revision pin, the coordinator resolves the changed-path list once per tick
   through the existing bare mirror and renders it in the action, so four
   comparing agents do not each rediscover the same diff.
3. **Antigravity unattended launch.** agy is launched with "--mode accept-edits"
   only, so every out-of-whitelist tool call becomes an owner permission prompt —
   the cause of the pathological ~7 min median / ~2.3 h max Antigravity wait on
   issue 392. "agy --help" on this machine lists --dangerously-skip-permissions;
   the launcher template will pass it.

## Exact File List to be changed or deleted

- `src/state.ts` — add contextPaths to coordinatorConfigSchema and to
  workspaceDeclarationSchema, reusing the confinement refinement and uniqueness
  superRefine already applied to digestPaths; add contextPaths as an array with
  an empty-list default to startStateSchema, so a start.json written by an
  earlier version still parses under the strict schema.
- `src/cli.ts` — pass contextPaths from the config into the
  initializeOperationalState call in the start command, alongside checks and
  pollIntervalMs. contextPaths is **not** added to automationDigestMaterial:
  context files are advisory reading, not authority, and folding them into the
  digest would make every context edit invalidate a running issue.
- `src/setupWorkspace.ts` — carry the declared contextPaths (defaulting to an
  empty list) into the generated workspace config, next to the existing
  digestPaths line.
- `src/steps.ts` — extend InternalOrder with two fields: contextPaths, a
  readonly string array; and changeScope, a readonly array of
  { agent, commitSha, paths, truncated }.
- `src/action.ts` — in renderAction, emit a "## Repo context" section when
  contextPaths is non-empty and a "## Changed paths for the bound pins" section
  when changeScope is non-empty; both are omitted entirely when empty, so
  existing actions stay byte-identical. Every rendered path goes through the
  existing validatePublicField single-line check and is rejected if it contains a
  backtick, so a path cannot break out of the rendered code span or forge front
  matter. parseAction is unchanged: both sections live in the body, and the
  front-matter allowlist (actionId, agent, requiredPath) stays closed.
- `src/runLoop.ts` — in buildOrder, default contextPaths from the start state and
  accept a changeScope override parameter, following the existing
  approvedPathOverride pattern. In CoordinatorRunLoop, add a private
  resolveChangeScope helper that calls the existing mirror changedPaths method
  with the baseline sha and each bound input commit, once per bound input whose
  kind is implementation or revision, memoised per pin for the tick, truncated to
  the first 200 sorted paths with a truncated flag when the diff is larger. All
  four buildOrder call sites are updated to await and pass it.
- `config.example.json` — add a contextPaths entry naming `docs/repo-map.md`.
- `config.product.example.json` — add an empty contextPaths list beside the
  empty digestPaths list, so onboarding a product shows the field exists.
- `scripts/lib/launcher.sh` — in the launcher_command case statement, change the
  antigravity branch to exec agy with both --mode accept-edits and
  --dangerously-skip-permissions, with a comment recording why (permission
  prompts show up as agent wait, not as work). This file is the single source of
  truth read by both coord install and the post-merge hook, so neither caller
  drifts.
- `docs/coord-driver.md` — document contextPaths (what it is, that it is
  advisory, that it is not a digest source) and the two new action sections.
- `docs/setup-workspace.md` — one line in the digest discussion stating that
  contextPaths is deliberately excluded from automationDigestMaterial.
- `package.json` — bump the version from 0.0.14 to 0.0.15. Required: on a
  non-main branch the pre-1.0 ship gate demands a version strictly greater than
  the one on the base branch.
- `test/state.test.ts` — cases: a config with contextPaths parses; an absolute
  path and a parent-directory segment are rejected; duplicates are rejected; a
  start state object with no contextPaths key parses and defaults to the empty
  list.
- `test/action.test.ts` — cases: renderAction emits the repo-context section with
  each configured path in a code span; emits the changed-paths section with one
  block per bound pin and a truncation line when the truncated flag is set; omits
  both headings when the fields are empty (byte-identical to today's output);
  throws when a context path or changed path contains a backtick or a newline;
  parseAction round-trips an action carrying both sections.
- `test/runLoop.test.ts` — cases: buildOrder copies the start state's
  contextPaths into the order; an R5.compare order carries one changeScope entry
  per bound implementation pin, sourced from a stub mirror; the stub's
  changedPaths method is called once per distinct pin per tick even with four
  comparing agents; a step with no pinned inputs (R2.plan) produces an empty
  changeScope and no git call.
- `test/install.test.ts` — assert the generated Antigravity launcher contains
  --dangerously-skip-permissions, next to the existing Claude launcher
  assertions.

Nothing is deleted.

## Exact file list to be created

- `docs/repo-map.md` — the context file this repository points contextPaths at.
  Structural, not line-numbered, so it does not rot on every commit:
  - the driver's module groups and what each owns — protocol and evidence
    (protocol, evidence, pinValidation), the state machine and run loop
    (machine, runLoop, steps, state), action rendering (action, orderScaffold),
    workspace and install (setupWorkspace, install, hookSync, agentHookSync),
    harness surface (tmux, agentEvent, agentLifecycle), and analytics
    (analytics, transcriptRead);
  - the invariants an agent must not rediscover: runtime state lives outside
    every clone, AGENTS.md is skip-worktree, the launcher is generated per clone
    and never tracked, and the product hook tree is not a place to satisfy
    checks;
  - the real commands ("pnpm check:fast" before a commit, "pnpm check" for the
    coordinator gate) and where tests live;
  - a "start here for a change of kind X" table pointing at the module group
    rather than at a line.

## Tests

Automated, all under the existing vitest fast suite:

- Schema (`test/state.test.ts`): contextPaths accepted, confined, unique, and
  defaulted on a legacy start state — the last case is the one that proves an
  in-flight issue started on 0.0.14 keeps running after the upgrade.
- Rendering (`test/action.test.ts`): both sections appear only when populated; a
  backtick or newline in a path is rejected rather than rendered; an action
  carrying both sections still parses under the closed front-matter allowlist.
  The "omitted when empty" case is what guarantees this change cannot alter an
  action for a step that has no context and no pins.
- Ordering (`test/runLoop.test.ts`): changeScope is populated for pinned steps,
  empty for unpinned ones, and the stub mirror records exactly one changedPaths
  call per distinct pin per tick — the assertion that this optimisation does not
  itself add four redundant git invocations.
- Launcher (`test/install.test.ts`): the generated Antigravity launcher carries
  the unattended flag.

Commands, in order:

1. "pnpm check:fast" — lint, typecheck, fast tests. Required before each commit.
2. "pnpm check" — build plus check:fast plus e2e. This is the coordinator gate.

Manual verification (owner-visible, not automated):

3. Run coord install into an Antigravity clone, then confirm the regenerated
   launcher ends with an exec of agy carrying both --mode accept-edits and
   --dangerously-skip-permissions, and that agy starts without an interactive
   permission prompt on a repository script invocation.
4. Run "coord next --issue N" in an agent clone and read the published action:
   the repo-context section names `docs/repo-map.md`, and an R5.compare action
   lists the changed paths under each bound pin.

Measurement (the point of the issue — a change here is only "done" when it is
re-measured against the published baseline):

5. After the next full consensus run on this repo, run "coord analytics --issue N
   --coord-root <coord-runtime>" and compare against the issue-88 baseline on
   three numbers the owner already published: R4.implement and R5.compare minutes
   (13.84 / 11.31), Claude tool calls in plan/implement/compare (55 / 34 / 27),
   and the Antigravity wait median (48.6s on #88, ~7 min on #392).

## Alternatives Rejected

- **Inline the full contents of the context files into every action.** This is
  the obvious reading of "context files" and it is wrong here. Analytics
  conclusion 4 is that Claude's input is ~99% cacheRead — agents already
  re-ingest a large context every turn. Pasting file bodies into the action adds
  to that every turn for every agent, and it only pays if it removes more search
  than it adds text. Naming the paths costs a few dozen bytes and lets each agent
  read the file once. Rejected in favour of naming paths.
- **Generate the repo map automatically by walking the tree.** A generated map is
  language-specific, and this driver onboards products in any language (the
  product example config is a Go service). It would also be regenerated on a
  schedule nobody owns, and a wrong map is worse than no map. Rejected in favour
  of a short hand-written file the product controls, listed in config.
- **Instrument Cursor token and tool usage through its hooks.** The owner marked
  this optional, and it is the least certain item in the set: the agent-event
  module already handles Cursor's sessionStart, beforeSubmitPrompt, stop and
  sessionEnd payloads, and none of them is documented to carry token counts.
  Building the analytics join on an assumed payload shape risks reporting
  confident numbers that are wrong — the exact failure the honest "unavailable"
  coverage was designed to prevent. Deferred to a follow-up issue that starts by
  capturing a real Cursor stop payload.
- **Collapse or merge protocol steps (ballot, selection, declare, finalize).**
  Each is under 4% of wall clock in the measured run; conclusion 3 calls this low
  ROI. Merging them would also weaken the evidence chain that makes the workflow
  auditable. Rejected.
- **Rebuild or extend the Phase-1 analytics as the deliverable.** The owner
  stated explicitly: do not rebuild issue 91's analytics as the main issue 92
  deliverable; use it to verify wins. Rejected on instruction.
- **Add contextPaths to the automation digest.** It would make the digest cover
  more of what an agent reads, which sounds stricter. But the digest pins the
  authority of a running issue, and a context file is documentation an owner
  should be able to correct mid-run without invalidating every published
  artifact. Rejected; documented in `docs/setup-workspace.md` so the omission
  reads as a decision rather than an oversight.

## Risks and Mitigations

- **Version skew on strict schemas.** coordinatorConfigSchema and
  startStateSchema are strict. A config written by 0.0.15 containing contextPaths
  would be rejected by an installed 0.0.14 binary, and a start state from 0.0.14
  has no contextPaths key. Mitigated on both sides: the field defaults to the
  empty list everywhere, so old state parses under the new binary; and the
  version bump plus a coord install is part of this change, so a workspace is
  never left with a new config under an old binary. The legacy start-state case
  has a dedicated test.
- **changeScope mistaken for path approval.** The approved-path gate in the
  evidence module is what stops an implementation touching unapproved files. A
  changed-path list rendered in the action could be read as widening that
  approval. Mitigated by wording: the section is headed as the bound pins'
  contents and states in one line that it is informational and that approvedPaths
  remains the only authority. No code path reads it back.
- **Injection through rendered paths.** Context paths come from config and
  changed paths come from git, so neither is agent-authored; but both are
  rendered into a controlled document. Mitigated by routing every rendered value
  through validatePublicField and additionally rejecting backticks, with tests
  for both. The front-matter allowlist in parseAction is untouched.
- **Extra git work per tick.** Naively, four comparing agents against four pins
  is sixteen diff invocations. Mitigated by memoising per pin for the tick (four
  calls) and asserting the call count in `test/runLoop.test.ts`.
- **Enormous diffs bloating the action.** A revision that touches a thousand
  files would render a thousand lines into every action. Mitigated by the
  200-path cap and an explicit truncation line, so the action stays bounded and
  the agent is told the list is partial rather than silently believing it is
  whole.
- **--dangerously-skip-permissions widens what agy may do unprompted.** This is a
  real trade and it is the owner's stated intent: agent clones are disposable,
  the git hooks are the hard enforcement layer, and codex already launches with
  a full-access sandbox for the same reason (writing its completion file outside
  the clone). The flag is verified present in "agy --help" on this machine. If a
  future agy drops it, the launcher would fail at exec; the test asserts the
  generated content, and coord doctor does not validate vendor flags, so the
  failure surfaces at launch rather than silently.
- **The new context file going stale.** Any hand-written map rots. Mitigated by
  keeping `docs/repo-map.md` structural — module groups, invariants, commands —
  with no line numbers and no function-level detail, so ordinary commits do not
  invalidate it.

## Conclusion

Three changes, each traceable to a published measurement and each independently
verifiable: name the orienting files in the action rather than making four agents
find them; resolve the bound pins' changed paths once in the coordinator rather
than four times in the agents; and stop turning Antigravity permission prompts
into agent wait time. The protocol's evidence chain, the approved-path gate, and
the automation digest are all untouched, and every new section of the action is
omitted when empty, so a step with no context and no pins renders exactly the
bytes it renders today. Success is not "it merged" — it is the next coord
analytics run showing lower R4.implement and R5.compare minutes, fewer
plan/implement/compare tool calls, and an Antigravity wait median back in line
with Cursor's.

# Issue 158 — A welcoming, accurate README for coord

Restructure the landing page around what coord does, why a developer would use
it, and how to get started. This is documentation and original vector artwork
only; it does not change the interactive CLI, delivery budgets, agent behavior,
installation, verification policy, or repository visibility.

## Exact File List to be changed or deleted

- `README.md` — replace the specification-like front page with the structure
  below, retaining important qualifications and linking to detailed guides.
- `docs/coord-driver.md` — receive operator details removed from the README
  that are not already covered, primarily vendor quota/resource evidence and
  the agent-facing `coord next` instructions. Integrate them into existing
  lifecycle, completion, and hold sections instead of duplicating them.
- `docs/setup-workspace.md` — retain install alternatives and add the unique
  maintainer release-readiness checklist removed from the README near the
  existing public-bootstrap caveat. This preserves unresolved owner duties
  without putting them in the newcomer path.

No existing files are deleted. No source, test, hook, manifest, lockfile,
license, security-policy, contribution-policy, or agent-protocol files change.

### README content and ordering

1. Embed the local header graphic above `# coord`. Follow with a one-sentence
   value proposition and a short explanation: coord coordinates installed
   coding agents in separate Git clones to plan, peer-review, implement, and
   verify changes from a GitHub issue before publishing a PR. Show all four
   agent names as readable labels; the banner can use four matching badge-like
   pills without vendor logos or external image services.
2. **How it works:** a GitHub-native `mermaid` flowchart and a short equivalent
   prose sequence. Describe the default consensus profile: issue/readiness,
   independent plans, peer plan reviews and ballot, independent implementations
   of the selected plan by all active agents, peer code comparisons and
   implementation ballot, one selected reviser, revision/consensus ballots,
   cleanup and configured verification, then PR publication. Show the revision
   loop and an owner-intervention exit when escalation or the revision limit
   prevents approval. State the default maximum of three revision rounds.
   Failed final checks block publication; do not draw an invented automatic
   return from finalization to independent implementation. Briefly distinguish
   solo and reviewed profiles with a link to the existing Profiles section.
3. **Why coord:** concise bullets for review at both plan and code levels,
   independent proposals and ballots, separate agent clones, exact-commit
   verification using the project's declared tools, and owner control. Do not
   promise elimination of hallucinations or that passing checks proves code
   correct. Explain that default onboarding leaves the human product's tracked
   files untouched; do not label separate clones a universal security sandbox.
4. **Requirements** and **Quick start:** keep the `#requirements` anchor used by
   CONTRIBUTING. List Node 26, pnpm 11, Git, tmux, authenticated GitHub CLI for
   product issue/PR access, the chosen installed/authenticated agent harnesses,
   and product toolchains. Note macOS Terminal integration, other platforms'
   tmux use, and no native Windows guarantee. Present three numbered steps:
   the existing one-line bootstrap URL, `coord onboard /path/to/app`, then
   `cd /path/to/app` and `coord <issue-number>` for an existing issue in that
   product's GitHub origin. Make clear the issue number is a placeholder.
   Explain that unqualified onboard selects all four harnesses/consensus, and
   include the smaller `--agents codex --profile solo` alternative. Preserve
   the PATH hint and link to the inspect-first/private-fork install option;
   do not assert that this documentation change makes anonymous access work.
5. **Product languages:** a compact Go, Rust, Node (pnpm/yarn/npm), Make, and
   Python table. Say detection proposes recorded checks, not that any marker
   guarantees a runnable policy. Recognized Make targets and Node scripts must
   exist. Python uses `coord install --declare`, not an unsupported onboard
   flag. Link to the existing language/declaration details and emphasize that
   the driver's Node requirement is independent of product language.
6. **Owner control:** only a brief overview of status, pause, attach, steering,
   and recovery with links to the guide. Explicitly distinguish stopping the
   foreground coordinator from stopping agents. Link the nudge-loop recovery
   instructions rather than implying the interactive `r` menu resets budgets.
   Keep manual mode discoverable via a link, not its full internal lifecycle.
7. **Documentation**, **Contributing**, and **License:** link the operator guide,
   setup guide, CONTRIBUTING, SECURITY, and LICENSE using relative paths.
   Replace the stale claim that LICENSE is deferred: an MIT LICENSE already
   exists in this baseline. Leave private-reporting caveats authoritative in
   SECURITY, without claiming its release gate has passed. Link development
   commands from CONTRIBUTING instead of duplicating them. Keep the distinction
   that distribution is through GitHub rather than npm.

Aim for a skimmable landing page of roughly 150–200 lines, not a new reference
manual. Preserve existing README anchor headings where economical (especially
Requirements and Product languages); verify repository-local incoming links.
Do not copy the issue's illustrative Mermaid literally where it misstates
participants, isolation, checks, or PR readiness. The default PR policy opens
an unmerged draft for owner review; an explicit `coord-merged` policy exists,
so neither “always ready to merge” nor “never merges” is an accurate universal
claim.

### Documentation relocation

Map each removed operational block to its existing guide section before
deleting it from the README. Bootstrap flags/private forks and runtime layouts
already have setup-guide coverage; manual mode, foreground controls, delivery,
and finalization already have driver-guide coverage. Reuse those passages.

Move the unique vendor-resource details into a dedicated subsection of the
driver's owner-control/hold documentation: Claude status-line precedence,
sanitization and owner release; opt-in account-bound Codex quota reads, helper
caps, retry cadence, budgets and validated-version restrictions; Cursor and
Antigravity limitations; no clearing unrelated holds, manual pause, or nudge
budgets. Check the moved facts against the current implementation. Replace the
nearby historical issue-126/140 claims that no quota reads/status-line support
exist, since they would contradict the relocated current documentation.
Preserve the existing `--reset-nudge-budget` and live-runner/no-`--run` guidance.
Explain `coord next` beside the completion contract without overwriting the
separate Git-mode and private-response completion rules.

In the setup guide, retain the owner checklist's content/history audit,
private-reporting verification, protected agent-overlay caution, authorized
visibility change, and anonymous cold-install/sample-product doctor checks.
Link its existing issue-139 authority without marking those tasks complete.

## Exact file list to be created

- `docs/assets/coord-banner.svg` — one small, original, self-contained vector
  hero asset. Use a dark-slate panel with high-contrast text and restrained
  blue/green accents; depict the issue, the four named agent nodes, review and
  verification, and PR output at a conceptual level. Detailed transitions stay
  in Mermaid so the banner does not become a second state-machine spec.

This is the only new product file. Use an SVG viewBox, title/description, and
meaningful README alt text; no scripts, external fonts, embedded remote images,
foreignObject, animation, or image-generation dependency. Keep essential agent
names and workflow information available in surrounding Markdown. The requested
banner justifies this asset; the optional terminal screencast stays a follow-up.

## Reuse and Scope

Reuse the existing docs and command examples, not a new documentation framework.
The source of workflow truth is `WorkflowProfile`, `PrPolicy`,
`STEP_DEFINITIONS`, `stepsForProfile`, and `participantsForStep` in
`src/steps.ts`, together with `decide` in `src/machine.ts` and finalization
behavior in `src/finalization.ts`. Reuse `proposeProjectPolicy` in
`src/setupWorkspace.ts` and `onboard`/`install` in `src/install.ts` as the
authority for detection and onboarding claims. Check examples against
`src/cli.ts` and `scripts/bootstrap.sh` rather than adding commands to fit prose.

For relocated recovery documentation, reuse the existing `setOwnerPause` and
`releaseHold` semantics, the foreground controls in `src/interactive.ts`, and
quota/status-line implementations in `src/codexQuota.ts`,
`src/claudeStatusLine.ts`, and `src/resourceEvidence.ts`. These are read-only
references, not additions to the file map.

Reuse the existing bootstrap, onboarding, interactive, workflow, finalization,
and language-policy tests (`test/bootstrap.test.ts`, `test/onboard.test.ts`,
`test/interactive.test.ts`, `test/workflows.test.ts`, `test/finalization.test.ts`,
`test/verify-config.test.ts`) and their `makeProduct`/`ProductFixture` and
`ensureBuilt` helpers in `test/support/workspaceFixture.ts` through the normal
suites. No new runtime abstraction, dependency, fixture, test file, release
automation, public-visibility change, or change to agent containment is needed.

## Tests

This changes prose and one vector, not runtime behavior. Add no brittle
snapshot/string tests to the runtime suite. The focused before/after acceptance
checks are:

1. Landing-page review: before, there is no hero or Mermaid and internal release
   gates/quota-helper diagnostics occupy the front page; after, a newcomer can
   identify purpose, supported agents, workflow, prerequisites, and the three
   setup steps without reading those internals. Confirm the license statement
   now agrees with the existing LICENSE.
2. Content and link review: verify every local Markdown target and fragment,
   image target, and incoming README anchor in the changed docs. Every removed
   operational topic must have a reachable guide location. Compare all CLI
   snippets, profile participants, check semantics, and release qualifications
   to the read-only authorities above. Do not execute bootstrap, onboard, or
   issue-start examples against the live owner workspace to test prose.
3. Visual review: render the README with Mermaid support and view the SVG at
   desktop and narrow widths; check clipping, legibility, contrast, and fallback
   text. Validate SVG XML with
   `python3 -c "import xml.etree.ElementTree as E; E.parse('docs/assets/coord-banner.svg')"`.
   Verify the actual Mermaid diagram renders (plain Markdown preview without
   Mermaid is insufficient); record any unavailable rendering capability rather
   than treating source inspection as a rendering pass. Store temporary preview
   files or validation scripts only under .codex/tmp/; do not commit them or
   add package dependencies for documentation tooling.

Required repository commands: `pnpm check:fast` before commits and `pnpm check`
for full implementation acceptance (build, lint, source/test typecheck, fast
tests, and e2e). These reuse existing fixture-based coverage; neither needs live
agent accounts or a version bump. Do not alter timeouts, hooks, or tests merely
to mask a failure; report and investigate any failing check.

## Alternatives Rejected

- Copying the issue's mock diagram unchanged: it implies one consensus
  implementer, guaranteed sandboxing, and a checks-failure transition that do
  not reflect the current driver.
- README-only deletion of technical material: loses useful recovery and
  release-safety instructions. Existing guides are the right destinations.
- A raster/AI-generated banner or terminal recording in this issue: adds
  opaque or time-sensitive assets when editable vector art satisfies the hero
  requirement. The requested screencast is explicitly a follow-up.
- A new docs site, diagram build pipeline, dependencies, or runtime doc tests:
  disproportionate to a landing-page restructure and unnecessary for native
  Markdown, Mermaid, and SVG.
- Fixing the interactive hold-release UI, changing onboarding defaults, or
  modifying security/release policy: separate behavior changes outside #158.

## Risks and Mitigations

- **Attractive but inaccurate claims:** ground both visuals and prose in the
  existing state machine, toolchain detection, and default PR policy. Say
  isolated Git clones, not an absolute security guarantee.
- **Lost operational details or contradictory guides:** use the relocation
  checklist and replace only directly conflicting historical hold prose;
  preserve safety caveats and link to their new/existing homes.
- **Misleading quickstart:** put prerequisites before commands, explain the
  default four-agent roster, provide the solo alternative, and identify the
  product directory and issue-number placeholder explicitly.
- **Inaccessible visuals or broken links:** keep the SVG self-contained, provide
  text equivalents, use conservative Mermaid syntax/default theme colors,
  render both visuals, and inspect relative links and anchors.
- **Scope creep into release finalization:** keep LICENSE and SECURITY intact;
  linking the existing license does not claim reporting or visibility gates are
  complete. No product package version bump is planned.

## Conclusion

Change three existing documentation files and add one original SVG. Deliver a
clear, visual, source-accurate README with a working documented startup path,
preserve operational depth in the existing guides, and leave all coordinator
behavior and release authority unchanged.

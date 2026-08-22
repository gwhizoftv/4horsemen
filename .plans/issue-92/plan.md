# Issue 92 plan: cut implement/compare rediscovery and Antigravity wait

## Scope and Evidence

Issue 92 asks for coordinator efficiencies grounded in the Phase-1 analytics
shipped by #91, using the owner baselines recorded on the issue:

- coordination product issue 88 (~57 min consensus, 4 agents): **R4.implement
  ~24%** and **R5.compare ~20%** of wall time; Claude cacheRead dominates where
  coverage is complete; tool calls concentrate in plan/implement/compare.
- consensus-ai product issue 392 (~3.3 h): **R4.implement ~71% / ~139 min**;
  Antigravity nudge→intent waits are pathological (median ~7 min, max ~2.3 h).

Owner conclusions that bind this plan:

1. Prefer implement-step cost (shared/read-once context, fewer rediscoveries)
   over micro-optimizing join/ballot minutes.
2. Treat compare re-ingestion as the secondary target.
3. Ship Antigravity unattended launch so waits stop including owner permission
   loops.
4. Optionally extend Cursor usage coverage; do **not** rebuild #91 analytics as
   the main deliverable.
5. Keep changes small and re-measure against #88 and #392.

This plan therefore ships three bounded packages and explicitly **defers** the
issue-89 structural Phase-2 rewrite (combine review+ballot / compare+ballot and
coordinator-owned clerical selection/auth/declare). Those remove model turns but
are a separate authorization from the analytics-driven context/wait work here.

### Package A — shared context for R4.implement (primary)

When preparing `R4.implement`, the coordinator writes one deterministic
per-issue context capsule under the owner runtime (outside every clone) and
points every implement `action.md` at that absolute path first. The capsule is
assembled only from already-trusted sources:

- `github-issue.json` title/body snapshot;
- `baselineSha` / `issueSessionId` from start state;
- selected-plan `approvedPaths` already derived for the order;
- product `package.json` scripts and workspace `checks` / `verify.precommit`
  argv when those blobs exist at the baseline in the mirror;
- a short “do not treat hints as the approved file map” disclaimer.

Agents must still implement only the selected plan’s approved paths; the capsule
replaces repeated repo-mapping searches, not judgment or evidence rules.

### Package B — bound-input packet for R5.compare (secondary)

When preparing `R5.compare`, the coordinator materializes a content-addressed
read-only packet of every bound implementation pin (`commitSha` + `path`) via
the existing mirror `readBlob` trust boundary, writes a manifest with
source SHA/path/content hash, and injects the packet directory plus exact
`git show <sha>:<path>` fallbacks into the action. Citation and evidence rules
stay pin-based; the packet is an optimization with an independent read fallback.

### Package C — Antigravity unattended launch (wait)

Change the sole launcher template so Antigravity starts without owner
permission loops. Verify the exact current `agy` flag against the installed CLI
(owner baseline names `--dangerously-skip-permissions`; today’s template is
`agy --mode accept-edits`). Update setup notes and harness-ready detection only
if the ready banner text changes.

### Optional Package D — Cursor usage coverage (non-blocking)

Spike whether Cursor lifecycle hooks can emit usable token/tool fields. If yes,
extend hook sync + transcript/analytics readers minimally so `coord analytics`
stops reporting Cursor as permanently unavailable. If no, document the gap and
stop — do not invent a usage store or scrape unsupported private DBs.

### Explicitly out of scope

- Rebuilding or redesigning `coord analytics` / journal schemas as the main
  deliverable.
- Combining R3.review+ballot, R5.compare+ballot, or coordinator-owned
  selection / reviser-auth / declare (issue-89 structural Phase 2).
- Full repo indexer, embeddings, or MCP retrieval service.
- Changing evidence acceptance, pin validation, or final `checks` semantics.
- Editing product `githooks/` to satisfy verification.

## Exact File List to be changed or deleted

### Changed

- `package.json` — bump version from `0.0.14` to `0.0.15` so the non-`main`
  ship gate passes.
- `config.product.example.json` — bump installed coordination version to
  `0.0.15` to match the ship.
- `scripts/lib/launcher.sh` — change `launcher_command` for `antigravity` from
  interactive `accept-edits` to the verified unattended permissions flag; keep
  PATH export for `~/.local/bin`.
- `scripts/setup_antigravity.sh` — document unattended launch and remove
  guidance that implies owner must approve every edit loop for coordination
  runs.
- `src/paths.ts` — add helpers for `issueRoot/context.md` and
  `issueRoot/packets/<inputSetHash>/` under the existing `containedPath`
  safety boundary.
- `src/steps.ts` — extend `InternalOrder` with optional
  `contextCapsulePath` and `inputPacketPath` (absolute runtime paths) so
  `renderAction` / scaffolds can cite them without inventing bound pins.
- `src/contextCapsule.ts` — **created below**; wired from `runLoop`.
- `src/inputPacket.ts` — **created below**; wired from `runLoop`.
- `src/runLoop.ts` — on `prepareAction` / reissue for `R4.implement`, build or
  refresh the capsule and pass its path into `buildOrder`; on
  `R5.compare` (and compare-ballot only if it shares the same bound
  implementations), build or reuse the input packet and pass its path; prepend
  short “read capsule/packet first” notes to the task without changing
  `STEP_DEFINITIONS` evidence contracts.
- `src/orderScaffold.ts` — shorten R4.implement and R5.compare scaffolds to
  capsule/packet-first instructions; keep required JSON / `## Comparison` /
  `## Findings` contracts and pin-citation rules.
- `src/action.ts` — when a packet path is present, list each bound input with
  the exact `git show <sha>:<path>` fallback beside the existing
  commit/path line; when a capsule path is present, mention it once above the
  inputs list. Do not add new front-matter fields.
- `src/mirror.ts` — add only the minimal helpers packets need that are not
  already covered by `readBlob` (for example batch read + content hash, or
  safe write of packet files under a caller-provided contained directory). Do
  not loosen path confinement or fetch policy.
- `src/tmux.ts` — update Antigravity ready detection only if the unattended
  mode changes the pane banner that `harnessLooksReady` matches today.
- `docs/analytics.md` — add a short Phase-2 acceptance subsection: re-measure
  against issue 88 / issue 392 baselines; state that context packets and
  launcher changes are the #92 levers; Cursor coverage remains optional.
- `docs/coord-driver.md` — document capsule/packet runtime paths and that they
  are hints/optimizations, not substitutes for bound pins or approved paths.
- `test/cli.test.ts` — expect version `0.0.15`.
- `test/install.test.ts` — expect installed coordination version `0.0.15`.
- `test/orderScaffold.test.ts` — assert R4/R5 scaffolds mention capsule/packet
  when paths are supplied and still require the existing artifact headings /
  JSON keys.
- `test/action.test.ts` — assert rendered actions include capsule/packet paths
  and exact `git show` fallbacks without new front-matter keys.
- `test/runLoop.test.ts` — prove R4 prepare writes/refreshes capsule and R5
  compare prepare writes/reuses packet; prove evidence IDs, action IDs, and
  gate advancement are unchanged.
- `test/tmux.test.ts` — update Antigravity ready fixtures if launcher banner
  text changes.
- `test/mirror.test.ts` — cover any new batch-read / packet-write helpers.

### Deleted

- None.

## Exact file list to be created

- `src/contextCapsule.ts` — pure builder that renders deterministic markdown
  from issue snapshot, baseline metadata, approved paths, optional
  `package.json` script names, and configured check argv; writes atomically to
  the issue context path; never treats hints as approved paths.
- `src/inputPacket.ts` — given bound implementation inputs, read each blob from
  the mirror, write content, write `manifest.json` plus one file per input under
  `packets/<inputSetHash>/`, and return the packet directory path; reuse an
  existing hash directory when the manifest already matches.
- `test/contextCapsule.test.ts` — unit-test deterministic content, path safety,
  approved-path disclaimer, and graceful omission when optional blobs are
  missing.
- `test/inputPacket.test.ts` — unit-test manifest hashes, reuse on identical
  input sets, confinement under `issueRoot`, and fallback command listing.

## Implementation Details

1. Keep runtime format version and journal schemas unchanged unless Package D
   discovers a strictly additive optional field already allowed by existing
   parsers. Prefer deriving Cursor usage at analytics-read time over new
   workflow authority events.
2. Capsule and packet files live only under `--coord-root` issue directories.
   Never write them into agent clones or the product tree.
3. Capsule generation must be deterministic for the same start state + selected
   approved paths + baseline blobs so all implementers share one read-once
   file.
4. Packet `inputSetHash` is a hash of the sorted `(kind, agent, commitSha, path)`
   tuples for the action’s bound implementations so compare agents share one
   packet.
5. Every packet entry must remain independently verifiable with
   `git show <commitSha>:<path>` against fetched origin refs; the action text
   must include those commands.
6. Do not shrink or remove bound-input pins from `action.md`. Packets and
   capsules are additional read paths, not replacements for immutable binding.
7. Do not change `evidence.ts` acceptance rules, approved-path matching, or
   comparison citation requirements except where tests prove wording-only
   scaffold updates.
8. Antigravity launcher change is confined to `scripts/lib/launcher.sh` (the
   documented single source of vendor flags). Setup scripts and post-merge
   launchers already call `launcher_command`.
9. Before locking the Antigravity flag string, run `agy --help` (or equivalent)
   in the implementation environment and record the chosen argv in the commit
   message / docs note if it differs from the owner’s suggested spelling.
10. Package D is best-effort and must not block Packages A–C or final checks.
11. Version bump to `0.0.15` is required on this non-`main` branch before
    commits that touch workflow-critical paths.

## Tests

Focused while implementing:

```text
pnpm vitest run --config vitest.config.ts \
  test/contextCapsule.test.ts \
  test/inputPacket.test.ts \
  test/orderScaffold.test.ts \
  test/action.test.ts \
  test/runLoop.test.ts \
  test/mirror.test.ts \
  test/tmux.test.ts \
  test/cli.test.ts \
  test/install.test.ts
```

Before every commit on this branch:

```text
pnpm check:fast
```

Before coordinator acceptance / PR:

```text
pnpm check
```

Post-ship measurement (unchanged #91 surface; not part of unit tests):

```text
coord analytics --issue 88 --coord-root /Volumes/4TB-SOURCE/REPOS/coord/coord-runtime
coord analytics --issue 392 --coord-root /Volumes/4TB-SOURCE/REPOS/consensus/coord-runtime
```

Acceptance against those baselines (same profile/roster family):

- lower or equal R4.implement wall share and implement tool-call pressure on
  comparable runs;
- lower or equal R5.compare wall/token pressure where compare was previously a
  hotspot;
- lower Antigravity nudge→intent median/max on product runs that previously
  stalled on permissions;
- Cursor token coverage improved **or** explicitly still unavailable after the
  Package D spike;
- `pnpm check` green; evidence/pin/approved-path rules unchanged.

## Alternatives Rejected

1. **Issue-89 structural Phase 2 (merge review+ballot / compare+ballot;
   coordinator-owned clerical steps) as the #92 main deliverable.** That cuts
   `2N+3` model actions and remains valuable, but the owner’s #92 comment
   prioritizes implement/compare rediscovery and Antigravity wait using the new
   analytics. Keep structural consolidation as a follow-up authorization.
2. **Human-owned `.coord/context.md` only (discussion E1) without a
   coordinator-generated per-issue capsule.** Useful later, but stale product
   docs do not encode the selected plan’s approved paths or this issue’s
   snapshot; E3’s per-issue capsule hits the measured R4 hotspot directly.
3. **Full content-addressed repo map / embeddings / MCP retrieval (E2/E4).**
   Too large for a small measurable ship; risks dumping more tokens than they
   save.
4. **Shared explorer agent artifact (E5).** Saves searches but introduces a new
   sequential gate and groupthink risk; rejected for this phase.
5. **Rebuilding Phase-1 analytics or inventing Cursor transcript scraping.**
   Owner forbids treating #91 rebuild as the main #92 deliverable; unsupported
   store scraping would be fragile and out of trust bounds.
6. **Inlining full implementation blobs into `action.md`.** Would explode
   action bytes and cacheRead further; a separate packet with git-show fallback
   is the bounded form of discussion F3.
7. **Changing only nudge text or AGENTS.md protocol trim.** Nudges are already
   minimal; protocol trim helps cache pressure but does not address R4
   rediscovery or Antigravity permission waits called out in the baselines.

## Risks and Mitigations

1. **Capsule/packet increases tokens if agents still re-explore.** Mitigate by
   explicit scaffold instructions to read the capsule/packet first and by
   keeping capsules small (paths, scripts, issue summary — not full trees).
2. **Agents over-trust capsule hints as an approved file map.** Mitigate with
   an explicit disclaimer and unchanged `evidence.ts` approved-path checks.
3. **Packet weakens the mirror trust story if treated as authoritative without
   fallback.** Mitigate by always listing `git show` fallbacks and hashing
   manifest entries to source pins.
4. **Wrong Antigravity flag breaks launch or ready detection.** Mitigate by
   verifying `agy --help` before locking argv and updating `harnessLooksReady`
   fixtures in the same change.
5. **Unattended Antigravity increases blast radius of bad tool use.** Accepted
   for coordination clones that already grant Claude/Codex unattended
   equivalents; confine the flag to the Antigravity launcher only.
6. **Packet I/O cost on large implementations.** Mitigate with content-addressed
   reuse and by materializing only bound artifact paths (implementation-ready
   signals / cited paths), not entire trees.
7. **Scope creep into ballot consolidation.** Mitigate by the explicit out-of-
   scope list; reviewers should reject PRs that rewrite `machine.ts` step graphs
   under this issue without a new authorization.

## Conclusion

Ship a small, measurable efficiency slice: one shared R4 context capsule, one
R5 bound-input packet with git-show fallbacks, and Antigravity unattended
launch, plus an optional Cursor usage spike. Re-measure with existing
`coord analytics` against issues 88 and 392. Leave structural action-count
consolidation and analytics rebuilds for separately authorized follow-ups.

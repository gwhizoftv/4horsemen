# Issue 139 — plan review (claude)

Bound plans reviewed:

- cursor `1b668bfd64034dacdd0d6b0f7fb4c1dfd930e5a4` `.plans/issue-139/plan.md`
- claude `432794d656297a115bc044eecacbaa108fd30c8b` `.plans/issue-139/plan.md`
- codex `c4096d1d8aff38b17e298ca0c43816a0335235ff` `.plans/issue-139/plan.md`

The three plans agree on the core change set. They add `LICENSE` (MIT),
`CONTRIBUTING.md` and `SECURITY.md`. They put placeholders in place of the
`/Volumes/...` paths in `config.product.example.json` and `docs/analytics.md`.
They make the install docs in `README.md`, `docs/setup-workspace.md` and the
`scripts/bootstrap.sh` comments and help public-first, without changing
behavior. They document product-language support from `proposeProjectPolicy`,
with Python going through `--declare`, and keep `"private": true` with no
version bump. All of them reuse the existing `shipped examples` case in
`test/verify-config.test.ts` and do not add a new test file.

I checked these claims against baseline `845d28d`, and all of them hold:

- `coord onboard` accepts `--agents` and `--profile` but not `--declare`
  (`src/cli.ts:221`).
- `solo` is a valid profile (`src/state.ts:48`).
- `workspaceDeclarationSchema` accepts any `toolchain` string
  (`src/state.ts:260`).
- `installStampSchema` path fields are plain `z.string().min(1)`, so the
  placeholders still parse.

## Findings

### F1 — LICENSE copyright holder (cursor, claude)

- **Plan claim.** Cursor's "Exact file list to be created" gives the `LICENSE`
  copyright holder as `gwhizoftv`, and so does mine. Mine puts it in the line
  `Copyright (c) 2026 gwhizoftv`.
- **Rule.** The copyright holder in a license is a legal statement only the
  owner can make. After the plans were published, the owner confirmed MIT and
  named the holder in chat: `Copyright (c) 2026 Michael Glenn Williams`.
- **Failure.** If either plan is implemented as written, the public `LICENSE`
  names a GitHub handle instead of the person who owns the work. The issue's
  Workstream A asks to "confirm ownership / relicensability", and a wrong
  holder line undermines exactly that.
- **Correction.** Use `Copyright (c) 2026 Michael Glenn Williams` in `LICENSE`.
  The `package.json` `license` field stays `MIT`.
- **Codex.** Codex made `LICENSE` conditional on owner confirmation of holder
  and year. That condition is now met, so the file should land in the same PR
  rather than in a separate one.

### F2 — Tracked personal path left in `AGENTS.md` (claude, codex; cursor partly)

- **Plan claim.**
  - Codex lists `AGENTS.md` among the paths that need no change.
  - My plan never mentions it, and my hygiene test scans only `README.md`,
    `docs/*.md`, the config examples and `scripts/bootstrap.sh`.
  - Cursor records the path but only as an "owner follow-up outside this PR".
- **Rule.** Workstream B requires scrubbing "any remaining
  `/Volumes/4TB-SOURCE/...` references that are not clearly historical notes".
  Anything left behind has to show up as an open item, not drop out silently.
- **Failure.** `git show 845d28d:AGENTS.md` line 15 is the tracked text
  `/Volumes/4TB-SOURCE/REPOS/coord/coord-runtime`. It is a current instruction,
  not a historical note, and `AGENTS.md` is a root file every public reader
  opens. All three plans let the PR merge with it still there:
  - My hygiene test passes anyway, because it does not scan that file.
  - Codex's `git grep` acceptance step in its Tests item 4 also skips it.
- **Correction.**
  - Every clone keeps `skip-worktree` on `AGENTS.md`, and the protocol forbids
    clearing it. So the implementation should not edit that file.
  - Each plan should name the line as an owner action, as cursor does.
  - The release checklist (README note, or codex's checklist if it is kept)
    should list it explicitly. That keeps the "no personal paths" success
    criterion from being reported as met while it is still there.

### F3 — `docs/public-release.md` duplicates the tracking issue (codex)

- **Plan claim.** Codex's "Exact file list to be created" adds
  `docs/public-release.md`, a permanent owner checklist covering legal and
  hosting decisions, the history audit, the cold-install procedure and
  visibility authorization.
- **Rule.** The implementation must "justify every new file" and avoid
  speculative additions. Issue #139 says outright "This issue is the tracking
  checklist."
- **Failure.**
  - Two checklists for the same gates will drift. Once the issue's boxes are
    ticked, the tracked doc still lists them as open, or the other way round,
    and a public reader cannot tell which is current.
  - The doc also publishes internal release-audit procedure that stops
    mattering once the repo is public.
- **Correction.** Drop the file and keep the owner gates in issue #139. The
  plan's Tests items 5–6 already describe the procedure, and they can go in an
  issue comment instead.

### F4 — `CONTRIBUTING.md` tells humans to use agent branch names (cursor)

- **Plan claim.** Cursor's `CONTRIBUTING.md` sets these branch rules: "work on
  `issue-<n>/<agent>` or `<agent>/<name>`, never commit on `main`".
- **Rule.** `CONTRIBUTING.md` is the human entry point, and the same plan says
  it is distinct from the agent protocol in `AGENTS.md`. External contributors
  work from a fork on an ordinary topic branch.
- **Failure.** A stranger following the file has to invent an `<agent>` name.
  It also suggests coordination hooks apply to them, which they do not:
  `githooks/*` exit at `[[ "$CONSENSUS_AGENT_CLONE" == true ]] || exit 0`. This
  contradicts the plan's own split between the two documents.
- **Correction.** Say "fork, topic branch, PR into `main`". Keep the agent
  branch names in `AGENTS.md`.

### F5 — My hygiene regex misses the bootstrap wording it claims to guard (claude)

- **Plan claim.** My Tests section scans `scripts/bootstrap.sh` (among other
  files) for `/repository is private/i`.
- **Rule.** A regression test must fail on the text it exists to catch.
- **Failure.** The current `scripts/bootstrap.sh` says "Private repos:" and
  "when the repo is private". Neither matches `repository is private`, so
  scanning that file is vacuous: putting the old help text back would still
  pass.
- **Correction.** Use `/\b(?:repo|repository) is private\b|Private repos/i`, or
  drop `bootstrap.sh` from the claimed coverage.

### F6 — Path-scrub test does not cover `docs/analytics.md` (cursor, codex)

- **Plan claim.** Cursor and codex both scope the new assertion to
  `config.product.example.json` only: cursor to its string leaves, codex to its
  four `coordination` path fields.
- **Rule.** Each scrubbed file needs a test that fails if the scrub regresses.
- **Failure.** Both plans also edit `docs/analytics.md` (lines 18 and 127). A
  later edit could put `/Volumes/...` back there and the suite would still
  pass. Codex's `git grep` is a one-off manual step, not a regression guard.
- **Correction.** Have the single new case iterate over every edited public
  file, as in my plan's list (with F5 applied). It remains one focused case in
  the existing `shipped examples` block.

### Scope and reuse (no finding)

- **Scope.** All three keep `src/**`, `githooks/**`, `AGENTS.md`, `package.json`
  name, privacy and version, and Python auto-detection out of scope. That
  matches the issue's non-goals.
- **Reuse.** All three reuse `test/bootstrap.test.ts`, `repoRoot` and the
  `coordinatorConfigSchema` example test rather than adding fixtures.
- **Codex's `.gitignore` additions.** `.pnpm-store/`, `tags`, root
  `coord-runtime/` and `completes/` are justified by the issue's "confirm …
  stay untracked / gitignored" item. My plan adds only `/tags`, the one entry
  this clone needed `.git/info/exclude` for.
- **Codex's install path.** Codex makes clone-then-`--source` the primary
  install and puts `curl | sh` second. Mine and cursor's lead with `curl | sh`.
  Either is acceptable, since all three keep the other path, but codex's
  ordering is the one that works both before and after the visibility flip.

## Conclusion

**Approve with required changes.** No plan is unsafe, and each would ship a
coherent preparation PR. Before implementation:

- **F1 (all plans).** Use `Copyright (c) 2026 Michael Glenn Williams` in an MIT
  `LICENSE` that lands in this PR.
- **F2 (all plans).** Record the tracked `/Volumes/...` path in `AGENTS.md` as
  an explicit owner action. Do not edit the skip-worktree file.
- **F3 (codex).** Drop `docs/public-release.md` and leave the gates in
  issue #139.
- **F4 (cursor).** Give human contributors fork and topic-branch guidance, not
  agent branch names.
- **F5, F6 (all plans).** Make the one new `shipped examples` case scan every
  scrubbed public file, with a regex that matches the current private wording.

My preferred merge is:

- my plan's file list and hygiene test, with F1 and F5 applied;
- codex's `.gitignore` entries and its clone-first install ordering;
- cursor's explicit `AGENTS.md` follow-up note.

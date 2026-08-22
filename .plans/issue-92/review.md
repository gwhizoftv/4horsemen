# Issue 92 plan review (cursor)

Bound plans cited below:

- antigravity `dc6a7bdf3bc731b81382f0944b26cae400c8c21c`
- cursor `44a0512f2292d5dd16ff14b9eff2e4755b7d959b`
- claude `3c9b810b4ab3f329cae009004609d76bbfecfc09`
- codex `93dce7a2652e1e91488138aee97c6e0d52f932a7`

## Findings

1. **Antigravity plan (`dc6a7bdf…`) — Exact File List / Conclusion.** The plan
   claims the primary #92 work is consolidating review+ballot and compare+ballot
   plus coordinator-derived selection / reviser-auth / declare (`2N+3` action
   cut), with AGENTS.md trim and journal timing as supporting work. The rule
   that must hold is the owner’s published #92 direction: prioritize R4.implement
   / R5.compare rediscovery cost and Antigravity unattended launch; treat ballot
   / publish / declare / finalize surgery as low ROI; do not rebuild analytics as
   the main deliverable. If this plan is followed as written, the ship spends its
   budget on the low-ROI protocol rewrite, never changes
   `scripts/lib/launcher.sh`, and leaves the issue-392 Antigravity permission-wait
   pathology and implement/compare rediscovery hotspots unaddressed.
   Correction: demote structural consolidation to a follow-up; add the verified
   `agy --dangerously-skip-permissions` launcher change and a coordinator-supplied
   implement/compare context mechanism.

2. **Antigravity plan (`dc6a7bdf…`) — Exact file list to be created
   (`docs/architecture-context.md`).** The plan claims a new architecture doc
   will minimize exploratory tool calls. The rule that must hold is the baseline
   conclusion that extra context only pays if it *replaces* search rather than
   stacking unread text. If followed as written, nothing names that file in
   `action.md` or workspace config, so agents still spend plan/implement turns
   discovering where to start and may never open the doc. Correction: either
   wire a `contextPaths`-style reference into every action (as in the Claude
   plan) or drop the unreferenced doc from the file map.

3. **Antigravity plan (`dc6a7bdf…`) — Changed `src/action.ts` (`preparedAt`
   front matter).** The plan claims optional `preparedAt` in action front matter
   for latency measurement. The rule that must hold is that `parseAction` admits
   only `actionId`, `agent`, and `requiredPath`, and that #92 must not rebuild
   Phase-1 analytics as its main deliverable. If followed as written, either
   `readAction`/`parseAction` rejects every prepared action until the allowlist
   widens, or the ship grows journal/action timing instrumentation instead of
   the owner-named wait/context fixes. Correction: omit `preparedAt`; measure
   waits with existing lifecycle / `coord analytics`.

4. **Cursor plan (`44a0512…`) — Package B (R5 input packet).** The plan claims
   materializing each bound implementation `commitSha`+`path` into a packet will
   trim compare re-ingestion. The rule that must hold is that R5.compare bound
   inputs use the product pin as `commitSha` but keep `path` as the
   implementation-ready *signal* path (see `inputFromSubmission(..., true)`), so
   a packet of bound blobs is a set of tiny `.signals/.../implementation-ready-*.json`
   files, not the product diffs compare agents must read. If followed as written,
   Package B ships and still leaves agents to rediscover
   `changedPaths(baseline, productPin)` contents—the actual compare cost.
   Correction: for compare, resolve and expose the mirror `changedPaths` list
   (and/or packet those paths), as in the Claude plan’s `changeScope`, instead of
   only materializing bound signal blobs.

5. **Cursor plan (`44a0512…`) — Package C (Antigravity launch).** The plan
   claims to change Antigravity “from interactive `accept-edits` to the verified
   unattended permissions flag.” The rule that must hold is that current `agy`
   treats `--mode accept-edits` and `--dangerously-skip-permissions` as separate
   flags (both present in `agy --help`), and ready detection today matches
   accept-edits banner text. If followed as written by *replacing* `--mode
   accept-edits`, launch mode/ready detection can regress while still needing the
   skip-permissions flag for the wait fix. Correction: keep `--mode accept-edits`
   and add `--dangerously-skip-permissions` on the same `exec` line.

6. **Claude plan (`3c9b810…`) — Exact File List / Tests (`package.json` →
   `0.0.15`).** The plan bumps `package.json` to `0.0.15` and updates
   `test/install.test.ts` only for the Antigravity launcher flag. The rule that
   must hold is that `pnpm check:fast` on this branch already asserts package
   version `0.0.14` in `test/cli.test.ts` and installed coordination version
   `0.0.14` in `test/install.test.ts`. If followed as written, the version bump
   lands and `pnpm check:fast` fails on those unchanged expectations before any
   efficiency behavior can be validated. Correction: add both version assertions
   (and `config.product.example.json`’s `coordination.version` if that fixture is
   still asserted) to the Exact File List.

7. **Claude plan (`3c9b810…`) — Scope item 1 / `docs/repo-map.md`.** The plan
   correctly targets R4/R5 hotspots but supplies the same static
   `contextPaths` map on every action. The rule that must hold for the owner’s
   *primary* R4 lever is that implementers share issue-specific, selected-plan
   scope (approved paths, check argv / scripts) without each re-deriving it.
   If followed as written, implement actions gain orientation docs but still each
   re-parse selected plans and rediscover validation commands from the repo,
   under-hitting the R4-specific rediscovery the baselines call out.
   Correction: keep `contextPaths`, and additionally inject selected
   `approvedPaths` plus configured check/script names into R4 orders (runtime
   capsule or action section).

8. **Codex plan (`93dce7a…`) — Scope / Conclusion / Alternatives Rejected.** The
   plan claims the #92 deliverable is a versioned workflow that removes join,
   combines review/compare with ballots, and coordinator-derives clerical steps
   (13→7 phases, 37→22 actions), and it explicitly rejects building context first.
   The rule that must hold is the same owner #92 ranking: implement/compare
   rediscovery and Antigravity unattended launch first; ballot/declare surgery
   low ROI; use #91 analytics to verify wins, not as a workflow-version rewrite
   mandate. If followed as written, the entire ship is the deferred issue-89
   structural Phase 2, `scripts/lib/launcher.sh` is untouched, and the measured
   #392 permission waits plus R4 tool thrash remain. Correction: reject this
   plan as the #92 selection; authorize it only as a separate issue after the
   context/wait slice ships.

## Conclusion

Prefer the Claude plan’s shape (advisory `contextPaths`, coordinator
`changeScope` via mirror `changedPaths`, Antigravity
`--dangerously-skip-permissions` beside `--mode accept-edits`) after fixing its
missing `0.0.15` version-test updates and strengthening R4 with selected-plan
scope injection. Take Cursor’s Antigravity “add flag, don’t replace mode”
correction and discard Cursor Package B as specified (bound-signal packets do
not trim compare code reads). Do not select the Antigravity or Codex plans for
#92: both spend the issue on low-ROI protocol consolidation and omit the
launcher wait fix the baselines require.

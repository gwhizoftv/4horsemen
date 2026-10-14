# Issue 209: phase-length analysis of the last five coord runs

Issue 209 asks for an analysis of the last five issues run with `coord <issue>`
and a proposal for shortening the phases, written as a comment on the issue.
This is an analysis and writing task. It changes no product behavior. The
committed deliverable is one Markdown document. After the issue is approved,
the document's exact bytes become the issue comment.

## Exact File List to be changed or deleted

None. No source, test, configuration, template, hook, script, or existing
document is changed or deleted. In particular, `docs/analytics.md`,
`src/analytics.ts`, and the runtime `config.json` stay untouched. Proposals that
would change them are written up as follow-up candidates, not carried out here.

## Exact file list to be created

- `docs/issue-209-phase-efficiency.md`: the analysis and ranked proposal. Its
  full contents are the body of the issue-209 comment.

## Reuse and Scope

**Run selection (fixed, so every implementation analyzes the same input).** The
"last five issues run" are the five most recent completed runs under
`<coord-runtime>` (`/Volumes/4TB-SOURCE/REPOS/4horsemen/coord-runtime`), ordered by
the journal's `started.at` and excluding issue 209 itself. Issue numbers do not
follow run order:

| issue | started (UTC) | profile |
| --- | --- | --- |
| 177 | 2026-10-10T22:48:18Z | consensus |
| 195 | 2026-10-12T22:43:41Z | consensus |
| 184 | 2026-10-13T20:31:20Z | consensus |
| 204 | 2026-10-14T01:55:48Z | consensus |
| 206 | 2026-10-14T03:24:28Z | solo |

Issue 172 (started 2026-10-09) is the sixth most recent run and is excluded.

**Reused tooling and definitions.** Nothing new is built.

- `coord analytics --issue <n> --coord-runtime <coord-runtime>`, implemented in
  `src/analytics.ts` and covered by `test/analytics.test.ts`. This is the primary
  source for per-phase time, paused versus unpaused time, phase count, agent
  waits (`nudged` → `intent-seen`), ballot response latency, recorded
  verification runners (by trigger and phase, plus reuse, joins, and queue wait),
  final-check duration, and claude token and tool counts with their coverage
  labels. It is read-only. I have confirmed that it reads all five runs.
- The phase-interval and coverage rules in `docs/analytics.md` §2.1 and §5.
  Phase boundaries come from `gate-advanced` events. Absent data is reported as
  unavailable, never as zero. A token figure is reported only together with its
  coverage label. The new document follows these rules instead of redefining
  them.
- Read-only journal fields, used only for the breakdown below that
  `coord analytics` does not yet print: `action-prepared`, `nudged`,
  `nudge-deferred` (`details.code`), `intent-seen`, `verify-result`,
  `response-accepted`, `ballot-batch-pending`/`ballot-batch-published`,
  `gate-advanced`, `verification-run` (`trigger`, `phase`, `classification`,
  start and end times), `final-check`, `hold-created`/`hold-released`, and
  `paused`/`resumed`. Each run's `verification-logs/` and
  `agent-lifecycle.json` are consulted only to explain an outlier.

**Breakdown method (stated in the document so reviewers can reproduce it).** For
each phase interval and each agent, split the interval into:

1. Coordinator lead: from the interval start to the first `action-prepared`.
2. Delivery: `action-prepared` → `nudged`, plus the count of `nudge-deferred`
   events by `code`.
3. Pickup: `nudged` → `intent-seen`.
4. Agent work: `intent-seen` → the accepting `verify-result` or
   `response-accepted`, with recorded hook verification time inside that span
   shown separately.
5. Straggler wait: from the first agent's acceptance to the last agent's
   acceptance.
6. Coordinator tail: from the last acceptance to `gate-advanced`, including
   ballot batch publication.

Pauses and holds are reported as their own category and are never counted as
agent time. Any such joins are computed with a throwaway script in the session
scratchpad. That script is not committed. The document states each join in
words, so the script is not needed to check the numbers.

**Document outline for `docs/issue-209-phase-efficiency.md`:**

1. Summary: the three largest savings, in minutes per run.
2. Runs analyzed and method: the table above, the commands, and the breakdown
   rules.
3. Per-phase table across the five runs: minutes per phase per run, with both
   the elapsed and unpaused headlines, and the median and share of unpaused
   time.
4. Where the time goes: the breakdown above, aggregated by phase.
5. Ranked proposals. Each proposal states:
   - the measured evidence (run, phase, and number);
   - the expected saving in minutes per run, derived from those numbers;
   - the code or configuration area a follow-up would touch, as a pointer only;
   - the safety or consensus risk.

   The hypotheses below come from the analytics already run. The
   implementation must confirm or drop each one using the measurements; none
   may be asserted without a number:
   - Owner absence and pauses dominate elapsed time. For example, 177 has
     969 min paused, and 184 spends 184 min in R6.ballot waiting on one agent.
     A stalled agent should alert the owner, or the run should time out to a
     drop or quorum.
   - The slowest agent sets every phase length. The median pickup wait for
     cursor and codex is several times claude's.
   - Hook verification in R4.implement and R6.revise runs the full precommit
     `check:fast` and prepush `test:e2e` with no reuse (`Reused results=0` in
     all five runs). The final checks then re-run the suite on a tree already
     verified.
   - The runtime `config.json` has no `documentation` profile, so
     evidence-adjacent and docs-only commits fall through to product checks.
   - Ballot-only phases: R3.plan-ballot ran 11.65 min in 195, and
     R5.compare-ballot ran about 5 min in several runs.
   - Join and delivery overhead: 31–52 `nudge-deferred` events per run.
6. Measurement gaps: data the journals cannot answer, such as token coverage
   for codex and cursor, and any `partial` coverage labels.
7. How to verify a follow-up: re-run `coord analytics` and compare the same
   table.

The document contains no transcript content, prompts, session IDs, or absolute
home paths. Runtime locations are written as `<coord-runtime>/issue-<n>/`, as
`docs/analytics.md` does.

**Publishing the comment (outward-facing; happens exactly once).** Nobody posts
until the coordinator has approved the implementation. During R7.finalize,
after final checks pass, the finalizing agent posts with:

```sh
gh issue comment 209 --repo gwhizoftv/4horsemen --body-file docs/issue-209-phase-efficiency.md
```

The file must come from the approved pin. Before posting, the agent runs
`gh issue view 209 --repo gwhizoftv/4horsemen --comments` and does not post if
a comment starting with the document's first heading already exists. If the
finalize action does not authorize a GitHub comment, the agent does not post.
It notes this in the PR body instead, and the owner posts the same file after
merging.

**Justification for the one new file.** The issue's deliverable is a standalone
comment. A dedicated file is the comment byte for byte, so reviewers approve
exactly the text that will be published, and that text is pinned. Appending to
`docs/analytics.md` was considered and rejected (see Alternatives). There is
precedent for per-issue documents in `docs/issue-193-plan.md` and
`docs/issue-197-plan.md`.

## Tests

No unit, system, or e2e tests are added. The change is one new Markdown file
that no code reads. A test that fails before the change and passes after it
would only assert that the file exists, which proves nothing about whether the
analysis is right.

Validation of the deliverable:

- **Reproducibility.** For each of 177, 195, 184, 204, and 206, every
  per-phase minute value, paused and unpaused headline, agent-wait median, and
  verification runner total in the document must equal the output of
  `coord analytics --issue <n> --coord-runtime /Volumes/4TB-SOURCE/REPOS/4horsemen/coord-runtime`
  at two decimal places. Reviewers check this by re-running the command.
- **Breakdown sums.** For each phase in each run, the categories must add up to
  that phase's `coord analytics` duration within 0.05 min. Paused time is a
  separate category.
- **Proposal completeness.** Every proposal cites at least one run, phase, and
  measured number, an estimated saving, and a risk. Every hypothesis listed in
  Reuse and Scope is either supported with numbers or explicitly dropped.
- **Format.** The document renders as GitHub Markdown. It is under GitHub's
  65,536-character comment limit (`wc -c docs/issue-209-phase-efficiency.md`).
- **Hooks.** The runtime has no documentation profile, so a commit under
  `docs/` is classified as a product change. The installed hooks therefore run
  precommit `pnpm run check:fast` and prepush `pnpm run test:e2e`. The hooks own
  those runs, and they are not repeated by hand. Full `pnpm run check` at the
  approved pin is coordinator-owned.

## Alternatives Rejected

- **Post the comment only, with no committed file.** Consensus compare and
  ballot need a pinned artifact to judge, and posting before approval would
  publish text nobody reviewed. Posting more than once, for example once per
  competing implementation, would leave duplicate public comments.
- **Append a section to `docs/analytics.md`.** That document is the measurement
  contract and the issue-76 baseline, and its §4 says it lists "findings, not
  proposals". Adding a proposal there would mix the two. The comment body would
  also have to be cut out of a larger file, which risks posting text that
  differs from what was reviewed.
- **Extend `coord analytics` to print the breakdown or a five-run
  aggregate.** This is useful, but it is a product change with tests and is not
  needed to answer the issue. It is listed as a candidate follow-up if the
  breakdown proves valuable.
- **Pick runs by issue number (the five highest below 209).** That gives the
  same set today, but run order is the issue's meaning ("last five run"). The
  `started.at` ordering is explicit and reproducible.
- **Implement any of the proposals now.** That is out of scope: the issue asks
  for a proposal, and each change needs its own issue, plan, and tests.

## Risks and Mitigations

- **Outlier runs skew conclusions.** 177 has 969 min paused, and 184 has a
  184 min single-agent ballot stall. The document reports elapsed and unpaused
  time side by side, uses medians across runs, and handles owner absence as its
  own proposal, not as agent slowness.
- **Mixed profiles.** 206 is a solo run with only four phases. Its numbers are
  shown, but it is left out of cross-run medians for consensus-only phases, and
  each table says so.
- **Rosters differ.** 177 has four agents including antigravity, and the
  others have three. Per-agent figures are labelled with the agent, and
  straggler conclusions are stated per roster.
- **Token data is partial.** Only claude transcripts are local, and their
  coverage is labelled `partial`. Token figures are shown with their coverage
  label and are not used as the sole evidence for any proposal.
- **Data drift.** The runtime directories are read live. Runs 177–206 are
  complete and immutable, but the document records the `coord --version` used.
  It does not read issue 209's own in-progress journal.
- **Publishing.** The comment is outward-facing. It is posted once, from the
  approved pin, after a duplicate check, and only if the finalize action
  authorizes it. Otherwise the owner posts it. The document contains no
  secrets, transcript excerpts, session IDs, or home paths.
- **Verification cost of a docs-only change.** With no documentation profile,
  the hooks run the full product suite, roughly 10 minutes per commit/push
  pair. This is accepted rather than worked around. The document reports it as
  a measured finding and does not edit `config.json` or `githooks/`.

## Conclusion

Create one document, `docs/issue-209-phase-efficiency.md`, and change nothing
else. The document analyzes the five most recent coord runs (177, 195, 184,
204, 206), selected by `started.at`. Its numbers come from the existing
read-only `coord analytics` reader, plus a stated journal-only breakdown into
delivery, pickup, work, straggler wait, coordinator time, and pauses. It ends
with ranked, measured proposals for shortening phases. Every number can be
reproduced with one command per run. The approved file is posted once, verbatim,
as the issue-209 comment. No product behavior, configuration, or tests change.

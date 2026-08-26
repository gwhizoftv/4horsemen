# Issue 110 — Implementation comparison

Bound pins:

- cursor: `029a6844bfe626e9477ba416d3c5835ec3eaf797` (`.signals/issue-110/implementation-ready-cursor.json`)
- claude: `ca1b8d0e87237099b903e7d2bcf8e60ab4ab124f` (`.signals/issue-110/implementation-ready-claude.json`)
- codex: `02c14e68114d999609f9586c0c0c3c0a20254b05` (`.signals/issue-110/implementation-ready-codex.json`)

Selected plan: Codex `da91466d268ecc83745f04ef303b6d8c27bceb35` at `.plans/issue-110/plan.md`.

## Comparison

All three pins deliver the core issue-110 shape: response-mode ballot actions, private `responses/<actionId>.json`, immutable accepted-response archives, runtime format 4, coordinator-authored protocolVersion-2 ballots on `issue-N/coordinator-evidence`, and a publication barrier before #109 derive/advance. The differences that matter for selection are barrier matching after roster change, nested-workspace launcher grants, wipe retention, rationale bounds, and how thoroughly tests police those contracts.

### Pin sketches

- **cursor (`029a6844bfe626e9477ba416d3c5835ec3eaf797`)** — Evidence commit/reconcile live in `ballotPublication.ts` with hermetic author identity. Machine requires a published batch whose ordered `activeRoster` matches the current roster. Launcher peels nested `workspaces/<project>/` topologies to the outer coord root before granting the response directory. Rationale cap is non-whitespace UTF-16 length ≤ 1000. `wipe-issue` always deletes the evidence branch. Broad ballot/install/wipe unit coverage; little evidence-specific `mirror.test` depth.

- **claude (`ca1b8d0e87237099b903e7d2bcf8e60ab4ab124f`)** — Strongest mirror encapsulation (`createEvidenceCommit` with post-commit tree proof and ambient `GIT_AUTHOR_*` stripping) and opt-in `--delete-evidence` retention. Publication barrier matches only `stepId` + `round` + `status === "published"`, ignoring roster and response digests. Launcher takes `dirname(coord.workspaceConfig)` as the coord root for both flat and nested layouts. Rationale is `.max(1000)` on the whole string. Broadest focused mirror/evidence tests.

- **codex (`02c14e68114d999609f9586c0c0c3c0a20254b05`)** — Strongest machine barrier: published batch must match roster **and** the closed response digests. Solid TOCTOU re-stat / archive linking. Same nested-launcher dirname bug as Claude. `hasPublishedBallotBatch` returns true for `formatVersion < 4`, and consensus can fall back to Git `accepted` submissions. Thinnest ballot/install tests; install expectations cover the mailbox grant more than the response grant.

### Findings

1. `src/machine.ts` (claude `ca1b8d0e87237099b903e7d2bcf8e60ab4ab124f`, publishedBatch ~lines 77–80): after the active denominator closes, advancement and tally must require a published batch that matches the current roster/round/input set. Claude accepts any published batch for the same step/round, so a pre-drop published batch can still unlock derive/escalate after the roster changes. Cursor matches roster (`029a6844…` `src/machine.ts` ~77–84); Codex matches roster and digests (`02c14e68…` `src/machine.ts` ~91–112). Illustrative test: drop one agent after a published plan-ballot batch and assert the machine emits `publish-ballot-batch` (or wait) rather than `derive-plan-selection`.

2. `scripts/lib/launcher.sh` (claude `ca1b8d0e…` ~164–167; codex `02c14e68…` ~144–146): the response `--add-dir` must resolve from the real coord root. Nested installs store config at `…/workspaces/<project>/config.json`, so `dirname(config)` is the workspace directory, not the outer runtime root. Those pins grant a non-existent nested path; sandboxed harnesses cannot write ballot responses. Cursor peels `workspaces/` correctly (`029a6844…` `scripts/lib/launcher.sh` ~154–164). Illustrative test: install with a nested workspace layout and assert the generated launcher’s `--add-dir` contains `<coord-root>/issue-N/agents/<id>/responses`.

3. `test/install.test.ts` (codex `02c14e68114d999609f9586c0c0c3c0a20254b05` ~600): launchers must grant both the completion drop and the agent response directory, never the issue root, peers, or archive. Codex’s expectation is dominated by the mailbox grant, so the nested response-path bug can ship unnoticed. Cursor and Claude assert both grants.

4. `src/machine.ts` (cursor `029a6844bfe626e9477ba416d3c5835ec3eaf797` ~77–84): a matching published batch should bind the closed response set (digests / input-set hash), not only the roster. Same roster and round with replaced judgments can still treat an older published batch as sufficient; Codex would require a superseding batch. Less severe than Claude’s roster-blind barrier, but weaker than the selected plan.

5. `src/wipeIssue.ts` (cursor `029a6844bfe626e9477ba416d3c5835ec3eaf797` ~326–347): evidence is retained after ordinary completion; destructive wipe may remove it explicitly. Cursor deletes `coordinator-evidence` on every wipe with no `--delete-evidence` opt-in. Claude (`ca1b8d0e…` ~330–334) and Codex (`02c14e68…` with `deleteEvidence`) keep evidence unless the owner opts in. Illustrative test: wipe without `--delete-evidence` and expect `origin/issue-N/coordinator-evidence` to remain.

6. `src/protocol.ts` (claude `ca1b8d0e…` ~42–47; codex `02c14e68…` ~32–35): private responses are capped at 1,000 UTF-16 code units of **non-whitespace** rationale. Claude/Codex enforce `.max(1000)` on the whole string, so whitespace padding can hide long rationales or reject short non-whitespace content with long padding. Cursor implements the non-whitespace UTF-16 metric (`029a6844…` `src/protocol.ts` ~32–44).

7. `src/machine.ts` (codex `02c14e68114d999609f9586c0c0c3c0a20254b05` ~91, ~231–233): format 4 rejects formats 2/3 with wipe/restart and must not keep dual-mode ballot semantics. Codex returns published-batch success for `formatVersion < 4` and can tally consensus from Git `accepted` submissions. Even if loaders usually throw first, the machine still encodes a migration path the plan rejected.

8. Codex test surface (`02c14e68114d999609f9586c0c0c3c0a20254b05` `test/ballotResponse.test.ts`, `test/ballotPublication.test.ts`, `test/install.test.ts`): the selected plan’s required classes include schema/path/archive, batch hash/one-commit, FF push/conflict/retry, roster supersession, wipe retention, and dual launcher grants. Codex’s focused suites are thin relative to Claude’s `test/mirror.test.ts` evidence cases and Cursor/Claude’s broader ballot/install coverage, so findings 2–3 and 6–7 are under-policed.

### Recommendation

Prefer **cursor** `029a6844bfe626e9477ba416d3c5835ec3eaf797`.

It is the only pin whose launcher correctly grants nested-workspace response directories (this repository’s real topology), it enforces a roster-matched publication barrier (avoids Claude’s post-drop advance hole), it matches the plan’s rationale metric, and its install/ballot tests exercise the dual grant. Remaining gaps—digest-matched barrier, always-delete wipe, thinner mirror evidence tests—are smaller than Claude’s barrier hole plus nested grant break, and smaller than Codex’s nested break, thin verification, and format-fallback residue.

If cursor is rejected: prefer **claude** when mirror/evidence rigor and wipe retention matter more than digest-perfect barrier matching, but only after fixing `publishedBatch` and the nested launcher. Prefer **codex** only when the digest-matched barrier is the primary selection criterion and launcher/tests are fixed before merge.

### Shared strengths

- Response-mode action/step union, private response paths, immutable archives, format 4, coordinator evidence branch, origin publication before derive/advance, and ballot files kept off the product `finalSha`.
- Narrow launcher intent (mailbox + own responses only). Cursor alone resolves nested layouts correctly.
- Claude uniquely hardens mirror evidence identity and tree contents; Cursor and Claude both carry substantially broader unit/integration updates than Codex.

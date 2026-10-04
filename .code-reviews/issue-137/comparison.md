# Issue 137 — implementation comparison (cursor)

Bound implementation pins:

- cursor: `13804a10c6fdb0965c79d016559397fe4adf304b`
- claude: `f8543ea6bd7fe695ecb1b25638a29100d67cff3c`
- codex: `a4d2b46480d89b5dfcd79991e520530b4ed427ac`
- antigravity: `b915e8c9f45a032a4afa1498ef229083de8ac1e8`

All four implement the selected plan’s core shape: dual-outcome at the implement/revise required path, an `R4.amend-ballot` detour, sequence-keyed votes, and map growth only after published unanimous approval. Differences below are protocol-breaking or materially incomplete versus the selected plan.

## Comparison

1. **antigravity `b915e8c9` — `templates/product/AGENTS.protocol.md:152`.**
   Rule: a plan-amendment request must be published at the current implement/revise required signal path so `evaluateEvidence` can read `order.requiredPath`.
   Failure: AGENTS tells agents to write `.plans/issue-<n>/plan-amendment-request-<agent>.json`; admission never sees that blob, so the overlooked-file deadlock remains.
   Test: assert the installed overlay names the same path as `STEP_DEFINITIONS["R4.implement"].requiredPath`.

2. **antigravity `b915e8c9` — `src/machine.ts:152–166` vs claude `src/machine.ts:185–242`.**
   Rule: when multiple valid requests arrive, freeze at most one in active-roster order and explicitly defer the rest.
   Failure: antigravity accepts the first observation as a normal submission carrying `amendmentRequest`; concurrent peers are not roster-ordered or reissued with a “ballot already open” outstanding, so a later author’s request can be silently dropped.
   Test: two simultaneous requests from roster `[codex, claude]` must open only codex’s request and reissue claude.

3. **codex `a4d2b464` — `src/protocol.ts:104` (`rationale`) vs plan field `explanation`.**
   Rule: the request artifact must carry a nonblank `explanation` of the omission (selected plan §1; peers use `explanation`).
   Failure: agents/docs/fixtures that follow the plan’s field name fail schema validation; published requests are not interchangeable with claude/cursor/antigravity.
   Smallest fix: rename to `explanation` (keep rationale only on ballot responses).

4. **cursor `13804a10` — `src/protocol.ts:168` (`artifact: "plan-amendment-ballot"`).**
   Rule: coordinator-published amendment ballots use `artifact: "amendment-ballot"` (plan + claude/codex/antigravity).
   Failure: evidence tips and any consumer expecting the plan literal reject cursor’s published batch files.
   Test: `test/ballotPublication.test.ts` / integration tip parse for `"amendment-ballot"`.

5. **claude `f8543ea6` / cursor `13804a10` / antigravity `b915e8c9` — prefix matching on amended paths (e.g. claude `src/evidence.ts:167–171`).**
   Rule: amendment additions authorize exact files only; plan-map directory/prefix semantics must not apply to those additions (plan §1; codex `src/evidence.ts:167–172` with `exactApprovedPaths`).
   Failure: approving `src/foo.ts` also authorizes `src/foo.ts/extra` under prefix matching.
   Test: after an approved amendment for `test/foo.test.ts`, a pin that also touches `test/foo.test.ts.bak` must fail out-of-map.

6. **claude `f8543ea6` / cursor `13804a10` / antigravity `b915e8c9` — empty coordinator map fail-open (e.g. claude `src/evidence.ts:380`, cursor `src/evidence.ts:336`).**
   Rule: a missing coordinator-approved map must fail closed, not fall back to the agent’s self-declared `approvedPaths` (plan §3; codex `src/evidence.ts:335–336`).
   Failure: with `order.approvedPaths = []`, a ready signal can authorize whatever paths the agent listed.
   Test: implement-ready with empty order map rejects with “no selected plan file map”.

7. **cursor `13804a10` — missing `test/integration.test.ts` amendment coverage.**
   Rule: the selected plan requires an actual Git regression through request → unanimous votes → publication → resume → implement newly approved path.
   Failure: cursor only has unit/fixture coverage; concurrent admission, publication-before-authorization, and resume against a bare origin are unproven end-to-end on that pin.
   Contrast: claude/codex/antigravity extend the four-agent canary.

### Relative ranking

1. **claude `f8543ea6`** — best overall match: `explanation`, detour before normalize, roster-ordered freeze with deferred reissue, correct `amendment-ballot` artifact, drop cancel, integration. Still needs exact-path enforcement for additions and fail-closed empty maps (findings 5–6).
2. **codex `a4d2b464`** — strongest map safety (`exactApprovedPaths`, fail-closed empty map, solid integration). Blocking plan-literal defect is the `rationale`/`explanation` rename (finding 3).
3. **cursor `13804a10`** — sound dual-outcome status and detour ordering, but wrong published ballot artifact name, fail-open empty map, prefix matching on additions, and no integration amendment scenario.
4. **antigravity `b915e8c9`** — reject as winner: wrong AGENTS request path (finding 1) and weak concurrent-request freeze (finding 2).

### Scope and reuse

All four stay inside the approved product file set and reuse existing ballot/evidence/order machinery rather than adding new modules. Prefer merging **claude’s concurrency and contract naming** with **codex’s exact-path + fail-closed enforcement**, then add the integration path cursor omitted.

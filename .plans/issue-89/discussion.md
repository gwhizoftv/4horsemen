# Issue 89 — speed, tokens, tool calls (discussion)

- Issue: https://github.com/gwhizoftv/coordination/issues/89
- Status: **discussion only** — not an implementation plan, not acceptance criteria
- Author: Cursor (discussion seed)
- Baseline: `origin/main` after issue 76 / manual mode

## Problem (restated)

Consensus runs burn wall-clock and agent budget because each step tends to:

1. Re-discover the repo (search / list / read)
2. Re-read large protocol text (`AGENTS.md`, prior plans/reviews)
3. Produce verbose peer-parallel artifacts (4 plans × 4 reviews × ballots …)
4. Issue many tool calls for work the coordinator already knows (SHAs, paths, digests, scaffolds)

Issue text asks whether we can put **more work into the coordinator**, **consolidate messaging**, and/or add **context files** so initial searches shrink.

---

## Design axes (how to judge ideas)

| Axis | Question |
|------|----------|
| **Who pays** | Coordinator CPU/IO vs agent tokens vs owner attention |
| **Where quality lives** | Mechanical gates vs model judgment |
| **Parallelism** | All four agents every step vs fewer / staged |
| **Durability** | Ephemeral prompt vs committed context vs runtime-only files |
| **Risk** | Wrong automation → silent wrong consensus; too little exploration → missed defects |

Ideas below are deliberately overlapping. Mix-and-match is expected.

---

## Theme A — Move work into the coordinator

### A1. Pre-fill more of every artifact

Today JSON steps already get scaffolds (`orderScaffold.ts`). Markdown steps (plan, review, comparison) still ask agents to invent structure and rediscover paths.

**Idea:** For plans/reviews, coordinator writes a **starter blob** under the required path (or a sibling `*.scaffold.md`) with filled bindings: issue, baseline, bound peer SHAs/paths, approved path seeds from prior steps, exact heading skeleton. Agent only fills bodies.

**Pros:** Fewer “what format?” turns; fewer citation invents.  
**Cons:** Scaffold wrong → agents rubber-stamp it; need clear “edit not invent” language.

### A2. Coordinator-authored ballots / selection / reviser-auth

Several steps are already mechanical once peers publish (plan-ballot choice can be deterministic; selection and reviser-auth are largely filled scaffolds).

**Idea:** Collapse R3.publish-selection, R5.reviser-auth, R6.declare (and maybe ballots) into **coordinator effects** that write + verify the JSON without nudging agents—agents only do judgment steps (plan, review, implement, compare, revise).

**Pros:** Huge token cut on consensus profile.  
**Cons:** Changes the “every agent signs” social model; need owner-visible journal of auto-steps.

### A3. Extract file maps / approvedPaths without agent prose

Agents often burn tools walking trees to invent Exact File Lists.

**Idea:** Coordinator (or a one-shot non-LLM script in `checks`/prep) diffs `baseline..HEAD` or parses issue body / prior pin and writes `approvedPaths` / a machine file map into `action.md`. Plan section becomes “confirm or amend this list,” not “discover from scratch.”

**Pros:** Less search; more stable implement scope.  
**Cons:** Bad extraction locks wrong scope early.

### A4. Richer `action.md`: pack everything for one read

Nudges say “read action.md”; agents then open AGENTS, peers, git log, …

**Idea:** Make each `action.md` a **self-contained work packet**: required path, scaffold, bound input blobs inlined or attached as short excerpts, “do not search for X,” explicit stop condition, max tool budget hint. Optionally attach `context.md` path beside it.

**Pros:** One Read may be enough.  
**Cons:** Large action files; stale excerpts if peers move.

### A5. Coordinator-side verify with auto-repair of mechanical fields

Failures like stale `automationDigest` / wrong placeholder SHA cause full agent re-turns.

**Idea:** On verify failure for **known fields**, coordinator patches the artifact (or rewrites `complete` target) and re-fetches once before re-nudging. Only semantic failures (missing Findings, bad rationale) bounce to the agent.

**Pros:** Removes the “stale digest” tax seen in live runs.  
**Cons:** Must never auto-fix judgment content.

### A6. Speculative next-step prep while agent works

While implement is in flight, coordinator could prefetch peer clones, precompute digests, draft empty comparison scaffolds.

**Pros:** Wall-clock overlap.  
**Cons:** Complexity; wasted work on drop/fail.

---

## Theme B — Consolidate messaging (fewer / denser turns)

### B1. Multi-step actions (“batch cards”)

**Idea:** One `action.md` covers a chain the same agent must do alone (e.g. join+plan, or ballot+wait is still one agent). Or “implement then publish signal” already partly exists—extend to “compare+ballot” when solo/reviewed.

**Pros:** Fewer nudge/complete round-trips.  
**Cons:** Harder recovery mid-card; actionId semantics blur.

### B2. Shorter nudges; long detail only in files

Nudge text already carries actionId+digest. Agents still restate the whole task.

**Idea:** Nudge becomes a single opaque token: `coord://issue/76/action/<uuid>`. All prose lives in `action.md`. Protocol says: do not summarize the order back.

**Pros:** Tiny prompt inject; less composer clutter.  
**Cons:** If read fails, agent is lost; need ironclad path.

### B3. Profile defaults that skip redundant peer copies

Consensus currently multiplies work × agents.

**Ideas:**

- Default onboard to **`reviewed`** for medium issues; reserve consensus for hard ones.
- **Solo** for tiny chores / docs.
- Dynamic degrade: after N successful rounds, drop to reviewed automatically (owner opt-in).

**Pros:** Biggest real-world token win with no new infra.  
**Cons:** Less diversity; owner must choose profile consciously.

### B4. Staggered roster (not all four every phase)

**Idea:** Round-robin or owner-picked “primary + one reviewer” for plan; full roster only at compare/consensus. Or two plan authors, two reviewers only.

**Pros:** Cuts R2/R3 cost roughly in half.  
**Cons:** Protocol/roster rules change; fairness across vendors.

### B5. Suppress re-reads of protocol

Agents re-open AGENTS.md constantly.

**Idea:** Protocol says: after join, assume protocol known; `action.md` wins; only open AGENTS on format dispute. Coordinator could stop embedding long protocol reminders in every task string.

**Pros:** Fewer reads.  
**Cons:** New sessions / model swaps forget—need session-start handshake.

### B6. One shared plan, multiple reviews (or inverse)

**Idea:** Elect or designate a single plan author; others only review. Or one comparison author; others only ballot.

**Pros:** Removes N-way plan divergence.  
**Cons:** Loses multi-vendor design exploration (often the point of consensus).

---

## Theme C — Context files for the codebase

### C1. Committed `CONTEXT.md` / `ARCHITECTURE.md` (product)

**Idea:** Optional digestPath / always-on file: module map, “where X lives,” build/test commands, non-goals. Agents must read it before searching.

**Pros:** Stable across issues; owner-curated.  
**Cons:** Rot; wrong map → confident wrong searches.

### C2. Generated `coord-runtime/issue-N/codebase-sketch.json`

**Idea:** On `coord start`, run a confined indexer (rg of exports, directory tree depth-2, `package.json` scripts) into runtime (not product tree). Point `action.md` at it.

**Pros:** Fresh per issue; no product commit noise.  
**Cons:** Indexer cost at start; may be large; still not semantic.

### C3. Per-clone `.coord/context/` overlays

**Idea:** Install writes a small search cheat-sheet into each agent clone (untracked, like hooks): “src layout,” “do not grep node_modules,” preferred entrypoints.

**Pros:** Local to agents; versioned with install.  
**Cons:** Another install surface; drift from product.

### C4. Issue-body → structured brief

**Idea:** Require GitHub issue templates with Goal / Non-goals / Touch areas / Test plan. Coordinator copies them verbatim into every `action.md`.

**Pros:** Owner intent reaches agents without discovery.  
**Cons:** Bad templates poison the run; needs discipline.

### C5. Retrieval pack from prior accepted pins

**Idea:** After R3 selection, coordinator packs selected plan + winning review excerpts into `agents/*/packet.md` for implementers/comparers so they do not re-fetch all four plans.

**Pros:** Focused context.  
**Cons:** Excerpt selection is itself a design problem (heuristic vs LLM).

### C6. “Do not tool” allowlist in action

**Idea:** Explicit list: allowed tools / forbidden searches (e.g. “do not run find on whole repo; use approvedPaths”). Soft budget: “≤ N Read calls before writing.”

**Pros:** Directly attacks tool spam.  
**Cons:** Enforcement is advisory unless harness supports hard limits.

---

## Theme D — Artifact / protocol compression

### D1. Slimmer plan headings

Exact File List + Created + Tests + Alternatives + Risks + Conclusion is heavy for small changes.

**Idea:** Size-tiered templates: `micro` (files + test + conclusion), `standard` (current), `large` (add alternatives/risks). Coordinator chooses from issue labels or path count.

**Pros:** Less writing, less reading in review.  
**Cons:** Reviewers need matching tiers; validators grow.

### D2. Structured plan as JSON + short prose

**Idea:** File map and tests as JSON; Conclusion one paragraph. Reviews cite JSON paths.

**Pros:** Machine-diffable; coordinator can validate maps early.  
**Cons:** Worse for human narrative design issues.

### D3. Reviews as patch comments, not essays

**Idea:** Cap Findings count; require line-anchored defects only (already partly true). Ban restating the plan.

**Pros:** Shorter reviews.  
**Cons:** Misses architectural objections that are not line-local.

### D4. Drop or merge comparison prose when ballots suffice

**Idea:** In reviewed/solo, skip R5.compare markdown; go ballot-only or straight to reviser.

**Pros:** Saves a full multi-agent step.  
**Cons:** Less cross-pin analysis on hard issues.

---

## Theme E — Tooling / harness efficiency

### E1. Prefer `coord next` / status over exploratory git

**Idea:** Teach protocol: first call after nudge is `coord next --issue N` (or read action only). Ban `git log --all` style exploration unless outstanding says so.

**Pros:** Uses existing owner/agent CLI.  
**Cons:** Agents ignore soft rules; need repeated enforcement in action text.

### E2. Bundle verify into fewer commands

Agents often run lint, typecheck, tests separately.

**Idea:** Action says “run exactly `pnpm check:fast` once”; coordinator already gates full `pnpm check` later—do not duplicate e2e in agent loops.

**Pros:** Clear stop.  
**Cons:** Agents still “just check one more thing.”

### E3. Paste-buffer / single inject (delivery)

Orthogonal but related: failed/duplicated nudges waste whole turns.

**Idea:** Continue lifecycle-hook path (issue 86); paste-buffer where safe; never re-inject while working.

**Pros:** Prevents duplicate queued prompts (token storms).  
**Cons:** Already in flight; not a content efficiency play.

### E4. Model routing by step

**Idea:** Cheap/fast model for join, ballots, scaffolds; strong model for plan/implement/review. Coordinator records recommended model in action front matter (advisory).

**Pros:** Cost/latency without changing protocol much.  
**Cons:** Harness-specific; owner must configure four CLIs.

---

## Theme F — Workflow shape changes (bigger bets)

### F1. Two-phase consensus: explore then lock

Phase 1: one or two agents explore (manual or light solo). Phase 2: lock plan and run tight reviewed automation.

**Pros:** Matches how humans already use `coord manual` + `coord N`.  
**Cons:** Process documentation; mode confusion if both left up.

### F2. Owner-gated “cheap path” button

**Idea:** `coord answer … shortcut` or profile flag: skip peer plans, use owner-attached plan path.

**Pros:** Escape hatch for obvious fixes.  
**Cons:** Undermines consensus story if overused.

### F3. Shared worktree / single clone (radical)

**Idea:** One checkout, multiplexed agents (hard with identity hooks).

**Pros:** No N-way clone search duplication.  
**Cons:** Conflicts with branch ownership, hooks, isolation—likely non-goal.

### F4. Coordinator becomes protocol client (ACP / App Server)

Long-term: drive models without tmux paste; stream tool results; inject context once.

**Pros:** Best control over tokens/tools.  
**Cons:** Explicit non-goal of earlier lifecycle work; large rewrite.

---

## Theme G — Measurement (so we know what worked)

Without metrics, efficiency work is vibes.

### G1. Per-issue cost journal

Record approximate: nudges sent, verify fails, wall time per step, artifact byte sizes, optional owner-entered “agent $ / tokens” note.

### G2. Fixture replay

Synthetic canary that counts “agent turns” as complete files, not tokens—optimize for fewer completes per gate.

### G3. Classify verify failures

Tag mechanical vs semantic; target mechanical toward zero via A5.

---

## Strawman packages (for debate, not commitment)

| Package | Contents | Expected win | Risk |
|---------|----------|--------------|------|
| **Quick wins** | B3 reviewed default, B5 protocol re-read rule, E2 single check command, A5 mechanical auto-repair, E3 lifecycle | High / low effort | Profile surprise |
| **Coordinator pack** | A1 markdown scaffolds, A4 self-contained action, C5 selected-plan packet, C2 start-time sketch | Medium–high | Scaffold trust |
| **Roster slim** | B4 staggered participation, B6 single plan author | High on consensus | Less diversity |
| **Step collapse** | A2 auto selection/declare/ballots | High | Changes trust model |
| **Context product** | C1 + C4 issue template | Medium ongoing | Doc rot |
| **Future harness** | F4 ACP/App Server | Very high long-term | Project-sized |

---

## Open questions for the owner / peers

1. Is the primary pain **wall-clock**, **$ tokens**, or **tool-call rate** (rate limits)?
2. Is multi-vendor plan diversity still a hard requirement, or is reviewed-profile quality enough for most issues?
3. May the coordinator write product-visible files (scaffolds under `.plans/`), or only runtime packets under `coord-runtime/`?
4. Should efficiency be opt-in per issue (`--profile`, labels) or a global default change?
5. What is an acceptable first experiment: measurement only (G1), or a behavior change (A5 / B3)?

---

## Explicit non-goals (for this discussion thread)

- Replacing tmux with ACP/App Server in the first efficiency ship
- Weakening evidence SHA / mirror verification
- Asking agents to maintain `waiting.json`-style status files (rejected in issue 86)
- Optimizing by deleting peer review entirely without an owner-chosen profile

---

## Next steps (process)

1. Peers add / strike ideas in this file or follow-on comments on issue 89.
2. Owner marks a **shortlist** (1–2 packages).
3. Only then write a real `.plans/issue-89/plan.md` with Exact File Lists / Tests / Risks for the chosen package.

Until a shortlist exists, treat this document as **non-binding discussion**.

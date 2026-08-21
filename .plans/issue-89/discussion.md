# Issue 89 discussion: faster, leaner coordination

## Problem framing

Issue 89 asks whether the coordinator can reduce elapsed time, model tokens, and
tool calls, including by supplying better repository context. These are related
but different optimization targets:

- **Elapsed time:** number of sequential agent turns and gates, slow checks,
  fetches, retries, and time spent rediscovering the repository.
- **Model tokens:** repeated protocol text, repeated repository exploration,
  duplicated analysis across agents, and over-broad context bundles.
- **Tool calls:** repeated `git fetch`/`git show`/search/test/publication work and
  clerical artifact creation.
- **Decision quality:** independence, diversity, auditability, and correctness.

An optimization can improve one target while harming another. For example,
sharing one agent's repository analysis saves searches but can create groupthink;
dumping a large generated context file can reduce tool calls while increasing
input tokens. The coordinator should therefore measure each dimension and offer
policy choices rather than assume that fewer turns is always better.

## Current cost shape

The workflow contains several model actions that are deterministic or clerical,
and several pairs where an agent first writes analysis and then takes a second
turn to express the resulting choice.

For `N` agents and one successful revision round, the current step graph implies
approximately:

| Profile | Agent actions |
| --- | ---: |
| solo | 4 |
| reviewed | `4N + 3` |
| consensus | `8N + 5` |

With four agents, a normal consensus run can therefore require roughly 37 agent
actions before retries or malformed-artifact corrections. Five of those are
single-agent actions and the rest repeat across the roster. Additional revision
rounds add approximately `N + 1` actions each.

Concrete sources of overhead include:

- Every agent publishes a join artifact even though the coordinator prepared
  the clone and already knows the session, baseline, agent, and automation
  digest.
- Plan review and plan ballot are separate actions over the same bound inputs.
- Implementation comparison and comparison ballot are separate actions over the
  same bound inputs.
- Selection, reviser authorization, and consensus declaration are described as
  mechanically derived, but an agent is still asked to publish each artifact.
- Finalization asks an agent to perform cleanup and publish evidence even though
  the coordinator subsequently materializes and verifies the cleanup pin, runs
  checks, pushes the final branch, and opens the PR.
- `action.md` repeats stable publication instructions and protocol scaffolding.
- Each peer independently discovers repository structure, entry points, test
  commands, and relevant history.
- Agents commonly perform several commands to commit, push, recover the exact
  SHA, and write `complete` after the substantive work is already done.

The formulas are useful as a discussion baseline, not a performance result. We
do not yet have measured token counts or per-action tool-call counts across all
vendors.

## Idea group A: measure before changing the workflow

### A1. Add coordinator-native efficiency metrics

Derive metrics from the existing journal and lifecycle state:

- wall-clock duration per action and gate;
- number of action publications, corrections, injections, and recovery nudges;
- `action.md` bytes and bound-input bytes;
- time waiting for agents versus verification/checks;
- fetch, mirror, check, and PR-operation counts and duration;
- number of active agents and revision rounds;
- lifecycle degradation and restarts.

Where a vendor exposes token/tool usage through supported lifecycle APIs, record
it as optional vendor telemetry. Do not pretend action bytes are tokens, and do
not make vendors without usage reporting second-class.

**Advantages:** establishes a baseline, identifies the actual bottleneck, and
supports regression budgets. **Costs/risks:** instrumentation itself does not
speed up a run; vendor token accounting may be inconsistent.

### A2. Add `coord report --efficiency`

Produce a stable JSON report plus a short human summary at issue completion.
Compare profiles and changes using medians across several real issues rather
than one anecdotal run.

### A3. Add feature flags and A/B canaries

Gate each optimization independently, such as compact actions, generated
context, combined ballots, or coordinator-owned clerical steps. This avoids a
large workflow rewrite whose savings and regressions cannot be attributed.

## Idea group B: remove model work that is already deterministic

### B1. Make join coordinator-owned

The coordinator already knows every value in the join JSON and prepares the
branch. It could record the join evidence internally, or write the audit record
itself, after confirming the expected clone/session exists. No model reasoning
is required.

**Potential saving:** `N` agent actions and their associated commits/pushes.
**Risk:** join currently doubles as proof that the CLI is responsive. Replace
that role with a lifecycle/session-start handshake rather than a model-authored
JSON file.

### B2. Compute selection and authorization internally

`R3.publish-selection`, `R5.reviser-auth`, and `R6.declare` are mechanical
transforms of already accepted ballots and pins. Persist their exact derived
values in coordinator state/journal instead of asking the selected agent to copy
the supplied JSON scaffold into Git.

**Potential saving:** three sequential model actions. **Risk:** if committed
artifacts are required for audit, the coordinator needs either a dedicated audit
branch or a reproducible export. The runtime journal may already be the better
source because finalization deletes current-issue coordination files.

### B3. Make final cleanup coordinator-owned

After consensus, the coordinator can materialize the accepted pin, delete only
the issue-scoped coordination files, create the cleanup commit, run configured
checks, publish the final branch, and open the PR. This moves a narrowly
mechanical and security-sensitive operation out of a model turn.

**Potential saving:** one agent action plus several Git/file tool calls.
**Risk:** coordinator-authored commits and credentials must be acceptable to the
owner, and the exact deletion allowlist must remain fail-closed.

### B4. Replace hand-authored completion receipts with one safe submit command

Offer a command resembling:

```text
coord submit --action <uuid> --commit HEAD
```

It would verify the current branch and pushed commit, freeze the exact SHA, and
atomically write the coordinator-owned receipt. This preserves explicit intent
without the fragile sequence of `rev-parse` plus manually writing `complete`.

A more ambitious `coord publish` helper could stage only the required artifact,
commit with the mandated identity/trailer, push, and submit in one audited
operation. That should be opt-in because hiding Git mutations makes failures
harder to understand.

## Idea group C: combine turns that use the same context

### C1. Combine plan review and plan ballot

Have each reviewer publish one document or structured artifact containing both:

- actionable findings about the bound plans; and
- a choice plus concise rationale.

The coordinator can validate both portions at one commit. There is little value
in starting a second model turn merely to translate the completed review into a
ballot.

**Potential saving:** `N` actions and one full reread of the same inputs.
**Tradeoff:** a separate ballot currently freezes the accepted review set before
voting. The combined action must bind the same complete input set and remain
immune to late plan movement.

### C2. Combine implementation comparison and comparison ballot

The comparison can end with a machine-readable choice and rationale. Validate
that every implementation pin was considered and derive the vote from that same
artifact.

**Potential saving:** another `N` actions. **Tradeoff:** Markdown plus embedded
JSON is harder to validate than two simple artifacts; a sidecar generated from
front matter may be cleaner.

### C3. Collapse correction loops

When validation finds multiple defects, return all deterministic findings in
one correction action. Preserve a stable action identity/digest when only the
diagnostic list changes, or clearly mark the revision, so agents do not repeat
exploration just to repair several independent schema mistakes.

### C4. Allow one turn to publish multiple presently independent outputs

For steps with no intervening dependency, an action could authorize a bounded
set of outputs and one commit. This should not be used across a real gate: an
agent must not guess peer inputs that do not exist yet.

## Idea group D: choose less expensive workflows when independence is not needed

### D1. Suggest a profile using observable issue characteristics

The coordinator could recommend, but not silently select:

- `solo` for mechanical or narrowly localized changes;
- `reviewed` for normal feature/fix work;
- `consensus` for security-sensitive, architectural, migration, or ambiguous
  work.

Signals could include owner labels, estimated file/package spread, migration or
security keywords, and explicit risk settings. The owner remains authoritative.

### D2. Add a role-specialized profile

Instead of every agent doing every activity, assign roles such as:

- one repository explorer/context author;
- two independent planners/reviewers;
- one or two implementers;
- two final reviewers.

This retains some diversity while reducing four-way duplication. Rotate roles
across issues to avoid systematically privileging one vendor.

### D3. Add early stopping and top-k implementation

If plan ballots are strongly aligned, implement only the selected plan or the
top two rather than requiring every active agent to implement independently.
If reviews disagree or risk is high, retain the full roster.

**Largest possible time saving:** implementation and comparison dominate real
work. **Largest quality risk:** fewer independent implementations reduce the
chance of discovering a better design. Make this an explicit policy, not a
hidden optimization.

### D4. Sample reviewers

For low/medium-risk stages, require two independent approvals rather than every
configured agent. Escalate to the full roster when the sampled reviewers
disagree or raise a high-severity finding.

## Idea group E: provide better repository context

### E1. Maintain a small human-owned repository capsule

Add a concise, reviewed file such as `.coord/context.md` or a section of
`AGENTS.md` containing only stable facts:

- architecture and package boundaries;
- primary entry points;
- authoritative validation commands;
- generated-file and security boundaries;
- where tests normally live;
- unusual Git/workflow constraints.

**Advantages:** simple and high-signal. **Risks:** staleness and loading facts
irrelevant to the current issue. Give it an owner and validate referenced paths
and commands in CI.

### E2. Generate a content-addressed repository map

At the baseline commit, deterministically index:

- tracked file tree and language/package grouping;
- workspace/package manifests and scripts;
- import/dependency graph summaries;
- public symbols and entry points where parsers support them;
- test-to-source proximity;
- scoped `AGENTS.md` instructions;
- recent commits touching candidate paths.

Cache it by baseline SHA. Agents should query a relevant slice rather than read
the whole map.

**Advantages:** current, reusable across agents, no model needed. **Risks:** a
large raw map increases tokens; static structure does not explain runtime
behavior; multi-language parsing can become a product of its own.

### E3. Generate a per-issue context capsule

The coordinator can assemble a small `context.md`/JSON outside the product tree
containing:

- issue title/body and baseline SHA;
- exact applicable instructions;
- likely packages/files based on deterministic text and symbol search;
- relevant test commands from configuration rather than guesswork;
- recent commits for those paths;
- exact pinned peer artifact references as they become available.

Every claim should include its source path or Git pin. Treat likely files as
hints, never as an approved file map.

### E4. Add local retrieval rather than a large prompt dump

A read-only command or MCP server could expose:

```text
coord context search <query>
coord context symbol <name>
coord context tests-for <path>
coord context history <path>
```

Start with deterministic lexical/symbol search. Embeddings are optional later;
they add dependencies, privacy questions, and invalidation complexity.

**Advantages:** low prompt size and fewer broad `grep`/`find` calls. **Risks:**
the agent may over-trust incomplete retrieval, so results must cite source paths
and advertise coverage limits.

### E5. Use one shared explorer artifact

One agent can publish an evidence-backed architecture/impact briefing that the
other agents receive as an additional, clearly non-authoritative input.

**Advantages:** eliminates repeated initial searches and adds semantic context
beyond static indexing. **Risks:** groupthink, explorer error propagation, and a
new sequential gate. Peers must remain able to challenge it, and high-risk work
may still require independent exploration.

### E6. Cache context by Git object identity

Cache file summaries, symbol indexes, dependency graphs, and check results by
blob/tree/commit SHA. A new issue on the same baseline can reuse them; a change
invalidates only affected objects. Never cache unpinned working-tree claims as
authoritative context.

## Idea group F: make action messaging smaller and more precise

### F1. Separate stable protocol from per-action delta

Keep stable publication, branch, safety, and artifact-format rules in one
versioned protocol. Make `action.md` primarily:

- opaque action identity and digest;
- required output/path;
- exact bound inputs/pins;
- action-specific acceptance criteria;
- corrections from the previous attempt.

Avoid repeating prose already guaranteed to be loaded from the matching
protocol version. Include a short fallback reference so a restarted agent can
recover without conversational history.

### F2. Supply exact commands for bound inputs

Alongside each peer pin/path, provide the exact safe `git show` command needed
to read it. This removes command construction and wrong-branch retries while
preserving origin-ref trust. For many inputs, provide a generated script or
manifest that performs the reads without mutating the clone.

### F3. Materialize a verified input packet

The coordinator mirror already reads exact blobs. It could write a
content-addressed, read-only packet containing all bound artifacts and a
manifest of source SHA/path/hash. Agents then make one read instead of many
fetch/show calls.

**Tradeoff:** independent reads from fetched origin refs currently strengthen
the trust boundary. A packet should be an optimization only if its provenance
is mechanically verifiable and agents can fall back to `git show`.

### F4. Make nudges minimal and idempotent

The TUI message should contain only the action identity/digest and action-file
path. Do not restate instructions or internal workflow terminology. A repeated
delivery then consumes very few tokens and cannot diverge from `action.md`.

### F5. Use vendor-specific adapters only where they save work

Keep one semantic action model, but tailor transport details to each CLI's
native attachment, lifecycle, or prompt API. Do not fork the actual workflow
instructions by vendor; that creates behavioral drift and multiplies tests.

## Idea group G: reduce repeated Git and test work

### G1. Share coordinator-fetched Git objects

The coordinator already owns a bare mirror. Clones could fetch through a local
reference/cache or receive verified objects from the mirror, reducing network
traffic while retaining per-clone refs and working trees. This is mainly a
speed/network optimization, not a token optimization.

### G2. Cache check results by commit and exact argv/environment

If the same immutable commit is reviewed or finalized repeatedly, reuse a
successful coordinator-run check result keyed by:

```text
commit SHA + argv + relevant environment/config digest
```

Agents can receive the trusted result and run only tests needed for their new
changes. Never reuse results across a changed lockfile, toolchain, or check
configuration.

### G3. Provide authoritative test targeting

Let repository configuration map changed paths to the smallest accepted fast
checks, while retaining the full final gate. This prevents every agent from
searching package scripts and running unnecessarily broad commands during early
exploration.

### G4. Summarize immutable diffs once

For implementation comparison, have the coordinator produce deterministic
changed-path, diffstat, check-result, and commit-ancestry metadata for every
candidate. Reviewers still inspect source, but they no longer repeat clerical
Git discovery.

## Candidate packages for experimentation

### Package 1: low-risk observability and context

1. Add efficiency metrics/reporting.
2. Add a small repository capsule with CI validation.
3. Add a baseline-SHA repository map and query command.
4. Record action/input byte counts and time-to-gate.

This package changes no consensus semantics and establishes whether context
work actually reduces searches and latency.

### Package 2: remove clerical turns

1. Coordinator-owned join after lifecycle handshake.
2. Coordinator-derived selection, reviser authorization, and declaration.
3. Safe `coord submit` helper.
4. Evaluate coordinator-owned final cleanup separately because it changes commit
   authorship and credential use.

This offers predictable savings without reducing the number of independent
plans, implementations, or reviews.

### Package 3: combine analysis and ballots

1. Combine plan review with plan choice.
2. Combine implementation comparison with implementation choice.
3. Preserve immutable complete input sets and exact citations.

With four agents, the three deterministic transform actions plus the two paired
turn consolidations could remove 11 model actions. Making join
coordinator-owned would remove four more; finalization is a separate decision.

### Package 4: adaptive workflow policy

1. Add a role-specialized profile.
2. Offer owner-confirmed profile recommendations.
3. Experiment with top-k implementation and sampled reviewers.
4. Escalate automatically when reviewers disagree, checks fail, or risk signals
   appear.

This has the largest possible savings and the largest impact on independence,
so it should follow measurement and lower-risk improvements.

## Suggested initial direction

The first implementation should not be a large AI retrieval system or a rewrite
of the state machine. A reasonable sequence is:

1. **Measure:** add per-action timing/count/byte metrics and an efficiency
   report, then baseline several completed issues.
2. **Eliminate clerical model actions:** start with join, selection,
   authorization, and declaration while preserving the journal audit trail.
3. **Combine paired turns:** review+ballot and comparison+ballot, guarded by
   immutable input-set validation.
4. **Add small, source-cited context:** a validated repository capsule and
   deterministic baseline map/query command.
5. **Experiment with adaptive profiles:** only after the first four steps show
   where elapsed time and tokens are actually spent.

This order improves efficiency without immediately giving up independent plans
or implementations. It also creates measurements needed to decide whether a
shared explorer, retrieval service, fewer implementations, or reviewer sampling
is worth the quality tradeoff.

## Questions for owner discussion

1. Is the main target wall-clock time, paid tokens, human supervision, or agent
   tool-call friction? Which should win when they conflict?
2. Which mechanically derived Git artifacts are required for audit after the
   coordinator already stores equivalent pinned runtime state?
3. Should four independent implementations remain the defining behavior of the
   consensus profile, or may strong plan agreement reduce that number?
4. Would the owner accept coordinator-authored cleanup/audit commits?
5. Should repository context be tracked and human-reviewed, generated and
   content-addressed, queried on demand, or a combination?
6. Are vendor-reported token/tool metrics sufficiently trustworthy for budgets,
   or should the first metrics remain vendor-neutral proxies?
7. Should profile recommendations require explicit confirmation, or can a
   workspace define automatic risk-based routing policy?

## Non-recommendations

- Do not require models to maintain working/waiting state as an efficiency
  mechanism; lifecycle state remains coordinator-owned.
- Do not paste an entire generated repository index into every action.
- Do not share unpinned summaries as authoritative evidence.
- Do not collapse steps across unresolved dependencies merely to reduce turns.
- Do not silently reduce independent reviewers or implementations under the
  existing `consensus` name.
- Do not optimize tool-call count by hiding unsafe, broad Git mutations in an
  opaque helper.

# Issue 92 plan review

Bound plans reviewed:

- Antigravity: `dc6a7bdf3bc731b81382f0944b26cae400c8c21c`
- Cursor: `44a0512f2292d5dd16ff14b9eff2e4755b7d959b`
- Claude: `3c9b810b4ab3f329cae009004609d76bbfecfc09`
- Codex: `93dce7a2652e1e91488138aee97c6e0d52f932a7`

## Findings

### 1. Cursor's comparison packet reads a coordination-signal path at a product pin

**Plan claim:** Cursor plan `44a0512f2292d5dd16ff14b9eff2e4755b7d959b`,
Package B and implementation detail 4, builds the R5 packet by reading every
bound implementation `(commitSha, path)` and hashing that tuple.

**Rule:** A packet entry must name a blob that exists at the cited commit, and a
comparison optimization must expose the candidate product diff rather than
silently substituting coordination evidence.

**Concrete failure:** `deriveBoundInputs` builds R5 implementation inputs with
`usePin=true`, so `commitSha` is the product pin but `path` remains the later
submission path such as `.signals/issue-92/implementation-ready-codex.json`.
That signal was committed after the product pin and does not exist in the
product-pin tree. `mirror.readBlob(commitSha, path)` therefore returns null for
every normal candidate: a fail-closed builder blocks R5, while a permissive
builder publishes an empty packet that eliminates none of the repeated source
discovery.

**Smallest correction:** Build deterministic diffstat/changed-path metadata from
`baselineSha..productPin` and, if file contents are packetized, read each changed
repository path at the product pin. Keep the signal submission SHA/path as a
separate provenance field rather than pairing its path with the product pin.

### 2. Claude's renderer turns valid Git pathnames into a workflow-wide denial of service

**Plan claim:** Claude plan `3c9b810b4ab3f329cae009004609d76bbfecfc09`,
the `src/action.ts` file-map item, requires `renderAction` to throw when any
context or changed path contains a backtick or newline.

**Rule:** Advisory rendering over paths returned by Git must be total for every
valid Git pathname; an unrenderable hint may be encoded, omitted, or flagged,
but it must not prevent the authoritative action from being published.

**Concrete failure:** Git permits both characters. If one accepted
implementation touches a file such as `docs/a\`b.md` (or a filename containing
a newline), R5 action preparation throws before writing any reviewer action.
All four agents then wait forever even though the product pins, evidence, and
approved-path checks are otherwise valid.

**Smallest correction:** Validate configured context paths at config load, but
encode Git-derived paths with an unambiguous representation (for example a JSON
array), or omit unsafe display entries and set an explicit incomplete/truncated
flag. Never throw merely because advisory change scope cannot be rendered as a
Markdown code span.

### 3. Claude's start-state default does not by itself preserve typed initializer compatibility

**Plan claim:** Claude plan `3c9b810b4ab3f329cae009004609d76bbfecfc09`,
the `src/state.ts` item, adds a defaulted `contextPaths` field to strict start
state and states that old starts keep working.

**Rule:** A defaulted schema addition must be optional at every public
construction boundary as well as while parsing old JSON; `pnpm typecheck` must
continue to accept all `initializeOperationalState` call sites.

**Concrete failure:** `StartStateInput` is derived from the parsed `StartState`
output. A Zod default makes `contextPaths` present in that output type, so the
current initializer literals in integration, run-loop, agent-event, and
agent-language tests become compile errors even though old JSON parses. Those
files are not in the plan's exact changed-file list, and the proposed focused
tests cannot reach runtime.

**Smallest correction:** In `src/state.ts`, explicitly omit `contextPaths` from
`StartStateInput` and add it back as optional (with initialization defaulting to
the empty list), or enumerate and update every typed initializer call site.
Add one compile-time/initialization regression for an omitted field.

### 4. Antigravity's principal prompt-trimming change is forbidden on the prepared clone

**Plan claim:** Antigravity plan `dc6a7bdf3bc731b81382f0944b26cae400c8c21c`
lists root `AGENTS.md` as a product change and makes deleting its tracked
protocol copy a principal token-saving result.

**Rule:** The selected implementation must be achievable on the prepared issue
branch without clearing skip-worktree, stripping the managed protocol block, or
replacing `AGENTS.md`; the repository instructions explicitly prohibit all
three recovery techniques.

**Concrete failure:** The selected agent cannot reliably stage the proposed
root-file change because the clone-local file is skip-worktree and contains the
managed overlay. Following the plan either violates the workflow instructions
by changing index flags/replacing the file, or omits the plan's main prompt-size
deliverable while still claiming its savings.

**Smallest correction:** Remove root `AGENTS.md` from this automated issue's
file map. If the owner wants the tracked self-hosting copy trimmed, perform that
as an owner-controlled upstream change that does not ask an issue agent to
alter the clone-local managed file.

### 5. Antigravity's derived-artifact destination cannot satisfy the existing evidence chain

**Plan claim:** Antigravity plan `dc6a7bdf3bc731b81382f0944b26cae400c8c21c`,
Risk 4 and the run-loop/evidence items, says the coordinator will write derived
selection, authorization, and consensus JSON to “the coordination runtime and
mirror.”

**Rule:** Any later bound input must have an exact durable source identity that
the verifier can read: either a commit SHA/path reachable from a fetched origin
ref, or an explicitly versioned runtime-state/journal contract consumed without
pretending it is a Git artifact.

**Concrete failure:** `BareMirror` reads fetched Git objects; it is not a mutable
audit branch and cannot assign a submission SHA to a runtime-only JSON file.
If the standalone agent publications are skipped as planned, later
`deriveBoundInputs` calls have no accepted submission SHA/path for selection,
authorization, or declaration, so implementation, revision, or finalization
orders lose the pins they must bind.

**Smallest correction:** Specify a runtime-native derived-decision schema and
teach state transitions and bound-input derivation to consume its exact source
ballots/pins, journaling the derivation atomically. Alternatively retain a real
coordinator-owned Git publication branch and define its signing, push, fetch,
and cleanup rules; do not call an uncommitted runtime file a mirror artifact.

### 6. Codex optimizes the phases the owner explicitly ranked below implement and wait cost

**Plan claim:** Codex plan `93dce7a2652e1e91488138aee97c6e0d52f932a7`
makes a 37-to-22 action-count protocol rewrite the issue's primary package and
defers repository context.

**Rule:** An analytics-driven implementation must prioritize the measured R4
implement hotspot, R5 re-ingestion, and Antigravity permission wait identified
in the issue's owner baseline; low-percentage ballot/publication phases should
not displace those targets.

**Concrete failure:** The proposed workflow-version change can remove clerical
turns but leaves the 138.61-minute implementation phase and 8310.8-second
Antigravity tail from the product baseline untouched, and it provides no
context or changed-scope mechanism for the coordination R4/R5 hotspots. Its
seven-phase success test can pass while the owner-selected efficiency metrics
do not improve.

**Smallest correction:** Prefer the bounded context-path, coordinator-resolved
change-scope, and unattended-launch direction. Measure structural action
consolidation separately after the primary hotspot changes land.

## Conclusion

No bound plan is safe to implement exactly as written. Claude's
`3c9b810b4ab3f329cae009004609d76bbfecfc09` is the best-aligned and smallest
starting point: it directly addresses the owner-ranked R4/R5 discovery cost and
Antigravity wait without rewriting evidence semantics. It should be selected
only with Findings 2 and 3 corrected—Git-derived path display must never abort
action publication, and the defaulted start-state field must remain optional at
the typed initializer boundary. Cursor's packet idea needs the pin/path trust
bug fixed before reuse; Antigravity's plan conflicts with clone protocol and
lacks a valid derived-evidence destination; Codex's plan targets the explicitly
lower-priority phases.

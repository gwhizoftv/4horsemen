# Peer Plan Review — Issue 92

## Findings

### 1. Cursor Plan (`44a0512f2292d5dd16ff14b9eff2e4755b7d959b`): Disk Packet Materialization Path Safety
- **Plan Claim or Section**: Section "Exact file list to be created" proposing `src/inputPacket.ts` to materialize implementation blobs into `packets/<inputSetHash>/` under the issue runtime directory.
- **Rule That Must Hold**: All runtime files written by the coordinator from repository commits must enforce strict path containment within the issue root and protect against directory traversal attacks or accumulation across revision rounds.
- **Concrete Failure**: If an agent's implementation commit contains malicious or malformed relative file paths (e.g. `../../etc/passwd` or nested dot segments), writing the packet directory by reconstructing submitted paths without canonical path validation can write outside the runtime sandbox or fail during finalization cleanup.
- **Smallest Correction**: Confine input packet extraction using path sanitization that strips leading slashes and dot-dot segments, or query the mirror directly using in-memory `readBlob` without materializing untrusted trees to disk.

### 2. Claude Plan (`3c9b810b4ab3f329cae009004609d76bbfecfc09`): Omission of Mechanical Step Derivation
- **Plan Claim or Section**: Section "Alternatives Rejected" rejecting step consolidation and clerical step elimination in favor of purely informational action text changes (`changeScope` and `docs/repo-map.md`).
- **Rule That Must Hold**: Coordination efficiency must eliminate structural idle wait time and high-frequency model turns where 99% of input is cached prefix re-reads; purely informational text additions in `action.md` increase prompt size on every tick without removing turn overhead.
- **Concrete Failure**: Retaining separate clerical steps (`R3.publish-selection`, `R5.reviser-auth`, `R6.declare`) forces all agents in the consensus roster to wait sequentially on a single agent to output mechanical 5-line JSON files that the coordinator could compute in under 1 ms, leaving turn counts and wall-clock latency unoptimized.
- **Smallest Correction**: Combine `changeScope` informational context with coordinator-side derivation of clerical steps and consolidated review/ballot commits to capture structural turn savings.

### 3. Codex Plan (`93dce7a2652e1e91488138aee97c6e0d52f932a7`): Total Removal of Participation Readiness Gate
- **Plan Claim or Section**: Section "Scope and Proposed Architecture", proposing complete removal of `R1.join` in workflow version 2.
- **Rule That Must Hold**: The coordinator must verify participation readiness and ensure that all active agent clones are successfully checked out, unblocked, and capable of committing before dispatching high-context planning orders.
- **Concrete Failure**: Removing `R1.join` entirely means that an agent clone with an uninitialized environment, broken tmux session, or checkout conflict will fail during `R2.plan`, wasting hundreds of thousands of context tokens and execution time on heavy planning generation rather than failing early during a zero-context handshake.
- **Smallest Correction**: Retain a lightweight participation readiness handshake (`R1.join`) or verify agent harness responsiveness at start, while deriving intermediate clerical steps (`selection`, `reviser-auth`, `consensus-declaration`).

### 4. Antigravity Plan (`dc6a7bdf3bc731b81382f0944b26cae400c8c21c`): Tracked AGENTS.md Template Synchronization
- **Plan Claim or Section**: Section "Exact File List to be changed or deleted", trimming lines 28–129 of `AGENTS.md` to remove duplication with the install overlay.
- **Rule That Must Hold**: Upstream modifications to tracked documentation templates must preserve workspace install and idempotence test invariants.
- **Concrete Failure**: Modifying `AGENTS.md` without synchronizing `templates/product/AGENTS.protocol.md` and corresponding assertions in `test/install.test.ts` will cause `coord install --write-product` to detect unexpected content drift and fail test suites.
- **Smallest Correction**: Update `test/install.test.ts` test expectations and `templates/product/AGENTS.protocol.md` in lockstep with `AGENTS.md`.

## Conclusion

The four plans present complementary approaches to coordination efficiency:
- **Codex and Antigravity** rightly identify structural action reductions (`2N + 3` model turns eliminated by deriving mechanical clerical steps and consolidating review/ballot steps) as the highest-leverage token and latency optimizations.
- **Cursor and Claude** identify immediate practical developer experience and tool-call reductions via informational context (`changeScope`, `docs/repo-map.md`, and Antigravity unattended flags).

The optimal implementation combines structural turn consolidation (deriving clerical steps coordinator-side and supporting atomic review-and-ballot commits) with repository architecture context and Antigravity unattended launcher configuration, while retaining safe path isolation and test template synchronization.

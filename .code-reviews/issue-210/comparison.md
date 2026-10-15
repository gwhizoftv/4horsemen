# Issue 210 implementation comparison

## Comparison

Prefer **Codex**. All three implementations keep the product change to the
approved report and its README link. Codex provides the most complete mapping
of the existing integration surfaces and identifies an additional Muse blocker:
the documented hook environment drops the issue binding needed by coord's
shell guard. Claude provides a useful, reproducible trace of unknown-vendor
nudge failures. Cursor covers the main subsystems but leaves more of the source
map and documented Muse prerequisites unresolved.

The exact product pins reviewed were:

| Agent | Bound implementation pin | Assessment |
| --- | --- | --- |
| Cursor | `86dd06eb7761e863dd2e69825f80ea9082f917bb` | Broad inventory and capability distinctions; requires corrections to hook-context and pull-mode claims. |
| Claude | `755a65d93d46a7feae802065d4dbde39626d7d02` | Strong behavioral analysis and concrete exhaustive-dispatch proposal; requires hook-context and model-inventory corrections. |
| Codex | `68694071858bcc44a57738a8fad0ae401933e930` | Preferred: comprehensive source map, explicit environment/filesystem blockers, and a bounded recommendation with a costed registry alternative. No blocking finding identified. |

I read the reports and source directly from the three exported implementation
worktrees. Report line numbers in the findings below refer to the named agent's
bound implementation; source line numbers refer to the shared issue baseline
`cb7ed092cb8a5d15f651387651df7c631e4596e6`.

### Findings

1. **[P1] Claude `docs/issue-210-agent-cli-analysis.md:240` and `:275`;
   Cursor `docs/issue-210-agent-cli-analysis.md:277`: the proposed hook mapping
   must account for the issue context required to enforce a shell refusal.**
   Following either map by adding Muse's nested project hooks and matching
   payload/response shapes leaves `COORD_ISSUE` absent. The current generated
   command does not supply it, and `guardShellRequest` returns its allow
   response immediately when it is absent. Thus even a correctly decoded
   `git status --porcelain` request never reaches the policy checker; the
   proposed integration cannot deliver the advertised native refusal.

   The [published hooks reference](https://meta-models.github.io/muse-code-sdk/next/guides/extend/hooks/)
   describes an environment allowlist that excludes arbitrary coordinator
   variables; additional passthrough applies only to managed hooks, not project
   hooks. Its examples are labeled 1.3.0, so live confirmation remains required.
   The relevant baseline code is
   [renderShellGuardHookCommand at src/agentHookSync.ts:48](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L48)
   and [the early allow at src/shellGuard.ts:283](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/shellGuard.ts#L283).

   I reproduced the current behavior without running Git: invoking
   `guardShellRequest` through the existing Claude-compatible decoder with a
   recognized shell payload and `env: {}` returns `{}`. The rendered command
   contains no `COORD_ISSUE` assignment. The follow-up map needs an explicit,
   owner-bound issue-context channel and a test that preserves refusal after
   environment filtering, including stale/restarted sessions. Claude's
   shell-key-only condition and Cursor's payload-only row are insufficient.

2. **[P2] Cursor `docs/issue-210-agent-cli-analysis.md:243` and `:307`:
   pull-mode feasibility must include Git metadata writes as well as mailbox
   access and must not assert a containment layer without observing it.**
   The report presents pull delivery plus the Git shim as an available fallback
   while hook and pane questions remain open. A launch that keeps Muse's
   documented default sandbox cannot stage or commit because `.git` is
   read-only, even if mailbox access is solved. Choosing pull delivery changes
   action transport; it does not remove Git publication or completion-write
   requirements. The report never identifies this documented `.git` restriction
   or makes its resolution a prerequisite to the fallback.

   The [permissions documentation](https://dev.meta.ai/docs/muse-code/permissions)
   distinguishes approval from sandbox policy and describes the protected
   directories. Add that blocker to the launch map and require measured Git,
   external-root and network access before declaring a usable pull participant.
   Shim coverage also needs the actual tool-resolution/refusal probe. The
   existing follow-up criterion for a mailbox grant alone does not establish
   these capabilities.

3. **[P2] Claude `docs/issue-210-agent-cli-analysis.md:86` and `:347`:
   a repository-wide model/configuration inventory must include an existing
   model setting before concluding that model selection comes entirely from
   CLI defaults.**
   The report groups the legacy setup scripts at their identity/launcher
   constants, then says model selection has no plumbing and comes from launcher
   defaults. On a fresh Antigravity setup, however,
   [scripts/setup_antigravity.sh:111](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_antigravity.sh#L111)
   initializes settings with the explicit model at
   [line 117](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_antigravity.sh#L117).
   An owner following the inventory to change model defaults would miss the
   code that actually selects this model. Qualify the claim to the absence of
   an `AgentConfig.model` field and inventory this legacy exception, including
   the fact that existing settings replace the initial defaults. Codex records
   that distinction at report lines 90 and 110–114.

### Scope, reuse and architecture

All three add exactly one product documentation file and a discoverability row
in README. The other paths listed by the action are pre-existing coordination
evidence. None changes runtime behavior, dependencies, tests or fixtures, and
none implements its hypothetical registry. A dedicated report is justified by
the issue's request for a durable cross-module inventory. All reuse existing
test homes for proposed future work rather than creating a new framework.

| Criterion | Cursor | Claude | Codex |
| --- | --- | --- | --- |
| Source map | Main surfaces covered, but several legacy/test entries are grouped paths and some run-loop entries are approximate. | Concrete dispatch and fallback locations; especially clear nudge failure trace. Legacy configuration detail is thinner. | Exact anchors across setup JSON, launch grants, install/remove symmetry, runtime, telemetry and existing test/fixture homes. |
| Muse evidence | Separates observed/documented/open, but leaves native AGENTS loading open despite published documentation and omits the two blockers above. | Strong permission/update analysis and documented key semantics; understates the hook environment work. | Separates observed help/wrapper facts, documented contracts and live unknowns, including both filesystem and environment binding. |
| Reuse | Preserves launcher and behavioral modules. | Preserves those modules and proposes compiler-enforced dispatch. | Preserves those modules and changes only the existing maintenance record for the proven updater exception. |
| Migration cost | Recommends a metadata table with roughly 12 sites; does not establish the claimed payoff as concretely. | Gives a detailed 14-existing-file plus one-new-file migration, including capability subset types and maintenance relocation. | Gives the current 12-file required/automated map and a separate nine-TypeScript-file registry candidate, with no claim that metadata removes behavioral work. |
| Coverage | Names existing tests; no artificial documentation tests added. | Reproduced baseline defaults; names focused future assertions. | Broad existing test/fixture map and explicit unavailable-telemetry behavior; no new test files. |

The recommendation difference is a design tradeoff, not itself a defect.
Exhaustive dispatch can improve the silent fall-throughs Claude identifies.
I prefer Codex's smaller immediate change because adding a metadata table still
leaves Muse's grants, hook binding, trust and terminal behavior to resolve.
Claude's concrete fallback trace is useful supplementary evidence; it does not
require a registry to fix an individual vendor's behavior.

The reports correctly distinguish Muse Code from its underlying model and
separate the installed CLI from the older hook examples. Different recorded
CLI versions or documentation generator hashes are not treated as defects
without evidence that an observation was falsely reported. Published
[configuration documentation](https://dev.meta.ai/docs/muse-code/configuration)
already establishes trusted-project AGENTS loading; its live operation in a
coord clone still needs verification.

### Verification evidence and review checks

The runtime journal records successful hook runs for all three submissions.
These are **advisory hook observations**, not coordinator final verification.
Each precommit index identity equals the corresponding product commit tree,
which I checked using commit metadata in the exported worktrees.

| Agent | Product tree / precommit check:fast measurement | Successful test:e2e push measurement |
| --- | --- | --- |
| Cursor | `c2e32c2124577d19d4aa50095389b80ca29ef9a8`; `753984b4-0ffd-4279-be1d-add870bc1650` (journal sequence 450) | `95f3eb67-fbbd-422b-b029-32739149498a` (sequence 480), outgoing tip `abf00694187110ca6309491f77558084b47fddc5` |
| Claude | `50dd015f00e7957e90151dc3f44a3f3781d09ad9`; `a4ad8597-4c69-4a8e-80f5-f23314f35e0c` (sequence 498) | `422b94d2-bfe3-43b5-942e-74d5d3eb8691` (sequence 500), outgoing tip `278e70785db8a32003bbe487670dba58c4c33c05` |
| Codex | `19787eceb30f1d3fc92232e2c09549d9a764738b`; `1c8ad81f-9fc1-49d9-a0bb-0ae57d70ed5c` (sequence 497) | `7ff32303-4ba8-4636-ae03-5d29de368c65` (sequence 507), outgoing tip `9080ba8a0ec8bacb47aaec989cf3607ab1545717` |

I did not rerun those suites for this comparison. Review checks were:

- Read all three reports and checked the relevant baseline source branches.
- Validated all explicit baseline-linked start-line anchors against the
  exported files: Cursor 52 anchors across 22 files, Claude 90 across 33, Codex
  189 across 62. Every target existed and started on a nonempty line. These
  counts measure linked anchors, not inventory completeness or semantic truth.
- Confirmed each README link resolves to its report.
- Reproduced the missing-environment allow response and independently confirmed
  Claude's unknown-id key, ready-fallback and versioned-process examples using
  the unchanged existing functions. No actual Git probe or Muse session ran.
- Re-read primary Muse permission/configuration sources. The versioned hooks
  URL was unavailable through the browser during this review; the official
  `next` hooks reference above was available and states the same environment
  contract and 1.3.0 example provenance. This does not establish live 1.4.9
  enforcement.

Select Codex's product pin as the revision base. Preserve its bounded scope and
explicit compatibility gates; the findings above apply to the alternative
reports and do not require expanding the selected product file map.

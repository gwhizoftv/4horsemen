# Issue 139 — plan review

Protocol version: 1. Reviewed the exact bound files for:

- Cursor: `1b668bfd64034dacdd0d6b0f7fb4c1dfd930e5a4`
- Claude: `432794d656297a115bc044eecacbaa108fd30c8b`
- Codex: `c4096d1d8aff38b17e298ca0c43816a0335235ff`

The owner selected MIT during planning. That resolves the license choice, not
copyright attribution, ownership/relicensability, or public-release approval.

## Findings

### 1. [P1] Cursor and Claude: do not infer copyright ownership from the GitHub account

**Plan claim/section:** Both creation lists prescribe an MIT `LICENSE` naming
`gwhizoftv`; Cursor's mitigation postpones confirmation until the visibility
flip, while Claude treats plan review as an opportunity for an owner swap.

**Rule:** Workstream A requires confirmation of ownership/relicensability, and
copyright attribution must be confirmed by the owner before a license is
committed. Selecting MIT or approving technical scope is not confirmation that
the hosting account owns every tracked contribution.

**Concrete failure:** Following either file-creation instruction without that
confirmation publishes an ownership assertion and license grant with an
unverified holder and scope. Correcting it before a later visibility flip does
not make the earlier assertion authorized. Neither bound plan establishes the
required confirmation.

**Smallest correction:** Keep MIT selected; make creation of `LICENSE` (and
Claude's package license metadata) conditional on explicit holder/year and
ownership confirmation. If unresolved, publish preparation separately and keep
licensing/public release marked incomplete, as the Codex plan does.

### 2. [P2] Cursor and Claude: the promised private reporting route needs an availability gate

**Plan claim/section:** Both `SECURITY.md` creation entries direct reporters to
GitHub private vulnerability reporting. Claude explicitly defers enabling it
to owner operations; Cursor does not include an enablement/verification step.

**Rule:** The issue requires a usable private reporting path. A documentation
file does not enable GitHub's reporting feature, and guidance must not claim an
unverified channel is available.

**Concrete failure:** If the owner has not enabled private reporting when these
instructions become public, a reporter following the documented Security-tab
route has no report form and no alternative private destination. The promised
security baseline is therefore absent despite the presence of `SECURITY.md`.

**Smallest correction:** Require owner enablement and a reporter-side check, or
an owner-approved working alternative, before claiming readiness. Until then,
mark the channel unresolved and block public release; never fall back to a
public issue containing vulnerability details.

### 3. [P2] Cursor: distinguish the full Go config from an install declaration

**Plan claim/section:** `Reuse and Scope` calls
`config.product.example.json` the canonical Go “`--declare`-style example”, and
the setup-doc change points declaration users at that file without specifying
that only its policy fields are reusable.

**Rule:** A file advertised for `coord install --declare` must satisfy the
strict `workspaceDeclarationSchema`, not just `coordinatorConfigSchema`.
Installer-generated identity, agent roots and install stamps are not declaration
fields (`src/state.ts`, `workspaceDeclarationSchema`; `src/install.ts`,
`readDeclaration`).

**Concrete failure:** A reader passing the linked full example to `--declare`
gets `Invalid --declare` before installation: `project`, `origin`, `agents`,
`baseBranch`, `profile`, `maxRevisionRounds`, and `coordination` are rejected.
Changing its path strings and retaining the existing full-config schema test
does not fix this. Direct schema validation of the current file reproduced
those exact rejected keys.

**Smallest correction:** Label it a full generated-workspace example. Tell
readers to extract only declaration policy fields, and provide a standalone
schema-valid Python declaration with the complete install command. No new
runtime abstraction or example file is required.

### Scope, reuse and test assessment

All three plans correctly avoid Python detection, npm publication, driver or
hook rewrites, and speculative plugin work. They reuse `proposeProjectPolicy`,
the existing config schema tests and bootstrap coverage. The small path-hygiene
assertions are appropriate for these documentation/example changes; existing
Go/Cargo and command-execution tests need not be duplicated.

Claude's additional package metadata and `/tags` ignore are within the issue;
its one shipped-baseline hygiene test is still focused, though document prose
checks should not forbid legitimate explanations of private forks. Cursor's
contributor instructions should distinguish agent branch conventions from normal
human topic-branch PRs rather than imposing the agent workflow on outsiders.

The new community files are justified in all plans. Codex additionally
justifies a durable release-checklist document and uses it to retain audit,
security-channel, anonymous cold-smoke and visibility gates. That is relevant
scope, not a new runtime subsystem. Historical artifact retention is reasonable
only with the pre-publication content audit still required; none of these plans
or tests constitutes evidence that history is secret-free.

No blocking finding in the Codex plan. Its conditional LICENSE delivery means
the preparation PR must not be labeled a completed public release. The issue
explicitly permits staging the work across PRs, so that condition is acceptable.

## Conclusion

Request changes to Cursor and Claude for the attribution and private-reporting
gates; additionally correct Cursor's declaration-example distinction. Accept
the Codex plan as a bounded release-preparation plan, subject to its explicit
owner gates. MIT selection is settled; ownership, reporting availability and
visibility authorization are not inferred from that choice.

Validation for this review: read all three bound plans, inspected the existing
declaration/install schemas, bootstrap and verification tests, ignore rules and
platform-dependent Terminal integration; reproduced the full-config/declaration
schema mismatch. No product implementation was changed.

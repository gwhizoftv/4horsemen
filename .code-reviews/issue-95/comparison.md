# Issue 95 implementation comparison

## Comparison

Compared the exact bound product pins:

- Claude: `b331e9a0cb4cf9acdc455eb272371278ddbc0414`
- Codex: `5f3c7a8b9c18d2f6abf6cc2cb3542609d42d4f17`
- Cursor: `1addcc238016dd198255fef585e0dbdbf3856ef0`

### Findings

No blocking correctness finding distinguishes the three implementations. Each
pin makes the required gate-boundary change without advancing the manifest
version:

- removes the live current-checkout assertion from the fast suite;
- leaves `check:version-bump`, the normal `check` composition, and the PR
  workflow behavior intact;
- replaces the self-rewriting `test:fast` command with direct Vitest;
- derives CLI and emitted-install version expectations independently from the
  root manifest;
- adds hermetic equal, greater, and base-branch cases for
  `checkVersionBump` while retaining the parser/order unit cases; and
- updates the workflow comment, tracked agent guidance, driver/repository docs,
  CLI help, source comment, and failure diagnostic to describe merge-time-only
  enforcement.

The product path set is materially the same in all three pins: the workflow,
tracked `AGENTS.md`, two documentation files, `package.json`, three source
files, and three test files. None changes `package.json.version`, wires the
dedicated gate into `check:fast` or `check`, modifies product hooks, or creates
a new support module.

### Relative strengths

| Area | Claude | Codex | Cursor |
| --- | --- | --- | --- |
| Hermetic gate coverage | Four focused cases: equal, greater, base exemption, and malformed head version | One isolated fixture case covers equal, greater, and base exemption with explicit result objects | Three focused cases cover equal, greater, and base exemption with explicit versions |
| Fixture cleanup | Central `afterEach` cleanup | Local `try`/`finally` cleanup | Central `afterEach` cleanup inside the gate-decision suite |
| Version expectation independence | Direct manifest reads with comments explaining why the production helper is not reused | Direct manifest reads | Direct manifest reads |
| Agent/operator guidance | Most explicit about leaving issue branches at the base version and choosing the bump only after the PR base is current | Correct but intentionally concise | Correct and concise; names both the workflow and standalone command |
| Repository-map cleanup | Replaces the obsolete wrapper section with a complete command-boundary explanation | Replaces it with a short PR-only boundary paragraph | Replaces it with a compact command-list entry |

### Recommendation

Prefer Claude's exact pin
`b331e9a0cb4cf9acdc455eb272371278ddbc0414`. It implements the same correct
behavior as Codex `5f3c7a8b9c18d2f6abf6cc2cb3542609d42d4f17` and Cursor
`1addcc238016dd198255fef585e0dbdbf3856ef0`, while adding the strongest
regression coverage for malformed versions and the clearest explanation of the
new PR-only boundary. Codex is a close second with compact, fully hermetic
coverage; Cursor is also acceptable and differs mainly in test/documentation
depth rather than behavior.

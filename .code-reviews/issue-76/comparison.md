## Comparison

I compared the four exact implementation pins and independently ran
`pnpm check:fast` from each tree. All four passed their declared fast suite:
Cursor ran 350 tests, Antigravity 341, Claude 371, and Codex 352. The Codex
tree also passed the full `pnpm check` suite, including both end-to-end tests.

The preferred implementation is Codex
`5402e1d02c8cca3dd9307281e242c4600dc2b83b`. It is the only candidate that
combines all of the important runtime properties: config-relative agent roots
are resolved before launcher preflight; manual exclusion covers shorthand,
`start`, `attach`, and `run`, including legacy nested issue state; manual
startup checks both current and legacy workspace-owned numeric sessions; and
manual teardown limits linked sessions to the configured agent IDs. Its tests
exercise the no-side-effect boundary, exact teardown, repair/idempotency,
implicit onboarding resolution, and the versioned generated guidance.

Cursor `2857bc3ec2a2bc096a954299d454b67dea973fbf` is the runner-up. Its manual
launch path correctly resolves agent roots, validates launchers before tmux,
repairs panes, and keeps manual state outside the coordinator workflow. It has
two correctness gaps:

- `src/cli.ts:967-984` — The rule is that every automated attach/resume entry
  point must reject a live workspace manual session before opening automated
  UI. The `attach` branch performs no manual-session probe, so `coord attach N`
  can open automated issue clients while manual harnesses are using the same
  clones, violating mutual exclusion.
- `src/tmux.ts:512-519` and `src/detachIssue.ts:149-154` — The rule is that
  manual detach may kill only the exact primary session and linked sessions for
  configured agent IDs. Prefix matching accepts every
  `coord-manual-<group>-*` name, so detaching manual mode can kill an
  unconfigured or otherwise non-target tmux session that happens to share that
  prefix.

Claude `40157df58f5fe280e10c694e8579f004536c9928` has the broadest focused test
expansion and strong documentation, teardown ordering, and pane-repair
coverage, but its default launch path is not viable for the normal installed
configuration:

- `src/cli.ts:572-584` and `src/cli.ts:986-990` — The rule is that agent roots
  stored relative to the workspace config must be resolved against that
  config's directory before launcher validation or tmux launch. The manual
  branch passes `resolution.config.agents` through unchanged, so an onboarded
  `coord manual` invoked from the product resolves `../<project>-<agent>`
  against the product working directory; it then reports a missing launcher or
  targets the wrong clone instead of opening manual mode.
- `src/cli.ts:1008-1025` — The rule is that automated attach must reject a live
  manual session for the same workspace. This branch checks only the numeric
  tmux session, so it can open issue terminals concurrently with manual panes.

Antigravity `40647d94c0e4a1c6d9166b97fed9b9475b926ea5` implements the main manual
session, config-relative launcher resolution, attach exclusion, repair, and
exact configured-agent teardown, but it is the least complete candidate:

- `src/cli.ts:1031-1038` — The rule is that `coord run` must reject a live
  workspace manual session before entering the coordinator loop. This branch
  calls the run loop without any probe, so an agent-facing resume can race
  manual work in the same clones.
- `config.product.example.json:33` — The rule is that the shipped example's
  `coordination.version` must remain aligned with the package release. The
  package is `0.0.12` while the example still says `0.0.11`, so copying the
  example produces stale install metadata and violates the release update
  required by the selected plan.

Recommendation: select Codex
`5402e1d02c8cca3dd9307281e242c4600dc2b83b`; it has no identified blocking
gap and requires no cross-candidate repair before revision.

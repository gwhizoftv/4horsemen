# Issue 139 — implementation comparison

Protocol version: 1. Exact implementation pins reviewed from the bound worktrees:

- Claude: `c79f036028456a635e092b9807c5e2a546561980`
- Codex: `16cc7f3f92e69eb7b575ab0cb6c7c057c6184998`
- Cursor: `3c2dd0bc666c99e9fd081e6f366ae5877d9539d5`

The owner subsequently directed that `LICENSE` be omitted for now. Its absence
is therefore not itself a finding, and this comparison does not request adding
it outside the approved file map. Release documentation must reflect that
deferral rather than present licensing as complete.

## Comparison

### F1 — [P2] Claude's documented Python install command cannot run

**Location:** Claude `docs/setup-workspace.md:424–425`.

**Rule:** The copyable Python `--declare` example must supply the required
`coord install` arguments; unlike `onboard`, `install` has no default agent
roster and requires `--agents`.

**Concrete failure:** The documented invocation exits with code 2 and
`coord: --agents is required.` before reading the declaration or installing
anything. The following doctor command cannot validate the intended new
installation. This breaks the issue's explicit-declaration route for Python
users even though the JSON example itself is valid.

**Illustrative test:** Invoke `runCli` with the argument array printed in that
code block and capture stderr; the current result is the error above. Add an
explicit roster and matching profile, such as `--agents codex --profile solo`,
to the example. Cursor and Codex already supply those required arguments in
their respective Python install commands.

### F2 — [P2] Claude and Cursor do not carry the LICENSE deferral into their release claims

**Locations:** Claude `README.md:257–260`; Cursor `README.md:137–140`.

**Rule:** After the owner defers `LICENSE`, public-facing guidance must not
claim a completed licensed release or link readers to a license file that is
absent from the pinned tree. MIT selection is distinct from completion of the
release's licensing deliverable.

**Concrete failure:** Claude tells readers to see `LICENSE`, but that relative
link has no target. Cursor says “Released under the MIT License” while shipping
no license text and no note that the owner deferred it. The MIT package metadata
does not tell readers that the planned license file was omitted. A reader
cannot follow Claude's promised license link, and neither implementation tells
the reader that the required follow-up remains outstanding.

**Illustrative test:** Check local Markdown link targets against the bound tree;
Claude fails on `README.md -> LICENSE`. For both implementations, review the
license section against `existsSync(<pin>/LICENSE) === false`. Keep MIT as the
planned choice in prose, explicitly record the deferral and remove the
absent-file link rather than adding a new file against the owner's instruction.
Codex does this at `README.md:146–152`. Its choice to defer package license
metadata as well is conservative; retaining the selected SPDX label is not a
separate blocking finding once release status is described accurately.

### Scope, reuse and coverage

| Area | Claude | Codex | Cursor |
| --- | --- | --- | --- |
| Runtime behavior | No source/hook changes | No source/hook changes | No source/hook changes |
| Product file scope | 10 files; includes MIT package metadata | 9 files; package metadata unchanged | 11 files; includes MIT metadata and onboarding-test timeout |
| New permanent files | CONTRIBUTING and SECURITY | CONTRIBUTING and SECURITY | CONTRIBUTING and SECURITY |
| Language guidance | Correct declarations and detector order; install command has F1 | Explicit one-agent install/doctor example and full-config/declaration distinction | Explicit install example and full-config/declaration distinction |
| Focused coverage | One hygiene case in existing verify-config suite | One hygiene case in existing verify-config suite, asserting private distribution | One hygiene case plus existing-test timeout expansion |
| Deferred release work | LICENSE claim needs F2; reporting fallback exists | Licensing, reporting verification, content audit and protected AGENTS follow-up explicitly remain owner gates | LICENSE claim needs F2; reporting fallback refers to a maintainer's published private channel |

All three implementations reuse the current `proposeProjectPolicy`, config and
declaration schemas, existing bootstrap behavior, and the existing
`test/verify-config.test.ts` suite rather than introducing detectors, plugins,
dependencies or new test fixture modules. The Go/Rust/Node/Make descriptions
and explicit Python policy are substantially aligned with existing behavior.
All three neutralize the personal paths in the Go config and analytics examples,
add `/tags` to the shared ignore file, retain `private: true` and the existing
version, and leave other issues' historical artifacts untouched. Human
contribution guidance now uses normal topic branches rather than agent names.
The two new community files are directly justified by the selected plan.

Cursor additionally changes `test/onboard.test.ts:141` from the default 15-second
timeout to 60 seconds without adding coverage or changing the tested feature.
That is unrelated to the documentation change and was not in the selected
plan's exact file list, even though the broad approved `test/` prefix permits
the path mechanically. It does not remove assertions, but it relaxes the
existing test's execution bound; prefer a separately justified test-infrastructure
change rather than incorporating it into this release-preparation selection.
Claude and Codex leave that test unchanged.

Codex has more release-gate prose, but no extra checklist file or runtime
abstraction. Its explicit single-harness onboarding example also matches the
minimum prerequisite without silently choosing all four default harnesses.
Claude and Cursor explain the default roster, so that is a usability advantage,
not an additional blocking finding. Claude's one-week security acknowledgement
promise should be confirmed by the maintainer; no such service commitment is
established by the issue. None of these files proves that GitHub private
reporting is enabled or that an anonymous public cold install has succeeded.

### Verification and recommendation

Read the materialized files at all three pins and used the coordinator's changed
path lists, without fetching or substituting newer branch tips. Direct checks
against the bound bytes established:

- All three Python JSON examples satisfy `workspaceDeclarationSchema`, and all
  three Go workspace examples satisfy `coordinatorConfigSchema`.
- The relevant CLI, schema and policy source files match the local checked
  implementation byte-for-byte; executing Claude's exact documented Python
  install argv reproduces F1 without installation side effects.
- The local links checked in README, CONTRIBUTING, SECURITY and setup docs are
  present except for Claude's `README.md -> LICENSE` link.
- `sh -n` succeeds for all three bound bootstrap scripts.

The materialized peer trees have no installed dependencies, so these checks are
not a claim that their complete suites ran. The Codex implementation's full
`pnpm check` previously passed on the submitted product tree (622 fast tests and
2 e2e tests); this comparison changes no product code. `pnpm check:fast` passed
again before publication of this artifact: 40 files, 622 tests.

**Prefer Codex `16cc7f3f92e69eb7b575ab0cb6c7c057c6184998`.** No blocking defect
was found in its scoped release-preparation implementation. Claude requires F1
and F2; Cursor requires F2 and should separate the unrelated timeout change.
Accepting any preparation implementation must not be treated as authorization
to flip visibility or as completion of the deferred licensing/security/audit
and public-install acceptance gates.

## Comparison

Bound implementation pins compared: claude `b24676e48af4a45793ca01b54ae14f997ccafc0d`, cursor `90c618789a3d941d48a492c9f98f7ae3b0fee039`, codex `af2cadc0edfabad30ff2fb0e6d21576daa763ab0`.

All three stay inside the approved product map, add the planned `src/githubAuth.ts` + `test/githubAuth.test.ts`, and wire account selection through install/onboard, mirror `-c` helpers, start freeze, resume preflight, wipe `ghEnv`, and launcher `GH_TOKEN` export without `gh auth switch` for selection. No peer adds out-of-map product files. Claude and cursor reuse local shell-quoting / schema copies to avoid import cycles; codex reaches `shellQuote` through `agentHookSync`. Focused coverage is similar (wrapper, verify, credential helper, install/cli/mirror/runLoop cases); claude’s wiring check also asserts the helper values, not only `coord.githubAccount`.

**Preference: claude** — closest to the selected plan’s failure modes and launcher discipline, with the strongest clone-wiring preflight and no extra CLI surface.

### Findings

1. `scripts/lib/launcher.sh:434` (cursor `90c618789a3d941d48a492c9f98f7ae3b0fee039`); rule: every clone-local `git config` read in the generated launcher must run before `.coord/bin` is prepended to `PATH`, because the shim refuses checkout reads once `COORD_ISSUE` is set (existing comment at lines 427–431); failure: under an automated issue the `coord.githubAccount` lookup can be refused or mishandled after the shim is on `PATH`, so the launcher never exports `GH_TOKEN` or exits with a false “unavailable” path even when gh credentials are valid. Smallest test: install with `githubAccount` set, write a launcher, assert the `coord.githubAccount` block appears above the `.coord/bin` `PATH` export (claude `b24676e48af4a45793ca01b54ae14f997ccafc0d` and codex `af2cadc0edfabad30ff2fb0e6d21576daa763ab0` already order the block earlier).

2. `src/cli.ts:1216` and `scripts/lib/launcher.sh:363` (codex `af2cadc0edfabad30ff2fb0e6d21576daa763ab0`); rule: the selected plan resolves the launcher token with `gh auth token --hostname github.com --user <account>` (ambient token env stripped), not a new CLI operation; failure: `auth launch-token` adds an undocumented owner-facing command that must stay in lockstep with verify/login and prints a live token on stdout, expanding the approved surface beyond the plan’s three channels (gh `GH_TOKEN`, git helper, launcher `gh auth token`). Smallest test: generated launcher contains `gh auth token --hostname github.com --user` and does not invoke `auth launch-token`.

3. `src/githubAuth.ts:3` with `src/state.ts:1` and `src/agentHookSync.ts:3` (codex `af2cadc0edfabad30ff2fb0e6d21576daa763ab0`); rule: `githubAuth` must not import modules that already import `state` when `state` imports `githubLoginSchema` from `githubAuth` (cycle); failure: `githubAuth → agentHookSync → state → githubAuth` loads only because of `z.lazy`, so a future eager use of schema/helpers at module init breaks install and start. Fix sketch: local `shellQuote` in `githubAuth` (as cursor) or a tiny shared quote helper with no `state` edge; keep a local schema copy in `state` (as cursor) or invert the dependency.

4. `src/githubAuth.ts:154` (cursor `90c618789a3d941d48a492c9f98f7ae3b0fee039`); rule: clone wiring must accept the same case-insensitive login equality used by `verifyGitHubAccess` for `.login`; failure: a clone recorded as `Acct` against frozen `acct` fails resume with “Run: coord onboard” even though verification would accept the credential. Smallest test: `assertCloneGitHubWiring("acct", [clone])` passes when `coord.githubAccount=Acct` (codex already lowercases both sides).

5. `src/setupWorkspace.ts:853` (claude `b24676e48af4a45793ca01b54ae14f997ccafc0d`) vs cursor/codex wiring helpers; observation (not a defect on claude): claude’s `cloneGitHubWiringProblem` also requires the empty reset helper plus an account-marked helper value, matching the plan’s install assertions more tightly than cursor/codex checks that only compare `coord.githubAccount`. Prefer keeping that helper check if revising peers toward claude.

### Scope and reuse summary

| Pin | Within issue / map | Reuse | Extra surface | Notable gap |
| --- | --- | --- | --- | --- |
| claude `b24676e48af4a45793ca01b54ae14f997ccafc0d` | yes | planned helpers; local quote; no cycle | none | none material |
| cursor `90c618789a3d941d48a492c9f98f7ae3b0fee039` | yes | planned helpers; local schema/quote | none | launcher git-config after shim; case-sensitive wiring |
| codex `af2cadc0edfabad30ff2fb0e6d21576daa763ab0` | yes | `shellQuote` via `agentHookSync` | `auth launch-token` | import cycle risk; launcher not direct `gh auth token` |

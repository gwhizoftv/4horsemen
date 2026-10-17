# Issue 234 — plan review (claude)

Reviewed pins:

- cursor `950af137fa180b8f0d8a5a8805c4b4a0ac836b0d`
- codex `f42cecbaffc98d1d980eef1294b803e6a16844dc`
- claude `b41d415ef1dadbd91982d4410e16a38e6f63af9c`
- antigravity `0802da2c9c4f98e5517c3fa55e14e73a1d443c3a`

I read all four from the bound input files and checked their claims against the
baseline source. The only command I ran was the two focused vitest invocations
quoted in F4 and F5, to confirm the test-command findings. I ran no product
suite.

## Findings

### F1 — cursor, claude, antigravity: the file map does not approve `coord` (blocking)

- **Plan claim:** cursor lists `coord` under "Exact File List to be changed or
  deleted". So does claude. Antigravity lists `coord` as its first entry.
- **Rule:** every path the implementation changes must be extractable from the
  plan. `extractApprovedPaths` keeps a backticked token only if `isFileMapPath`
  accepts it. `isFileMapPath` returns `body.includes(".")` for a single-segment
  token (`src/evidence.ts:101`), so the extensionless root file `coord` is never
  approved. Two-segment tokens such as `scripts/coord-node` are approved.
- **Failure:** the implementation's central change, to the `coord` wrapper,
  falls outside the approved paths. The coordinator rejects the implementation
  pin as out of scope, after the work is done.
- **Correction:** add the token `coord/` (codex's approach). `approvedTreeRoot`
  strips the slash and `matchesApprovedPath` then matches the regular file
  `coord` exactly.

### F2 — claude: the hook library locates the resolver relative to its own file, which breaks vendor mode (blocking)

- **Plan claim:** Design, `githooks/lib/policy.sh`: "the install root taken
  from the library's own location (`${BASH_SOURCE[0]}/../..`)".
- **Rule:** the hook bridge must find coordination files through the clone's
  recorded `coord.cliEntry`, because in vendor mode the library is not inside
  the install. `VENDOR_LIB_FILES` includes `lib/policy.sh`
  (`src/hookSync.ts:31`), and `plannedHookContents` copies it into the clone's
  hooks directory (`src/hookSync.ts:182-185`).
- **Failure:** in a clone installed with `--vendor`, `BASH_SOURCE/../..`
  resolves to `<clone>/.git`. The library then looks for
  `<clone>/.git/scripts/coord-node`, which is missing, and fails closed. Every
  commit in every vendor-mode clone is blocked, even when the Node on `PATH`
  qualifies. That is a regression from baseline.
- **Correction:** derive the path from the entry, as codex does:
  `"$(dirname "$entry")/../scripts/coord-node"`. Add one vendor-mode case to
  claude's test 5.

### F3 — cursor, antigravity: fixing only the wrapper leaves coord's other Node entry points on the workspace Node (blocking)

- **Plan claim:** both plans change only `coord` and `test/wrapper.test.ts`.
  Cursor rules out everything else as "unrelated to the entry wrapper".
- **Rule:** the issue requires coord to use the Node it needs "for itself".
  Coord also starts its own JavaScript in three other ways:
  - the git hook bridge (`githooks/lib/policy.sh:51,60`: `node "$entry" ...`);
  - the GitHub credential helper (`src/githubAuth.ts:37`:
    `!/usr/bin/env node ...`);
  - the lifecycle, shell-guard and status-line hooks
    (`src/agentHookSync.ts:40,50,377`; `src/claudeStatusLine.ts:130`).
- **Failure:** take Soundsplore (Node 16) after a wrapper-only fix.
  - **At `coord start`:** coord's own process now has an unchanged `PATH`
    (antigravity's design). `BareMirror` passes the credential helper to git
    (`src/cli.ts:747-748`), and git runs `/usr/bin/env node .../main.js auth
    git-credential` under v16, which crashes with the same
    `ERR_UNKNOWN_BUILTIN_MODULE`. Coord resets inherited helpers before its own
    (`src/githubAuth.ts:40`), so no other helper takes over and the mirror
    fetch of a private repo fails.
  - **In every agent pane:** the launcher runs `nvm use` against the product's
    `.nvmrc` (`scripts/lib/launcher.sh:19-29`). The first `git commit` then
    runs `node "$entry" hook-verify` under v16 and is blocked, and `git push`
    has the same helper crash.
  - Onboarding succeeds, but the product still cannot be coordinated.
- **Correction:** route these entry points through the same resolver (the
  claude and codex scope).

### F4 — cursor: `nvm use` inside the wrapper either never takes effect or changes the Node the product runs on, and it writes to protocol stdout (blocking)

- **Plan claim:** Exact File List, `coord` step 3: "source it and run
  `nvm use` with cwd set to `$ROOT` only (subshell or explicit `cd` that does
  not persist as the caller's cwd)". Risks: "Sourcing nvm mutates PATH only
  inside the wrapper process … `exec` replaces that process so the caller's
  interactive shell is unchanged."
- **Rule:**
  - The selected Node must reach the `exec`.
  - The caller's `PATH` must not change for coord's children, which include
    product verification commands run by the verification runner. The issue
    says "without changing the workspace's development version of node".
  - The wrapper must not write to stdout before the CLI does, because
    `coord next` stdout is the protocol channel (`test/wrapper.test.ts`
    "keeps stale-build output off protocol stdout").
- **Failure:** the two readings of the plan fail in different ways.
  - **In a subshell:** the `PATH` change from `nvm use` is lost, the re-probe
    in step 4 sees v16 again, and the nvm fallback can never succeed.
  - **In the wrapper process:** `exec` keeps the environment, so the coord
    process and everything it spawns have Node 26 first on `PATH`. The
    product's declared checks then run on Node 26 instead of its own Node 16,
    and the risk note is wrong because `exec` does not reset the environment.
  - **In both cases:** `nvm use` prints `Now using node v26…` to stdout, ahead
    of the `---` action front matter that `coord next` emits.
- **Correction:** probe nvm's installed binaries directly, as the claude,
  codex and antigravity plans do. `exec` the absolute binary with the original
  `PATH`.

### F5 — cursor, antigravity: the named development test command runs zero tests

- **Plan claim:** cursor: `pnpm vitest run --config vitest.config.ts
  test/wrapper.test.ts`. Antigravity: `pnpm vitest run test/wrapper.test.ts`.
- **Rule:** plans must name real commands. `vitest.config.ts` excludes
  `test/wrapper.test.ts`, which runs only under `vitest.system.config.ts`.
- **Failure:** I ran both forms. Each printed `filter: test/wrapper.test.ts …
  exclude: … test/wrapper.test.ts …` and exited 1 without running a test. An
  implementer following either plan gets no feedback on the new cases.
- **Correction:** `pnpm exec vitest run --config vitest.system.config.ts
  test/wrapper.test.ts`.

### F6 — codex: generated commands bake in a versioned `process.execPath`

- **Plan claim:** Exact File List: `src/githubAuth.ts`, `src/agentHookSync.ts`
  and `src/claudeStatusLine.ts` render "the shell-quoted absolute
  process.execPath". Implementation behavior 6: "Generated JavaScript callback
  commands capture the already selected process.execPath."
- **Rule:** commands that persist in clone configuration (git
  `credential.helper`, harness hook JSON, status-line tees) must survive a
  routine Node patch upgrade, as the baseline `/usr/bin/env node` does.
  `process.execPath` is the resolved binary in a versioned directory, for
  example `~/.nvm/versions/node/v26.1.0/bin/node` or
  `/opt/homebrew/Cellar/node/26.1.0/bin/node`.
- **Failure:** after `nvm install 26 && nvm uninstall 26.1.0`, or
  `brew upgrade node` followed by the automatic `brew cleanup`, every agent
  clone's credential helper and lifecycle/guard hook points at a deleted file
  and exits 127. Agent `git push` fails authentication on every clone until the
  owner reinstalls. Codex's risk entry accepts this and proposes documentation.
- **Correction:** the plan already creates a run-time selector
  (`scripts/lib/node-runtime.sh`). Render
  `'<install>/scripts/lib/node-runtime.sh' '<cliEntry>' …` instead of
  `process.execPath`. That is the same mechanism the plan uses for the hook
  bridge, and it removes the documentation step.

### F7 — codex: the test list is broader than the action allows

- **Plan claim:** Tests 1–5 parameterize, among others:
  - paths and arguments containing spaces;
  - prerelease and malformed probe output;
  - future majors;
  - stdin and exit-status pass-through;
  - build-failure propagation;
  - bootstrap rerun, ownership and link behavior;
  - shim and vendor modes for passing and failing product checks.
- **Rule:** the action asks for "the fewest focused tests that fail before the
  change and pass after it".
- **Failure:** several cases already pass on the baseline wrapper (cwd and
  argument preservation, stdin, exit status, build-failure propagation,
  bootstrap rerun and ownership), so they do not pin this change. Spread across
  six test files, they enlarge the system suite and the review surface for no
  coverage of issue 234.
- **Correction:** keep the cases that fail on baseline:
  - an old `PATH` Node with a qualifying fallback;
  - no qualifying Node refuses before the build;
  - `COORD_NODE` precedence;
  - the child keeps the product's `PATH`;
  - the hook bridge under an old `PATH` Node, in vendor mode;
  - a rendered helper under an old `PATH` Node;
  - the selector included in the digest;
  - `.nvmrc` agrees with engines.

### F8 — codex: `scripts/setup_common.sh` is outside the issue's entry points

- **Plan claim:** change `common_configure_trust` because "it imports the
  driver's compiled agentTrust module".
- **Rule:** stay within the issue and justify every changed file. No `src/`
  code path invokes `scripts/setup_common.sh`. It is sourced only by the legacy
  `scripts/setup_{claude,codex,cursor,antigravity}.sh` and exercised directly by
  `test/install.test.ts:130,166`.
- **Failure:** this is not a runtime failure, but it adds a changed file and an
  extra old-Node install/trust test for a path that `coord onboard`, `coord
  install` and `coord start` never take.
- **Correction:** drop it, or justify it with a coord command that reaches it.

### F9 — antigravity: fallback branches the plan never tests

- **Plan claim:** the resolver tries `nvm which` after sourcing
  `"$NVM_ROOT/nvm.sh" --no-use`, then scans `versions/node`, then tries
  `fnm which`.
- **Rule:** no speculative flexibility, and every resolution branch that ships
  needs a test. `COORD_NODE` already covers other managers.
- **Failure:** neither test case provides an `nvm.sh` or an `fnm`, so the
  `nvm which` and `fnm` branches ship untested. A wrong subcommand or flag in
  either goes unnoticed, and when either fails it falls through to code paths
  the tests do cover. Sourcing `nvm.sh` also adds noticeable startup cost to
  every old-Node invocation, which the direct directory scan avoids.
- **Correction:** keep `COORD_NODE`, then `PATH` (`type -a -P node`, which
  works on `/bin/bash` 3.2.57 here), then the `versions/node` scan. Drop
  sourcing `nvm.sh` and drop fnm. (`sort -Vr` is available on this macOS host,
  so that part is not a finding.)

### Scope and reuse summary

- **cursor and antigravity:** smallest file lists, but they leave the hook and
  credential-helper failures in F3.
- **claude:** full entry-point coverage with one justified new executable and
  reuse of `coordCliEntry`'s resolution, but blocked by F1 and F2.
- **codex:** the most complete and correct scope handling. It has the
  `coord/` token, resolves from `cliEntry` in vendor mode, and names the right
  vitest configs. It needs F6 to avoid a durability regression, and F7 and F8
  to stay focused.

## Conclusion

No plan is acceptable as written.

- **codex** is the best base. Its coverage of entry points, vendor mode and the
  scope token is correct. It needs the F6 correction (render the run-time
  selector, not `process.execPath`) and the trims in F7 and F8.
- **claude** is acceptable if F1 (add `coord/`) and F2 (resolve from
  `coord.cliEntry`) are fixed.
- **cursor** fails F1, F3, F4 and F5.
- **antigravity** fails F1, F3 and F5, and needs F9.

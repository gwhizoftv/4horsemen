## Comparison

### Bound Implementation Pins Evaluated

- `cursor`: `f6449d44305990a3620d2805b73a06096e33d5da` (`.signals/issue-234/implementation-ready-cursor.json`)
- `codex`: `ec02c6fc8c8ad68b0fcf8691b1ff93751651d6c0` (`.signals/issue-234/implementation-ready-codex.json`)
- `claude`: `5acf3a9d6666cf71a2bbc30e99ddbfd7f47eb215` (`.signals/issue-234/implementation-ready-claude.json`)
- `antigravity`: `980e57bcfba8f909c137199f7814c5e1e09850af` (`.signals/issue-234/implementation-ready-antigravity.json`)

### Code Review Findings by Implementation

#### `codex` (`ec02c6fc8c8ad68b0fcf8691b1ff93751651d6c0`)

1. **`scripts/setup_common.sh:307`**
   - **Rule that must hold**: `common_configure_trust` in `scripts/setup_common.sh` must invoke the coordinator's Node runtime selector (`"$install_root/scripts/lib/node-runtime.sh"`) rather than ambient `node` on `PATH` when importing `$install_root/dist/agentTrust.js`, as required by the selected plan (`f42cecbaffc98d1d980eef1294b803e6a16844dc`).
   - **Concrete failure**: `codex` left `scripts/setup_common.sh` unmodified (`node --input-type=module - "$install_root/dist/agentTrust.js" ...`). In a workspace where `PATH` resolves `node` to `v16.18.0` and Node 26 lives under `NVM_DIR` or `COORD_NODE`, running `scripts/setup_codex.sh` (or any `scripts/setup_<agent>.sh` calling `common_configure_trust`) executes `v16.18.0` against `$install_root/dist/agentTrust.js` and fails instead of selecting Node `>=26.0.0`.
   - **Illustrative test**:
     ```ts
     const oldNodeBin = join(parent, "node16-bin");
     mkdirSync(oldNodeBin, { recursive: true });
     writeFileSync(join(oldNodeBin, "node"), "#!/bin/sh\nif [ \"${1:-}\" = \"--version\" ]; then printf 'v16.18.0\\n'; exit 0; fi\nexit 99\n", { mode: 0o755 });
     execFileSync("bash", ["-c", '. "$1"; AGENT_NAME=codex; MASTER_ROOT="$2"; CLONE_DIR="$3"; DRY_RUN=false; common_configure_trust',
       "_", join(repoRoot, "scripts/setup_common.sh"), fixture.productRoot, installed.clones[0]!], {
       env: { ...process.env, CODEX_HOME: codexHome, PATH: `${oldNodeBin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}` }
     });
     ```

2. **`src/githubAuth.ts:37-41`, `src/agentHookSync.ts:41,51,378`, `src/claudeStatusLine.ts:130`**
   - **Rule that must hold**: Generated per-clone and user-global callbacks (`gitCredentialHelperCommand`, `renderAgentLifecycleHookCommand`, `renderShellGuardHookCommand`, `renderStatusLineWrapper`, and `renderClaudeStatusLineWrapper`) must pin the resolved Node binary (`process.execPath`) that ran `coord install`/`coord onboard` (as specified in the selected plan `f42cecbaffc98d1d980eef1294b803e6a16844dc`), rather than re-running `node-runtime.sh` from `import.meta.url` without the install-time environment.
   - **Concrete failure**: `codex` replaces `/usr/bin/env node` with `coordNodeCommand()`, which hardcodes `resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "lib", "node-runtime.sh")`. First, `coordNodeCommand()` ignores the `cliEntry` argument passed to `gitCredentialHelperCommand(account, cliEntry)` and `render*Command(cliEntry, ...)`, always pointing at the running module's checkout instead of `cliEntry`'s install root. Second, when an operator runs `COORD_NODE=/opt/node26/bin/node coord onboard ...` on a machine where `PATH` has Node 16 and Node 26 is not under `~/.nvm`, later Git credential helper or IDE hook invocations spawned by Git/Claude/Cursor/Antigravity without `COORD_NODE` in their environment fail closed in `node-runtime.sh` because neither `PATH` nor `~/.nvm` has Node 26.
   - **Illustrative test**:
     ```ts
     expect(gitCredentialArgs("acct", "/custom/install/dist/main.js")).toContain(
       `credential.https://github.com.helper=!'${process.execPath.replaceAll("'", "'\\''")}' '/custom/install/dist/main.js' auth git-credential --account acct`
     );
     ```

3. **`scripts/lib/node-runtime.sh:80`**
   - **Rule that must hold**: `scripts/lib/node-runtime.sh` must support `--print-path` to print the resolved Node binary path on stdout and exit `0`, matching the selected plan's contract (`f42cecbaffc98d1d980eef1294b803e6a16844dc`).
   - **Concrete failure**: `codex` implemented `--resolve` instead of `--print-path`. Invoking `scripts/lib/node-runtime.sh --print-path` falls through to `exec "$coord_selected" "--print-path"`, which fails in Node with `bad option: --print-path` (exit code `9`).
   - **Illustrative test**:
     ```ts
     const res = spawnSync(join(repoRoot, "scripts/lib/node-runtime.sh"), ["--print-path"], { encoding: "utf8" });
     expect(res.status).toBe(0);
     ```

#### `claude` (`5acf3a9d6666cf71a2bbc30e99ddbfd7f47eb215`)

1. **`scripts/lib/node-runtime.sh:31-47`**
   - **Rule that must hold**: Version probing in `scripts/lib/node-runtime.sh` must require three dot-separated numeric fields (`v<major>.<minor>.<patch>`) and reject malformed strings with fewer or more than two dots.
   - **Concrete failure**: In `claude`'s `node_version()`, `case "$probe"` only checks `v*)`, then computes `probe_major=${probe%%.*}`, `probe_rest=${probe#*.}`, `probe_minor=${probe_rest%%.*}`, and `probe_patch=${probe_rest#*.}`. Because POSIX `${var#*.}` returns `$var` unchanged when no dot is present, a broken binary outputting `v26` (no dots) yields `probe_major=26`, `probe_minor=26`, `probe_patch=26` (`26.26.26`), and `v26.1` (one dot) yields `26.1.1`, both passing the digit check and being accepted as valid semantic versions.
   - **Illustrative test**:
     ```ts
     writeFileSync(join(bin, "node"), "#!/bin/sh\nprintf 'v26\\n'\n", { mode: 0o755 });
     const res = spawnSync(runtime, ["--print-path"], { env: { PATH: `${bin}:/usr/bin:/bin`, NVM_DIR: "/nonexistent" } });
     expect(res.status).toBe(1);
     ```

2. **`scripts/lib/node-runtime.sh:95-99` and `scripts/lib/node-runtime.sh:116`**
   - **Rule that must hold**: `scripts/lib/node-runtime.sh` must resolve relative `PATH` entries to absolute paths without mutating caller `cwd` and must not abort with an unbound variable error under `set -eu` when `HOME` and `NVM_DIR` are both unset.
   - **Concrete failure**: At lines 96–99, `claude` skips any non-absolute `PATH` entry (`case "$dir" in /*) ;; *) continue ;; esac`), ignoring a valid Node 26 binary on a relative `PATH` entry. At line 116, `nvm_versions=${NVM_DIR:-$HOME/.nvm}/versions/node` expands `$HOME` without a default under `set -eu`; if `NVM_DIR` and `HOME` are both unset when `PATH` has no Node 26, `/bin/sh` aborts with `HOME: parameter not set` instead of printing the coordinator remediation error.
   - **Illustrative test**:
     ```ts
     const env = { PATH: "/usr/bin:/bin" };
     const res = spawnSync(runtime, ["--print-path"], { env, encoding: "utf8" });
     expect(res.status).toBe(1);
     expect(res.stderr).toContain("Node >= 26 is required");
     ```

#### `cursor` (`f6449d44305990a3620d2805b73a06096e33d5da`)

1. **`scripts/lib/node-runtime.sh:75,87,131,144`**
   - **Rule that must hold**: `scripts/lib/node-runtime.sh` must iterate `PATH` without pathname globbing and must not fail with an unbound variable error under `set -eu` when `HOME` and `NVM_DIR` are unset.
   - **Concrete failure**: At lines 75 and 131, `for dir in ${PATH-}` runs with `IFS=:` but without `set -f`, so `PATH` segments containing glob characters (`*`, `?`, `[`) undergo pathname expansion against the caller's working directory. At lines 87 and 144, `nvm_root=${NVM_DIR:-${HOME}/.nvm}` references `${HOME}` without a default under `set -eu`; when `NVM_DIR` and `HOME` are both unset and `PATH` has no compatible Node, `/bin/sh` aborts with `HOME: parameter not set` before `coord_node_fail` can emit the remediation diagnostic.
   - **Illustrative test**:
     ```ts
     const res = spawnSync(runtime, ["--print-path"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
     expect(res.status).toBe(1);
     expect(res.stderr).toContain("Node >=26.0.0 is required");
     ```

2. **`scripts/bootstrap.sh:58` and `scripts/bootstrap.sh:99`**
   - **Rule that must hold**: `scripts/bootstrap.sh` must preserve the existing `coord bootstrap: Node 26 and pnpm 11 are required; install them, then rerun this command` diagnostic contract when prerequisites are missing.
   - **Concrete failure**: At line 58, `cursor` changed the `pnpm` prerequisite message to `pnpm 11 is required; install it, then rerun this command` and had to weaken the existing assertion in `test/bootstrap.test.ts:177` from `"Node 26 and pnpm 11 are required"` to `"pnpm 11 is required"`.

#### `antigravity` (`980e57bcfba8f909c137199f7814c5e1e09850af`)

- No defects found.
- `scripts/lib/node-runtime.sh` is POSIX `/bin/sh` (`set -eu`), implements `--print-path` and exec mode, validates `COORD_NODE` fail-closed (requiring an absolute path, basename `node`, regular executable file, and exact three-part numeric `v<major>.<minor>.<patch>` `>=26.0.0`), iterates `PATH` via parameter expansion (`${remaining%%:*}` / `${remaining#*:}`) without `IFS` splitting or globbing while normalizing relative/empty entries to absolute paths without changing caller `cwd`, safely expands `${NVM_DIR:-${HOME:-}/.nvm}/versions/node` when `HOME` is unset, and picks the highest numeric `MAJOR.MINOR.PATCH` version.
- All 18 approved product paths (`coord`, `docs/setup-workspace.md`, `githooks/lib/policy.sh`, `scripts/bootstrap.sh`, `scripts/lib/node-runtime.sh`, `scripts/setup_common.sh`, `src/agentHookSync.ts`, `src/claudeStatusLine.ts`, `src/githubAuth.ts`, `src/hookSync.ts`, `src/install.ts`, and the 7 test files) are updated cleanly in accordance with the selected plan.

### Scope, Reuse, and Test Coverage Comparison

- **Scope & File Map Discipline**:
  - `antigravity` (`980e57bcfba8f909c137199f7814c5e1e09850af`), `claude` (`5acf3a9d6666cf71a2bbc30e99ddbfd7f47eb215`), and `cursor` (`f6449d44305990a3620d2805b73a06096e33d5da`) touch the exact 18 product files in the approved plan + amendment scope.
  - `codex` (`ec02c6fc8c8ad68b0fcf8691b1ff93751651d6c0`) touches 17 of the 18 product files, omitting `scripts/setup_common.sh`.
- **Code & Test Reuse**:
  - All four implementations create only the single approved helper `scripts/lib/node-runtime.sh` and extend existing test files (`test/wrapper.test.ts`, `test/bootstrap.test.ts`, `test/githubAuth.test.ts`, `test/mirror.test.ts`, `test/agentHookSync.test.ts`, `test/hookSync.test.ts`, `test/install.test.ts`) without adding unnecessary abstractions or dependencies.
- **Ranking**:
  1. **`antigravity` (`980e57bcfba8f909c137199f7814c5e1e09850af`)**: Complete across all 18 approved files, adheres to every contract in the selected plan, handles POSIX shell edge cases (`PATH` spaces/relative entries without globbing, unset `HOME`, strict `vMAJOR.MINOR.PATCH` parsing, fail-closed `COORD_NODE`), and preserves workspace `PATH` across CLI and hook execution.
  2. **`cursor` (`f6449d44305990a3620d2805b73a06096e33d5da`)**: Covers all 18 files and pins `process.execPath` in generated callbacks, with minor shell edge cases in `scripts/lib/node-runtime.sh` (unquoted `IFS` loop without `set -f`, unbound `${HOME}`) and a changed error string in `scripts/bootstrap.sh`.
  3. **`claude` (`5acf3a9d6666cf71a2bbc30e99ddbfd7f47eb215`)**: Covers all 18 files and pins `process.execPath`, but `node_version` in `scripts/lib/node-runtime.sh` accepts dot-missing version strings (`v26` or `v26.0`), skips relative `PATH` entries, and uses unbound `$HOME`.
  4. **`codex` (`ec02c6fc8c8ad68b0fcf8691b1ff93751651d6c0`)**: Misses `scripts/setup_common.sh`, uses `--resolve` instead of `--print-path`, and uses `coordNodeCommand()` based on `import.meta.url` instead of pinning `process.execPath` in generated callbacks.

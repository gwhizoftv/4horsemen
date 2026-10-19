# Issue 240 implementation comparison (claude)

Bound implementation pins compared, each read from its materialized worktree:

- codex `613dfd04d651c73b180a1033753e6c974dc45301`
- muse `2f48a6b3cdc68d2a8c7ac32e84d37b13a24f725d`
- cursor `76db847bd32cde6a0adb55d5a68792caf23270bb`
- claude `16dd9d5a4e1242ff63dd36250caf9c24ff564626` (my own)

I read each pin's diff against the frozen baseline `a85a915722c3445299eea9d8d3eb5933267a7778` for:

- `scripts/lib/launcher.sh`
- `src/cli.ts`
- `docs/coord-driver.md`
- `test/cli.test.ts`
- `test/install.test.ts`

All four pins change exactly these five product paths, plus their own coordination artifacts. None adds a file, dependency, or unrelated refactor.

## Comparison

### What all four share

All four implement the selected plan's core:

- **`launcher_executable`:** each adds this agent-to-executable map.
- **`launcher_environment <agent> <executable>`:** each resolves the vendor CLI beside coord's Node (`coord.cliEntry` → `node-runtime.sh --resolve`) before the clone's `nvm use`.
- **Shebang handling:** Node-shebang CLIs are interpreted with coord's Node.
- **Exec lines:** every `launcher_command` exec line becomes `exec "${coord_agent_cmd[@]}" …`.
- **Maintenance:** `updateAgentVersions` execs the same `coord_agent_cmd`.
- **Tests:** each extends the existing real-bash test "updates and launches the same … after nvm setup" in `test/cli.test.ts`, and updates the two launcher-text expectations in `test/install.test.ts`.
- **Docs:** each rewrites the `docs/coord-driver.md` maintenance paragraph and states that `coord install` refreshes existing launchers.

They differ on the review-stage corrections, listed in this table.

| Concern | codex | claude | muse | cursor |
|---|---|---|---|---|
| CLI found only through the product pin (post-`nvm` fallback) | yes, tested | yes, untested | **no** | **no** |
| Updater children get coord's Node first on PATH | yes, tested (`exit 42` on wrong Node) | yes, tested | **no** | **no** |
| Pane keeps product Node for agent commands | yes, tested | yes, tested | yes | yes |
| Launcher tests in `test/install.test.ts` isolated from host vendors | **yes** | no | no | no |
| Selector failure handling | refuses | warns and falls back to PATH | warns and falls back to PATH | warns and falls back to PATH |
| Muse and no-`.nvmrc` cases covered | yes | no | no | no |

### Findings

#### 1. `scripts/lib/launcher.sh` (muse and cursor): no fallback to a CLI reachable only after `nvm use`

Where:
- muse: `scripts/lib/launcher.sh:42` (`coord_bin="$(PATH="${coord_search}$PATH" command -v …)"`, evaluated before the `.nvmrc` block)
- cursor: `scripts/lib/launcher.sh:63` (`search=…$pre_nvm_path`)

**Rule:** a vendor CLI installed only under the product's pinned Node is found today, because the baseline execs it after `nvm use`. The fix must not turn that working setup into a launch failure.

**Failure:** take an owner whose shell PATH has Node 26 without the vendor, whose clone pins Node 20, and whose only `codex` is under Node 20.

- The baseline finds that `codex`.
- Both pins search coord's bin and the pre-`nvm` PATH only. They hit `ERROR: codex was not found …` and return 1.
- Maintenance records `null`, and `start-codex.sh` exits under `set -e`. The pane dies, which is the symptom this issue set out to remove.

**Test:** codex's case `{ id: "claude", label: "pinned", nodeScript: true, pinned: true }` in `test/cli.test.ts` writes the vendor only into the pinned bin. Under muse or cursor it fails. Under codex and claude it passes; claude's line 77 appends the post-`nvm` `$PATH` to the search.

#### 2. `src/cli.ts:178` (muse and cursor): the updater's own children still run on the product Node

**Rule:** issue 240 asks that agent updates use the Node coord requires. That includes `node` or `npm` spawned by name from the vendor's updater or shell wrapper, not only the top-level interpreter.

**Failure:** both pins exec `"${coord_agent_cmd[@]}" update` with PATH still led by `nvm use`'s Node 16.

- Take a vendor wrapper in coord's bin that runs `exec node updater.js "$@"`, or a Node CLI that shells out to `npm i -g`.
- Under these pins the updater runs on Node 16, which is the original "native binary not installed" class of failure.

**Test:** codex's stub line `case "$1" in update|--version) [ "$(node --version)" = v26.1.0 ] || exit 42 ;; esac` fails under muse and cursor. codex and claude export `dirname "$coord_agent_node"` ahead of PATH in the maintenance child only.

#### 3. `test/install.test.ts` (claude, muse, cursor): generated-launcher tests can execute the host's real vendor CLIs

Where:
- claude: `test/install.test.ts:923`, the `stub-bin` "completion mailbox wiring" test; also the GitHub-account launch test and the Muse launch test
- muse and cursor: `:922`

**Rule:** fixture tests must only ever execute fixture executables.

**Failure:** these tests run the real `start-<agent>.sh` with `PATH=stub-bin:$process.env.PATH` and no `COORD_NODE`.

- The launcher now asks `node-runtime.sh` for coord's Node. That is the host's first Node ≥ 26 on the inherited PATH, for example `~/.nvm/versions/node/v26.7.0/bin`.
- The launcher prepends that directory ahead of `stub-bin`.
- On any machine where `codex` or `claude` is npm-installed under that Node, the test execs the real vendor with `--ask-for-approval never --sandbox workspace-write …` instead of the capture stub. It hangs or acts on the host, and the argv assertion fails.

It passes on this host only because `v26.7.0/bin` here holds no vendor CLI (checked).

**Fix:** codex's pin already has it. Symlink a fixture `node` into each stub directory and pass `COORD_NODE` to every launcher execution. A test cannot express "host has a vendor installed", so this is the fix sketch.

#### 4. `scripts/lib/launcher.sh` (claude, muse, cursor): a failed selector silently falls back to the old-Node PATH

Where:
- claude: `scripts/lib/launcher.sh:55`
- muse: `:31–34`
- cursor: `:44–47`

**Rule:** when the clone records `coord.cliEntry`, coord's Node requirement is authoritative. A broken selector must not quietly reintroduce the product-pin resolution this issue fixes.

**Failure:** take a clone with an invalid `COORD_NODE` (for example a Node 25 path) or a moved install.

- The selector fails, and only a warning is printed on stderr.
- Resolution falls back to the owner PATH, which in the reported workspace yields `~/.nvm/versions/node/v16.18.0/bin/claude`.
- So the original failure recurs, with a warning that is easy to miss.

codex returns 1 on selector failure (`coord_agent_node="$("$selector" --resolve)" || return 1`). Its maintenance path also supplies a fallback selector beside the running coordinator when `coord.cliEntry` is unset. Both are documented.

**Test:** in the nvm-setup fixture, set `COORD_NODE` to a fake `v25.0.0` node and assert that the launch exits non-zero without executing any stub. This fails under claude, muse and cursor and passes under codex.

#### 5. Smaller differences, none blocking

- **cursor's shebang check** (`"#!"*node*`) matches any first line containing `node`. codex's anchored regex accepts only `…/node` or `/usr/bin/env node`. claude's and muse's checks sit in between.
- **cursor's `[[ -f "$entry" ]]` guard** skips coord-Node resolution without any warning when `dist/main.js` is unbuilt.
- **`command -v` vs `type -P`:** codex uses `type -P`, which cannot return a shell function or builtin name. The other three use `command -v`.

### Scope, reuse and test focus

- **Scope:** all four stay within the approved map and the issue.
- **Reuse:** all reuse `node-runtime.sh`, the `coord.cliEntry` route, and the existing test fixture.
- **muse and cursor tests:** each extends the existing `it.each` by two ids. Neither covers the fallback or updater-child cases.
- **claude test:** adds four ids and a `GIT_DIR`-based config to avoid branch preparation. It covers the product-Node invariant, but not the fallback, Muse, no-pin, or selector-failure cases.
- **codex tests:** the most thorough, still confined to the one existing test (seven focused rows). It also asserts that the input env object is unchanged, and adds the necessary `COORD_NODE` isolation to the existing launcher tests in `test/install.test.ts`.

## Verdict

Select **codex `613dfd04d651c73b180a1033753e6c974dc45301`**.

- It is the only pin with none of findings 1–4.
- It resolves the vendor beside coord's Node for update, version probe and launch, keeps the product Node for the pane, and falls back to pinned-only installs.
- It gives the updater's children coord's Node, refuses a failed selector instead of regressing, and isolates every launcher-executing test from host vendors.

Ranking of the others:

1. **claude `16dd9d5a4e1242ff63dd36250caf9c24ff564626`** is next. It is correct on findings 1 and 2, but has findings 3 and 4.
2. **muse `2f48a6b3cdc68d2a8c7ac32e84d37b13a24f725d`** and **cursor `76db847bd32cde6a0adb55d5a68792caf23270bb`** each have findings 1–4.

Verification for this comparison:

- **Checks I ran:** read the five product diffs at each pin, and ran `scripts/lib/node-runtime.sh --resolve` on this host to check finding 3's precondition.
- **Not run:** no peer suite. Each pin's hook results and the coordinator's final checks are not claimed here.

# Issue 213 implementation plan

Protocol version: 1. Baseline: `82c47e35ae0a886746fce9759bd80776ec6a5461`.
Issue session: `issue-213:82c47e35ae0a886746fce9759bd80776ec6a5461`.
Automation digest: `e996be3e594119dd01cdbc1cb6b38795e250d3d047ff37a18b71567fa2fb11b3`.

The issue asks for reliable prompt delivery despite Vim preferences, useful timestamps in future terminal captures, an onboarding route to coordinator verification/cache declarations, and a useful default documentation policy. The inspected runtime has one final `pnpm run check`, local precommit/prepush suites, and neither a documentation profile nor a verification block. The repository already implements classification, frozen verification policy, receipts, and shared execution locks; the missing setup should use those facilities.

## Exact File List to be changed or deleted

No deletions. Change only these existing source, test, example, and documentation files:

| File | Change |
| --- | --- |
| `scripts/lib/launcher.sh` | Apply supported editor overrides in generated launchers; render Cursor's private configuration snapshot without changing the owner's original configuration. |
| `src/setupWorkspace.ts` | Update default nudge keys; propose a concrete documentation profile from conventional tracked documentation paths; carry proposed documentation and an explicit local verification default into configuration construction. |
| `src/install.ts` | Forward an onboarding declaration; preserve existing workspace policy when repairing an installation; report the installed verification mode and whether cache declarations exist. |
| `src/cli.ts` | Add `--declare <file>` to onboarding's allowed flags, forwarding, and usage text. Reuse issue-start policy freezing. |
| `src/state.ts` | Allow explicitly empty documentation final checks while retaining nonempty product final/candidate checks; update schema comments for generated defaults. |
| `src/tmux.ts` | Align nudge/reminder keys with effective editor mode; replace raw-only logging with raw output plus a streaming timing sidecar using the same launch/respawn path. |
| `src/paths.ts` | Describe the additional timing sidecar in the existing terminal-log path contract. |
| `config.example.json` | Align the Codex nudge default with the launcher; retain the existing reviewed documentation and coordinator/cache policies as the workspace migration source. |
| `test/install.test.ts` | Extend executed-launcher fixtures and installer policy-preservation cases. |
| `test/onboard.test.ts` | Cover declaration forwarding, real generated defaults, and persistence into a fresh issue snapshot. |
| `test/verify-config.test.ts` | Cover default documentation selection, empty documentation checks, explicit declaration precedence, and unchanged conservative product fallback. |
| `test/tmux.test.ts` | Extend nudge/reminder and isolated tmux capture cases for effective editor settings and timed output. |
| `docs/setup-workspace.md` | Document defaults, `onboard --declare`, receipt prerequisites, and an executable migration recipe for this repository's existing workspace. |
| `docs/coord-driver.md` | Document editor behavior and the raw-log/timing-sidecar contract and its measurement limits. |

Do not change product hooks, the package version, dependencies, the selected plan during implementation, or unrelated analytics/reporting code. The running issue's owner runtime and vendor home configuration are not implementation output files.

## Exact file list to be created

- `.plans/issue-213/plan.md`: this coordinator-requested plan artifact.
- No new tracked product modules, test files, dependencies, or policy-format files. Keep the small terminal recorder command beside `pipeToLog` in `src/tmux.ts`, and the Cursor snapshot preparation beside the existing launcher generation in `scripts/lib/launcher.sh`.

Generated runtime outputs, rather than new tracked source files, are a clone-local `.coord/cursor-config/cli-config.json` and one `run-<stamp>.timing.jsonl` next to each future automated `run-<stamp>.log`. These locations reuse existing ignored clone state and the existing per-agent terminal directory.

## Reuse and Scope

**1. Make generated launchers and delivery agree about editor mode.**

Reuse `launcher_command`, `write_launcher`, `writeAgentLauncher`, `agentOwnerUiDefaults`, `resolveNudgeKeys`, `vimInsertPrelude`, `readCursorVimMode`, `codexVimNormal`, and `typeAndSubmit`. Generated launchers continue to preserve their existing permission flags, mailbox grants, hooks, working directory, and `exec` process behavior. Both initial launch and recovery use those launchers; manually invoked generated launchers receive the same editor defaults.

- Claude: add the invocation-local `--settings '{"editorMode":"normal"}'` override. The installed CLI advertises `--settings`; the vendor documents `editorMode: normal` as disabling Vim. Do not replace user settings, hooks, or the entire configuration source list. See [Claude terminal configuration](https://code.claude.com/docs/en/terminal-config#edit-prompts-with-vim-keybindings).
- Codex: add `-c tui.vim_mode_default=false` alongside the existing config override. Local `codex-cli 0.162.1` supports `-c` and contains this setting; the [official developer command documentation](https://learn.chatgpt.com/docs/developer-commands) describes the corresponding default and session toggle. Describe this accurately as starting the composer in Insert mode; it is not a promise that the operator cannot subsequently toggle Vim. Retain recovery from a positively observed Normal footer.
- Cursor: its documented project configuration supports permissions only, so writing `editor.vimMode` into `.cursor/cli.json` is not the solution. At launcher execution, resolve the original configuration directory using `CURSOR_CONFIG_DIR`, then `XDG_CONFIG_HOME/cursor`, then `~/.cursor`, before setting any override. Copy the existing `cli-config.json` object into `.coord/cursor-config/cli-config.json`, changing only `editor.vimMode` to `false`, and pass that directory through `CURSOR_CONFIG_DIR` to the child. On an absent original file, use the vendor's minimal configuration with version 1 and empty allow/deny lists; do not turn an unreadable or malformed existing file into empty permissions. Preserve all other keys, including model and sandbox choices. Use private directory/file permissions, atomic replacement, and refuse unexpected symlinks. Keep HOME, XDG_CONFIG_HOME, CURSOR_DATA_DIR, authentication, MCP configuration, and hooks at their original locations. The installed Cursor 2026.10.14-0f9edde separates its CLI-config path from these data/auth paths; exercise this contract through a fixture. See [Cursor configuration](https://prod.cursor.com/docs/cli/reference/configuration).
- Antigravity: preserve its working plain input and Enter delivery; no speculative editor flag.

Update newly generated Codex preludes to `[]`. Default Claude delivery must no longer infer Vim merely from a missing INSERT indicator: plain input sends no `a`. For the known mode indicators, Normal uses the appropriate insertion key, Visual first exits selection, and Insert uses none. Cursor's effective setting must include the generated snapshot when present; a valid plain snapshot takes priority over an old default Vim prelude. Without that managed snapshot, retain explicit custom-launcher configuration and the existing config-based fallback, resolving the documented global configuration location rather than pretending project editor settings are authoritative. Use the same resolution for automatic nudges and owner reminders. In particular, an old Codex `['i']` default must not become literal message text when the current footer has no Vim indicator or says Insert; only a positively observed Normal mode needs the insertion key. Retain readiness, authority, owner-typing, copy-mode, and inter-key timing gates.

No edit-and-restore cycle touches the owner's preferences. The Cursor snapshot is refreshed from the original source at each launch; it is disposable managed clone state. Ensure a prior managed directory inherited through the environment is not recursively used as its own source. Configuration preparation failures name the path and stop that launcher before starting a misconfigured harness, without printing configuration contents.

**2. Timestamp terminal output without corrupting the existing raw evidence.**

Reuse `newTerminalLog`, `TerminalLogDir`, `shellQuote`, `launchAgent`, `startSession`, `ensureSession`, and the existing placeholder-before-respawn sequencing. Both fresh automated launches and resumed/replaced panes already pass `agentRuntimePaths(...).terminalLogs`; keep that single recording path. Existing raw logs and `.exit.json` diagnostics remain readable.

Change `pipeToLog` to invoke a small Node recorder with the coordinator's `process.execPath`. Render its source and path arguments with the existing shell quoting and tmux `#` escaping. The recorder consumes stdin as Buffer chunks and appends the exact bytes to the existing `.log`. For each successfully written chunk, append one JSON line to the sibling `.timing.jsonl` with `formatVersion: 1`, an ISO UTC `at`, monotonic `elapsedMs` since recorder start, and the raw file's zero-based byte `offset` and byte `length`. Use a complete-write loop or equivalent Buffer-safe writes; do not wait for newline boundaries, decode/re-encode terminal bytes, or retain an unbounded output buffer. Create files privately, drain through EOF, and report recorder I/O failures rather than emitting successful timing records for unwritten bytes.

This sidecar permits joining received terminal output to journal timestamps while preserving ANSI, carriage returns, partial UTF-8 sequences, and a final unterminated prompt. It measures capture time, not an exact vendor event or token-generation time. Relaunches get distinct raw/timing pairs. Existing live pipes and historical logs cannot acquire missing timestamps retroactively; the new behavior begins with launches after the upgraded coordinator is used. Manual sessions currently omit the logging callback; do not silently start recording them as part of this issue.

**3. Give onboarding an explicit route to reviewed verification and cache policy.**

Reuse `OnboardOptions`, `onboard`, `install`, `readDeclaration`, `workspaceDeclarationSchema`, `ProjectPolicyProposal`, `buildWorkspaceConfig`, `readPreviousConfig`, and `writeWorkspaceConfig`. Add `declarePath` to onboarding and forward `--declare` exactly as install already does, resolving the supplied file relative to the caller's working directory. Parse and validate before making installation changes. Do not accept a full workspace configuration as a declaration: identities and agent roots remain installer-owned.

For policy fields, precedence is explicit declaration, then matching existing workspace policy, then generated proposal. An explicit `documentation` or `verification` object replaces that field as a whole; do not deep-merge command arrays or combine two different check identities. Preserve existing checks, verify lists, critical paths, and related declaration fields when re-onboarding without an override. Only reuse a prior configuration bound to this product/workspace; never import a different product's policy. A malformed existing policy needs an actionable error or an explicit replacement declaration, not silent loss of owner settings. Continue regenerating installation identity/stamps through the existing installer logic.

For a fresh installation with no verification declaration, write the honest explicit default `{ "mode": "local" }`. Existing legacy absence retains local semantics. The existing issue-start path then freezes the selected verification policy and digest for future runs; no change to an already-running `start.json` is permitted. Print a concise setup summary identifying local/coordinator mode, the documentation allowlist, and whether any candidate/final checks declare cache inputs. When there are none, explain that running `pnpm check` does not create a policy or receipt and point to `onboard --declare` and the example.

For this repository, document a complete owner migration: extract only the declaration-schema fields from `config.example.json` into a temporary declaration file, inspect it, and run `coord onboard /path/to/4horsemen --declare /path/to/declaration.json` between issues. The extraction recipe must whitelist `toolchain`, `verify`, `documentation`, `verification`, `workflowCriticalPrefixes`, `workflowCriticalFiles`, `checks`, `branch`, `prPolicy`, `digestPaths`, `contextPaths`, and `pollIntervalMs`, ignoring absent keys. This activates the existing component checks, uncached installation/build, cache declarations, documentation suite, and coordinator candidate gate together without copying the example's fake origin or agent roots. Reinstallation must not erase those choices.

Reuse `runVerification`, `receiptKey`, `dependencyIdentity`, and the shared receipt/lock directories unchanged. Explain that successful coordinator runs create receipts under `<coord-runtime>/verification/receipts`, shared across agents and issues within that workspace only when the origin, input tree, policy, command, toolchain, dependencies, and declared environment agree. There is no arbitrary reuse after a source change and no promotion of a local hook's success into a coordinator receipt. Setup/build commands remain uncached; opaque `check` scripts do not automatically receive a guessed cache declaration. Merely sharing package-manager download storage is different from reusing a verification result.

**4. Generate a useful, bounded documentation exemption.**

Extend the existing installer proposal, not the hook classifier, to enumerate a stable sorted set of exact conventional documentation paths from Git's tracked regular-file entries. Include root `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, and `CODE_OF_CONDUCT.md`, plus prose `.md`, `.rst`, `.txt`, and `.adoc` and static `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, and `.pdf` files under `docs/`. Exclude symlinks, submodules, executable entries, known agent-instruction/skill basenames (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `SKILL.md`), and workflow-critical paths. Do not classify every Markdown file or every file under `docs/` as documentation at verification time. A failed inventory produces no inferred exemption and a diagnostic; no matching documents means no invented profile.

If a Node project has a real `check:docs` script, reuse the detected package manager's argument-vector builder for that script in documentation precommit/prepush and final checks. For the pnpm locked case used here, final docs checks begin with uncached `pnpm install --frozen-lockfile` because coordinator worktrees are fresh. For other managers, require a declared setup sequence before proposing a docs command that depends on installed packages; otherwise use the default documentation exemption and explain how to add the project's docs validator. If there is no docs validator, explicitly generate `verify: { precommit: [], prepush: [] }` and `checks: []` for the exact allowed documentation paths. Relax only `documentationProfileSchema.checks` to permit that deliberate empty list; product `checks`, candidate checks, and missing product `verify` keep their existing rules.

An explicit profile takes precedence. Re-onboarding preserves an existing profile, including a previously generated one; an older installation missing a profile receives the generated default. New documentation paths are admitted by reviewing and supplying an updated declaration, never by a hook widening its allowlist. Mixed changes, either side of a code/document rename, critical paths, executable templates, unknown paths, malformed diffs, and undecodable filenames continue through `classifyChanges`, `selectVerification`, and `selectCandidateVerification` to product checks. The frozen baseline-to-pin gate remains authoritative.

## Tests

Extend existing cases and fixtures rather than duplicating the verification engine's coverage. The new behavioral assertions must fail on the baseline for the specific missing behavior:

1. In `test/install.test.ts`, extend the existing test that executes generated launchers against stub harnesses. Assert actual argv/effective environment for Claude and Codex, Cursor's effective `vimMode: false` with preserved unrelated settings, and byte-for-byte unchanged original config across child success/failure. Include a path with spaces, an explicit config directory, missing versus malformed source, and rejection of symlinked managed targets. Keep the current narrow-grant assertions and `/bin/bash` 3.2 execution. Extend install-twice coverage to prove declared coordinator/cache/docs policy survives repair and explicit replacement wins.
2. In `test/tmux.test.ts`, extend the existing Normal/Insert and reminder matrices with plain mode/no indicator, a stale Codex `i` default, and a Cursor managed snapshot overriding a Vim-enabled global preference. Assert exact sent text and key sequence for both nudge and reminder, including no stray `a`/`i`, and retain positive Normal/Visual recovery and authority/readiness refusal tests.
3. Extend the existing isolated-tmux exit-diagnostics case in `test/tmux.test.ts`: initial launch and two relaunches must each create a separate raw/timing pair, retain startup clears and exit diagnostics, and record valid UTC plus nondecreasing monotonic times. Add a small direct recorder case using the generated command so it also runs without tmux: emit ANSI, carriage returns, split non-ASCII bytes, and a final chunk without newline; verify raw bytes exactly and contiguous sidecar offsets/lengths covering them. Check that partial output is recorded before EOF. Assert boundaries and ordering, not exact wall-clock durations or OS-dependent chunk counts.
4. In `test/verify-config.test.ts`, extend installer proposal and shared classification fixtures with tracked docs, an unknown Markdown file, agent instruction files, executable/symlink entries, and an explicit critical-path collision. Assert a nonempty default allowlist where appropriate, actual `check:docs` argv when supported, empty documentation-check round-trip when no validator exists, and product fallback for mixed/renamed/unknown paths. Assert product final/candidate arrays cannot become empty. Existing receipt-key, corruption, mutation, and concurrency tests remain the cache implementation oracle.
5. In `test/onboard.test.ts`, extend the existing happy-path and numeric-dispatch fixtures: `onboard --declare` accepts a valid coordinator/cache/docs declaration, rejects invalid input before installing, remains idempotent, and a subsequent fresh issue freezes the exact policy and digest. Verify no writes to the tracked product tree. Onboarding a plain fixture without a declaration produces the stated docs/local defaults and a truthful no-cache setup message. Resume of an existing issue must retain its original frozen policy.

Focused implementation commands, taken from the repository's current Vitest partition and package scripts:

```sh
pnpm exec vitest run --config vitest.config.ts test/tmux.test.ts test/verify-config.test.ts test/verificationRunner.test.ts
pnpm exec vitest run --config vitest.system.config.ts test/install.test.ts test/onboard.test.ts
bash -n scripts/lib/launcher.sh
pnpm check:docs
```

The installer fixtures already use `ensureBuilt` to rebuild stale `dist` before exercising installed CLI code. Do not bypass hooks to run fixtures or publish changes. For product submission under this issue's currently frozen local mode, the hooks own `pnpm run check:fast` and `pnpm run test:e2e`; do not manually duplicate their suites immediately before committing/pushing. The coordinator's final configured command is `pnpm run check`, which includes build, lint/typecheck, fast/system tests, and e2e. If a later action explicitly provides coordinator-owned verification, cite its recorded results and follow that action instead. Report only checks actually run.

For this plan-only action, validate headings, nonempty bodies, exact file map, referenced existing paths and commands, and bound identifiers. No product suite is required or claimed for publication of the plan.

## Alternatives Rejected

- Blind `i`/`a` before every prompt, or toggling `/vim` before delivery: those actions can insert literal text or invert an already-correct setting. Use launch defaults and mode-aware keys.
- Editing and later restoring global vendor configuration: simultaneous sessions and crashes make restoration unsafe. Use invocation overrides and Cursor's private snapshot.
- Treating project-local Cursor editor settings as effective: the vendor explicitly limits that configuration layer to permissions.
- Prefixing every raw log line with a timestamp or using a shell `read` loop: terminal output has arbitrary chunks, escape sequences, carriage returns, and prompts without newlines. Preserve raw bytes and index captured chunks in a sidecar.
- Inventing cacheability from one successful `pnpm check`, globally enabling a guessed candidate matrix, or running setup inside that command: these cannot establish all inputs or preserve the project's intended coverage. Onboarding accepts and persists reviewed declarations and states its defaults explicitly.
- Maintaining another copy of the receipt engine or a separate repository policy file: the existing schemas, example, selectors, runner, receipts, and install declaration already supply those contracts.
- A blanket `*.md` exemption or dummy `true` verification command: use an exact setup-time allowlist and an explicitly empty documentation-only command list where no validator exists.

## Risks and Mitigations

- Vendor options change. Bind the implementation to verified local CLI behavior and cited vendor settings; execute generated scripts against stubs and exercise actual mode resolution. Do not claim a real vendor smoke test unless one was run. Cursor global config redirection must not redirect auth/data/hooks, and malformed settings must remain visible failures.
- Stale launcher/default combinations can corrupt prompts. Update canonical launch generation, default examples, effective-mode resolution, and both delivery routes together; retain observed Normal-mode recovery. Existing custom launchers retain a documented fallback.
- Logging can lose timing on a crash or full disk. Write raw bytes before their timing record, report errors, permit an incomplete final JSONL record to be recognized as incomplete, and never treat a sidecar as lifecycle acknowledgement. Historical logs stay untimestamped evidence.
- Conventional docs can affect a particular product's build. Keep the list concrete and reviewable, honor explicit critical paths/profile overrides, and retain product fallback for unknown/mixed inputs. Refreshing setup does not mutate an active issue's frozen policy.
- Reinstall can erase curated policy or mix incompatible command names. Preserve only policy from the matching existing workspace, replace explicitly declared objects atomically, validate the combined result before effects, and test install-twice behavior. No broad runtime migration is performed by an agent product commit.
- Cache reuse can be overstated. Keep explicit inputs and existing receipt validation unchanged; document that policy/source/toolchain/dependency changes miss the cache and that setup/build are not cached. The current issue remains governed by its frozen local checks until completion.

## Conclusion

Implement the missing setup and capture behavior around existing coordination primitives. Generated launchers start with usable input defaults, delivery sends the intended text, new automated terminal captures preserve raw output with timestamp indexes, onboarding persists explicit verification/cache declarations, and conventional documentation receives a useful bounded default exemption. The existing verification engine remains the authority for reusable success, and the documented workspace migration activates this repository's already-reviewed policy only for subsequent issues.

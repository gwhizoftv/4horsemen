# Issue 210 plan — where coord tailors itself to each agent CLI, and how to add one

Baseline: `cb7ed092cb8a5d15f651387651df7c631e4596e6`. All `path:line` references
below and in the deliverable are taken at that commit.

Issue 210 asks for an analysis, not a behaviour change: enumerate every place
coord tailors command-line options, configuration data or JSON to a specific
LLM agent CLI; analyse adding Meta's Muse CLI; and decide whether to keep adding
vendors the current way or adopt a cleaner design. If a cleaner design is
recommended, enumerate each file and line that would have to change. The
deliverable is therefore one Markdown document. No product code, tests,
configuration or hooks change in this issue.

## Exact File List to be changed or deleted

None. No existing tracked file is modified or deleted. In particular,
`src/**`, `scripts/**`, `githooks/**`, `templates/**`, `test/**`,
`config*.example.json`, `README.md` and `docs/repo-map.md` stay untouched.

## Exact file list to be created

- `docs/issue-210-agent-cli-analysis.md` — the requested analysis. Its fixed
  outline:
  1. **Scope and method**: the baseline SHA; the search used, which is quoted
     vendor literals (`"claude" | "codex" | "cursor" | "antigravity" | "agy" |
     "gemini"`), vendor-prefixed identifiers (`Claude*`, `codex*`, `Cursor*`,
     `Antigravity*`), vendor home paths (`.claude`, `.codex`, `.cursor`,
     `.gemini`) and `switch (agent)` / `agent.id ===` branches across `src/`,
     `scripts/`, `githooks/`, `templates/`, config examples and docs; and the
     known false positive (`cursors` / `CursorsState` is coordinator state, not
     the Cursor vendor).
  2. **Inventory**: one table per integration seam (listed below). Each row
     gives `path:line`, what is tailored (CLI flag, config file, JSON shape,
     process name, key sequence, telemetry format), the vendors it covers, and
     whether it is *data* (a per-vendor constant) or *behaviour* (vendor-specific
     parsing or logic).
  3. **Adding Muse**: per seam, what Muse needs. Each item is marked either
     *verified*, with the command and output it rests on, or *open*, with the
     question the implementer of a Muse integration must answer before writing
     code.
  4. **Recommendation**: the design call, with the evidence for it, and the
     file-and-line change list it implies.
  5. **Checklist**: the ordered steps for adding a vendor under the
     recommendation, and under the status quo for comparison.

Inventory seams, with anchors I have already confirmed at the baseline (the
deliverable completes and re-verifies every row):

| Seam | Anchors (baseline) | Kind |
|---|---|---|
| Vendor identity and supported-vendor lists | `src/agentEvent.ts:17`; `src/agentHookSync.ts:13-14`; `src/agentTrust.ts:54`; `src/cli.ts:135-137`, `:306-307`, `:1151`; `src/install.ts:873`; `src/resourceEvidence.ts:41`; `src/transcriptRead.ts:12-13`; `src/doctor.ts:365-366`; `scripts/setup_common.sh:15-16`, `:118` | data, duplicated ~12× |
| Defaults derived from agent id | `src/setupWorkspace.ts:29-38` (harness process), `:53-67` (nudge keys, Terminal profile), `:108-114` (labels); `config.example.json`; `config.product.example.json` | data |
| Launch command and flags | `scripts/lib/launcher.sh:30-32` (PATH), `:46-99` (`launcher_command`); `start-<agent>.sh` generated from it; `scripts/setup_<vendor>.sh` vendor parameters | data (shell) |
| Version/update at fresh start | `src/cli.ts:135-180` (`<exe> update`, `<exe> --version`) | data + assumption that every CLI has an `update` subcommand |
| Lifecycle/shell-guard hook install and removal | `src/agentHookSync.ts:16-30` (settings path per vendor), `:105-117` (event names), `:119-205` (document shapes), `:230-290` (removal), `:296-380` (status, Antigravity status line) | behaviour |
| Hook payload and response JSON | `src/agentEvent.ts:60-230`; `src/shellGuard.ts:30-45`; `src/cli.ts:1258-1305` | behaviour |
| Folder trust | `src/agentTrust.ts:54-130` (TOML, `.claude.json`, Cursor marker files, Antigravity `settings.json`) | behaviour |
| AGENTS.md loading | `src/agentsProtocol.ts:182-215` (Claude `CLAUDE.md` shim); per-vendor setup scripts | behaviour |
| Ignored vendor directories | `src/productIgnore.ts:40-46`; `templates/product/gitignore.coordination.block:4-9` | data |
| tmux readiness and nudging | `src/tmux.ts:49-60` (process aliases), `:62-75` (reason union), `:220-260` (prompt readiness), `:269-275`, `:291-325` (vim/editor mode), `:330-370` (`resolveNudgeKeys`), `:430-440` (mouse, scrollbars); `src/runLoop.ts:925-927`, `:1447-1458` | behaviour |
| Usage, transcripts, quota and failure telemetry | `src/transcriptRead.ts`; `src/cursorHookUsage.ts`; `src/codexQuota.ts`; `src/claudeStatusLine.ts`; `src/resourceEvidence.ts`; `src/agentLifecycle.ts:102-183`, `:430-475`; `src/analytics.ts:508-515`; `src/runLoop.ts:1101-1103`, `:1462-1500`; `src/cli.ts:1541-1542`; `src/state.ts:251-318`; `src/paths.ts:477-480`; `src/doctor.ts:391-405`; `src/install.ts:476-481`, `:520-521`, `:677`, `:707` | behaviour, optional per vendor |
| Tests and docs that enumerate vendors | e.g. `test/runLoop.test.ts`, `test/tmux.test.ts`, `test/agentHookSync.test.ts`, `test/agentEvent.test.ts`; `README.md`, `docs/setup-workspace.md`, `docs/coord-driver.md` | fixtures/prose |

Muse facts already verified locally (`muse --version` → `Muse Code 1.4.7
(1.4.7-R6101.1)`; `muse --help`; `muse export --help`), to be restated in the
deliverable with those commands:

- No `update` subcommand. `muse [OPTIONS] [PROMPT]` treats a bare word as a
  prompt, so adding `["muse","muse"]` to `agentExecutables` (`src/cli.ts:135-137`)
  would make the fresh-start maintenance step run `muse update`. That *starts a
  session* with the prompt "update" under a 180 s timeout instead of updating.
  The wrapper self-updates in the background (`MUSE_UPDATE_INTERVAL_SECONDS`,
  default 3600). The integration therefore needs a per-vendor "no update
  command" entry. It must also decide whether the launcher pins
  `MUSE_UPDATE_INTERVAL_SECONDS` so a pane never self-updates mid-issue; Codex
  already follows that rule (`scripts/lib/launcher.sh:59`).
- No `--add-dir`. The launcher's documented invariant that every vendor accepts
  `--add-dir` (`scripts/lib/launcher.sh:40-45`) does not hold. `--workspace
  <PATH>` ("Register policy-gated workspace tools rooted at PATH") is the
  candidate equivalent, and whether it grants writes is open.
- Unattended mode exists as `--approval-mode never` / `--disable-approval`,
  with sandbox controls `--disable-sandbox` and `--sandbox-network`. Trust can
  be granted per run (`--trust-workspace`, not persisted), which may replace an
  `agentTrust.ts` writer.
- Durable per-session logs exist (`session.jsonl` in a local session store,
  exportable as JSON), so a transcript reader is feasible. The store path is
  open.
- `muse` is a bash wrapper that execs a downloaded binary, so the tmux
  foreground process name (`harnessProcess`) is open and must be measured in a
  pane.
- Open: whether Muse runs hook commands (lifecycle and pre-shell) and in what
  JSON shape; whether it loads `AGENTS.md` natively; its composer and
  idle-prompt chrome; and its submit keys. Without hooks, Muse can run only
  with `delivery: "pull"` (see `src/doctor.ts:359-366`), and the shell Git
  guard falls back to the `.coord/bin/git` shim.

## Reuse and Scope

- Reuse: the inventory reuses existing code as evidence and changes none of
  it. Where the vendor list is already centralised, the deliverable points to
  that source rather than restating it: `lifecycleVendorSchema`
  (`src/agentEvent.ts:17`), `launcher_command` (`scripts/lib/launcher.sh`, which
  its header names as the single source of vendor flags), and
  `agentOwnerUiDefaults` (`src/setupWorkspace.ts`). For document format and the
  baseline-pinned citation style it follows the existing
  `docs/issue-209-efficiency-analysis.md`.
- Recommendation the deliverable will argue: keep vendor *behaviour* in the
  per-vendor modules where it lives today. Hook document shapes, transcript
  parsers, quota readers and pane heuristics are genuinely different per
  vendor, and a plugin or adapter interface would only relocate that code.
  Replace the duplicated vendor *identity data* with one exhaustive table:
  - one `Vendor` union;
  - one `vendors` record holding the executable, update argv or none, harness
    process and aliases, label, Terminal profile, nudge defaults, hook-settings
    path and ignored directories;
  - per-vendor switches converted to `Record<Vendor, …>` or exhaustive
    `switch` statements, so adding `"muse"` to the union makes `tsc` list
    every site still missing it.
  The deliverable also evaluates an optional `vendor` field on agent config,
  defaulting to `id`. It would decouple the vendor from the agent id, which
  today forbids two agents of one vendor (for example two Muse model profiles).
  The deliverable enumerates the exact `path:line` edits for this design and
  states its cost against the status quo. The criterion: recommend it only if
  it removes more duplicated sites than it adds new lines. Otherwise the
  deliverable says to continue as is and gives the status-quo checklist.
- Scope limits: no refactor, Muse integration, launcher change or test change
  is made in this issue. Those are follow-up issues that the deliverable
  names. No GitHub comment is posted; the issue asks for documentation, and
  the document is the artifact.
- New file justification: the issue requires a written analysis. A dedicated
  `docs/` file matches the precedent `docs/issue-209-efficiency-analysis.md`
  and keeps a long, line-cited inventory out of `README.md` and
  `docs/repo-map.md`.

## Tests

No product test is added. The change is documentation only, and no existing
behaviour changes, so no test could fail before the change and pass after it.
Validation of the deliverable:

1. **Citation check** (run by the implementer; the script is not committed).
   For every `path:line` or `path:start-end` cited in
   `docs/issue-210-agent-cli-analysis.md`, read that range from the baseline
   checkout. Assert that it contains the identifier or literal the row names
   (for example `src/cli.ts:136` contains `["cursor", "agent"]`). Any miss
   fails the deliverable.
2. **Completeness check**: rerun the search from section 1 of the deliverable
   and confirm that every hit outside `test/` and `docs/` is either an
   inventory row or listed as a known false positive.
3. **Muse claims**: every *verified* Muse statement cites the exact local
   command whose output supports it (`muse --version`, `muse --help`,
   `muse export --help`). Anything else is labelled *open*.
4. **Hooks**: `docs/issue-210-agent-cli-analysis.md` is not on the declared
   documentation allowlist, so the commit hooks classify it as unknown and run
   the product `verify.precommit` (`pnpm check:fast`). The implementer reports
   that hook result and does not run the suite by hand. Coordinator-owned final
   checks (`pnpm run check`) are not claimed.

## Alternatives Rejected

- **Implement the refactor or Muse support in this issue.** The issue asks to
  assess first. Bundling code would turn an analysis into an unreviewed
  multi-subsystem change, and Muse's hook and process facts are still open.
- **Full vendor-adapter/plugin interface** (one class per vendor implementing
  launch, hooks, trust, readiness and telemetry). The deliverable presents and
  rejects it. Every behaviour seam already lives in a vendor-specific function,
  so an interface adds indirection and a registration layer without removing
  any vendor logic. Optional seams (quota, status line, transcripts) would also
  become empty stubs.
- **Generate shell vendor tables from TypeScript** (`launcher.sh`,
  `setup_common.sh`). The launcher is deliberately the single shell source and
  is rendered by both `coord install` and `githooks/post-merge`. A generator
  would add a build step to a hook path. The deliverable lists the shell sites
  as manual steps instead.
- **Put the analysis in `README.md` or `docs/repo-map.md`.** Too long and
  line-pinned for living docs; the line numbers go stale with every commit.
  Precedent puts issue analyses in their own `docs/issue-<n>-*.md`.
- **Post the analysis as a GitHub issue comment as well.** Not requested, and
  it would be a second copy to keep consistent.

## Risks and Mitigations

- **Line numbers drift after merge.** Mitigation: every citation is pinned to
  baseline `cb7ed09`, stated once at the top of the deliverable, and the
  deliverable carries its own search command so the inventory can be
  regenerated.
- **Missed site.** A vendor branch written without a vendor literal (for
  example `agent.id === config.id` inside per-vendor files) could escape the
  search. Mitigation: the completeness check also walks every file whose name
  is vendor-specific and every `switch` on agent id, and the method section
  states the search's limits.
- **Unverified Muse claims presented as fact.** Mitigation: the
  verified/open labelling and command citations in Tests item 3. Muse's hook
  support, process name and session-store path stay *open* rather than
  guessed. Local probing beyond `--help`/`--version` was not performed:
  launching a session or reading Muse's config and credential directories is
  out of scope.
- **Recommendation biased toward a refactor.** Mitigation: the cost criterion
  (duplicated sites removed versus lines added) is stated in advance, and the
  status-quo checklist is always included, so the owner can choose either.
- **Doc-only commit runs product hooks.** The new path is not allowlisted.
  Mitigation: expected and harmless, because no product code changes. The
  result is reported as the hook's, not claimed as a manual run.

## Conclusion

Create one file, `docs/issue-210-agent-cli-analysis.md`, and change nothing
else. It inventories, by baseline `path:line`, every seam where coord tailors
CLI flags, configuration files, JSON shapes, process names, key sequences and
telemetry per agent CLI. It maps each seam to Muse Code 1.4.7, keeping verified
facts and open questions separate. The facts already verified show real
breakages in a naive addition: `muse update` would start a session, and Muse
has no `--add-dir`. The deliverable recommends a single exhaustive vendor table
for identity data, while keeping per-vendor behaviour where it is, and gives the
exact edit list for that design next to the status-quo checklist. Validation is
a mechanical citation and completeness check against the baseline plus the
commit hooks' own result; no product tests are added because no behaviour
changes.

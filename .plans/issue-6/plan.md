# Issue 6 implementation plan — Codex

## Scope and baseline

Implement [issue #6](https://github.com/gwhizoftv/coordination/issues/6),
“Simplify coordination bootstrap and onboard (`coord N` from GitHub issues),”
from `origin/main` at `f9d0084`. The intended owner flow becomes:

```sh
curl -fsSL https://raw.githubusercontent.com/gwhizoftv/coordination/main/scripts/bootstrap.sh | sh
coord onboard /path/to/app
gh issue create --title "..." --body "..."
coord 42
```

This is a control-plane and installation change, not a workflow-protocol
rewrite. The existing R1–R7 agent evidence remains branch-published and
origin-verified. In particular, `.plans/issue-N/plan.md` remains the normal R2
artifact created by each agent on `issue-N/<agent>`; it stops being an
owner-authored prerequisite under the runtime.

The governing safety rule remains unchanged: coordination may configure the
owner's local clone, agent clones, and the external runtime, but a default
onboard must not add tracked files or coordination hooks to the product clone.
A separately cloned human product checkout inherits no coordination state and
keeps its normal Git workflow.

## Binding design decisions

### 1. Bootstrap installs one complete Git checkout

`scripts/bootstrap.sh` will be POSIX-`sh` compatible because the documented
pipe invokes `sh` directly. It installs a complete checkout at
`${COORD_INSTALL_ROOT:-$HOME/.local/share/coordination}`, runs the locked pnpm
install and build, and installs a launcher at `$HOME/.local/bin/coord` unless
`--no-path` is supplied.

The launcher will be a managed symlink to `<install-root>/coord`, rather than a
second copy of CLI startup logic. The repository wrapper already changes to its
own checkout, keeps build output off protocol stdout, and invokes the built
entry point. Bootstrap must refuse to overwrite an unrelated file at the
launcher path.

For an absent install root, bootstrap clones the official repository. For an
existing checkout, it verifies that the directory is a Git worktree, refuses
any tracked or untracked dirt, fetches `origin`, and performs only a fast-forward
to `origin/main`. It never resets, cleans, force-checks-out, or deletes local
work. Node/pnpm preflight produces one concise installation hint before the
build. `--root` takes precedence over `COORD_INSTALL_ROOT`; an explicit
repository URL environment override is retained for forks and hermetic tests.

When bootstrap itself created the checkout, it records versioned ownership
metadata under that checkout's `.git/` directory. This keeps `git status`
clean, distinguishes a bootstrap-owned install from a developer checkout, and
lets the existing coordination install stamp represent `bootstrapped` /
`ownsInstallRoot` truthfully. Re-running bootstrap against a pre-existing
developer checkout does not claim ownership merely because it built it.

### 2. A workspace location is a first-class value

Introduce one resolver used by install, onboard, start, doctor, and uninstall:

```ts
type WorkspaceLocation = {
  coordRoot: string;       // operator's outer runtime directory
  workspaceRoot: string;   // config and run-state root for this product
  configPath: string;
  layout: "flat" | "nested";
};
```

Resolution checks `<coord-root>/config.json` first and accepts it only when its
parsed `project` matches the requested product. It then checks the compatible
`<coord-root>/workspaces/<project>/config.json` location. A fresh, unoccupied
runtime selects the flat location. If another flat product or existing nested
workspaces already occupy the outer runtime, a newly installed second product
uses its nested workspace without moving the first product.

Run state follows `workspaceRoot`: flat products use
`<coord-root>/issue-N` and `<coord-root>/mirror.git`; nested products use the
same paths under `workspaces/<project>/`. This removes cross-product issue and
mirror collisions while avoiding a destructive automatic migration. Existing
nested configs remain discoverable. An existing explicit old run can still be
operated by its recorded/explicit runtime root; new starts use the resolved
workspace root.

All selection is deterministic and symlink/containment checked. If both a
matching flat and matching nested config exist, flat wins, as required, and the
choice is surfaced in command output rather than guessed independently by each
command.

### 3. `onboard` is a preset over the existing installer

`coord onboard <product>` does not implement a second wiring engine. It
normalizes the product root, fills these defaults, and calls the existing
`install(...)` primitive:

- coord root: `<parent-of-product>/coord-runtime`;
- clone root: the product parent;
- agents: `claude,codex,cursor,antigravity`;
- profile: `consensus`;
- install root: the checkout containing the running built CLI;
- no product writes, vendoring, or coordination bootstrap.

The simple command may override `--coord-root`, `--clone-root`, `--agents`, and
`--profile`. Policy declarations, product writes, vendoring, origin/base
overrides, and dry-run stay on advanced `coord install`; onboard should remain
a small happy-path surface rather than acquire every install flag.

After install, onboard records exactly one owner-only locator in the product
clone's local Git config: the absolute workspace `config.json` path. This is
untracked, is not copied to other humans, is not one of the keys that marks an
agent clone, and is sufficient to derive the run-state root as
`dirname(configPath)`. There is no global product registry and no tracked
pointer file. Re-onboard repairs the locator; uninstall removes it when it
belongs to the workspace being removed.

Finally onboard runs the existing doctor API against the resolved workspace,
prints the full report, and returns doctor's non-zero class-specific exit code
on any finding. The installed files remain available for repair rather than
being partially rolled back after a diagnostic failure.

### 4. Profile and extra digest inputs live in config

Persist `profile` in `config.json`, defaulting to `consensus` for old/manual
configs and recording the actual install/onboard selection for new configs.
`coord start` may still override it explicitly, but `coord N` and
`coord start N --product <path>` need no repeated profile flag.

Keep `digestPaths` as a backward-compatible list of *additional* trusted,
config-relative digest inputs, but make its default `[]` and allow an explicit
empty list. It is no longer the mechanism that states what the issue is about.
Installer-generated configs therefore never synthesize
`.plans/issue-{issue}/plan.md`. An operator who deliberately declares other
immutable inputs can still hash them. Re-onboarding/reinstalling migrates the
installer's former generated default to the new empty default; explicitly
declared paths remain authoritative.

### 5. GitHub issue snapshots replace the owner plan input

Before creating runtime state or launching tmux, start derives `owner/repo`
from the configured GitHub origin and executes an argv-safe command equivalent
to:

```sh
gh issue view 42 --repo owner/repo --json number,title,body,url
```

The response is schema-validated, including the requested issue number, and
canonicalized to stable JSON containing repository, number, title, body, and
URL. Volatile fetch timestamps are excluded. Failure to derive a GitHub
repository, find the issue, or read it with the current `gh` authentication
fails before tmux/runtime effects and names both remedies: create issue N first
and repair `gh auth` access.

The automation digest remains the existing length-prefixed SHA-256 scheme, but
its mandatory sources become:

1. the exact workspace `config.json` bytes;
2. the canonical GitHub issue snapshot bytes;
3. zero or more explicitly declared `digestPaths`.

After preflight, the snapshot is atomically materialized as
`<workspace-root>/issue-N/github-issue.json` before `start.json` is committed.
The snapshot hash is included in `automationDigestSources`. This gives restart
and audit a stable copy even if the GitHub issue is edited later; an active run
never silently rebinds to new issue text. Startup cleanup removes the snapshot
with the otherwise incomplete issue runtime on failure.

### 6. Numeric invocation composes start and run

Extract the current `start` branch into a testable `startIssue(...)` operation
that owns all common resolution, preflight, launch, snapshot, and durable-state
logic. Both public entry points call it:

- `coord start N ...` calls `startIssue` and returns after the initial tick;
- `coord N ...` calls the same `startIssue`, then invokes the normal long-lived
  run loop for that issue.

Do not implement the shorthand by spawning `coord start` and `coord run`, and
do not copy the start branch. Direct composition preserves injected tests,
error cleanup, and one state transition.

For start-like commands, resolution is:

1. an explicit `--config` plus `--coord-root` pair remains fully supported;
2. otherwise `--product <path>` reads the onboard locator;
3. otherwise the current Git worktree is used as the candidate product and its
   locator is read;
4. absent/stale/ambiguous state fails with `coord onboard <product>` and
   `--product` remediation.

`--product` therefore disambiguates calls made outside the product. No global
search is added. The existing explicit forms of `run`, owner controls, and
agent `next` remain available; the daily happy path no longer exposes those
details because `coord N` starts and runs in one process.

## Exact file map

### New production files

1. **`scripts/bootstrap.sh`** — POSIX argument parsing; tool preflight; clone or
   clean fast-forward update; bootstrap ownership metadata; locked install and
   build; managed `~/.local/bin/coord` symlink; idempotent output and actionable
   refusals.
2. **`src/workspace.ts`** — `WorkspaceLocation`, flat-first installed-workspace
   resolution, fresh-layout selection, config/project validation, and the
   owner product-local locator read/write/clear helpers. This is the only module
   allowed to decide flat versus nested layout.
3. **`src/githubIssue.ts`** — GitHub origin normalization, strict `gh issue
   view` parsing, canonical issue snapshot rendering, fetch failure
   remediation, and the snapshot type. It accepts an injected argv runner and
   never invokes a shell.

### Modified production files

1. **`src/cli.ts`** — add `onboard`; recognize a positive integer as the
   one-shot command; allow `--product` workspace discovery; centralize
   start-argument resolution; extract/reuse `startIssue`; fetch and persist the
   issue snapshot; make explicit profile optional when config supplies it; and
   update help/error text. `automationDigestMaterial` will accept canonical
   issue bytes and optional supplemental paths instead of assuming an owner
   plan.
2. **`src/state.ts`** — add a defaulted workflow `profile` to coordinator
   config; change `digestPaths` to a default-empty unique confined array; keep
   old configs parseable; and preserve the current immutable start-state digest
   schema/version unless the stored shape itself changes.
3. **`src/paths.ts`** — add the confined `github-issue.json` runtime path and
   ensure runtime paths are always based on resolved `workspaceRoot`.
4. **`src/setupWorkspace.ts`** — stop owning workspace path policy; build
   configs against a supplied `WorkspaceLocation`; persist profile and an empty
   default supplemental digest list; and write config directly to the chosen
   flat or nested root.
5. **`src/install.ts`** — select/reuse a workspace through `src/workspace.ts`;
   pass its root through clone/config generation; read bootstrap ownership
   metadata for the install stamp; update next-step output to prefer
   `coord onboard` / `coord N`; make uninstall resolve both layouts and clear
   the owner locator; and scope wipe to the selected workspace. Move all wipe
   refusals into preflight before clone wiring is changed.
6. **`src/doctor.ts`** — resolve flat before nested, diagnose unsupported
   GitHub issue origins for every start policy, accept empty supplemental
   digest inputs, and report the exact resolved config. Doctor remains offline
   with respect to issue content; it checks configuration/tool availability but
   does not fetch an arbitrary issue.
7. **`src/runLoop.ts`** — import/re-export the shared GitHub origin parser
   instead of maintaining a second parser; PR publication behavior otherwise
   stays unchanged.
8. **`src/gitExec.ts`** — only if needed, add a narrowly named helper for the
   owner-local locator/checkout root. Existing hermetic local config helpers
   remain the implementation boundary; do not introduce shell Git calls.
9. **`README.md`** — put bootstrap → onboard → GitHub issue → `coord N` first;
   move source-checkout development and advanced `coord install` later; state
   explicitly that agents author plans and product status stays empty.
10. **`docs/setup-workspace.md`** — document bootstrap ownership, onboard
    defaults, the flat happy path, compatible nested multi-product layout,
    local locator, advanced install flags, doctor/uninstall resolution, and
    zero product-master footprint. Delete the owner-plan pre-start instruction.
11. **`docs/coord-driver.md`** — update runtime topology, digest sources,
    GitHub issue snapshot/replay semantics, `coord N`, and the advanced explicit
    start/run forms.
12. **`config.example.json`** — add `profile`, use `digestPaths: []`, and explain
    that issue title/body are mandatory digest input.
13. **`config.product.example.json`** — mirror the new profile/digest defaults
    while retaining the explicit verify/check declaration example.

The existing **`coord`**, hook bodies, hook shim, launcher scripts, protocol,
evidence predicates, state machine, and finalization policy need no semantic
change. The bootstrap-created PATH entry targets `coord`; duplicating or
templating another wrapper is intentionally avoided.

### New tests

1. **`test/bootstrap.test.ts`** — run the shell script against temporary local
   Git origins and fake Node/pnpm executables. Cover first clone/build, managed
   launcher creation, `--root` and environment precedence, `--no-path`, clean
   idempotent rerun, clean fast-forward, dirty refusal without HEAD movement,
   foreign launcher refusal, missing-tool hint, and ownership metadata that is
   written only for a checkout bootstrap created.
2. **`test/workspace.test.ts`** — table-test fresh flat selection, flat-first
   resolution, old nested compatibility, mismatched flat project fallback,
   second-product nesting, ambiguous flat precedence, stale locator errors,
   and path/symlink confinement.
3. **`test/githubIssue.test.ts`** — cover supported HTTPS/SSH origins,
   canonical rendering and hash stability, title/body changes, empty bodies,
   malformed/mismatched responses, missing `gh`/auth/issue remediation, and
   argv construction without a shell.

### Existing tests updated

1. **`test/cli.test.ts`** — remove owner-plan fixture dependence; inject issue
   snapshots; assert config + issue + optional-input digest binding; assert the
   snapshot is materialized before durable start; prove an unreadable issue
   leaves no runtime or tmux effect; exercise `start --product`; and prove
   `coord N` calls one shared start followed by the run loop.
2. **`test/install.test.ts`** — update expected config paths; assert fresh flat
   config/run roots; test a second product's nested workspace; verify re-install
   reuses either layout; verify local locator cleanup and bootstrap ownership;
   and retain the product `git status --porcelain === ""` plus fresh-human-clone
   cases.
3. **`test/doctor.test.ts`** — run health/drift cases through both layouts,
   account for mandatory GitHub repository compatibility, and verify reports
   name the actual resolved config.
4. **`test/support/workspaceFixture.ts`** — expose flat/nested fixture helpers,
   supported fake GitHub origins where start compatibility is under test, and
   deterministic issue snapshots/runners without network access.
5. **`test/wrapper.test.ts`** — retain stdout isolation and, if the symlink
   assertion is not wholly contained in the bootstrap suite, verify a PATH
   launcher reaches the selected install root.
6. **`test/integration.test.ts`** — keep the four-agent local-origin workflow
   canary unchanged at the protocol layer; add only the resolved runtime path
   adjustments needed for the new workspace abstraction. GitHub fetching is a
   CLI start preflight and is tested with injected fixtures, not live network.
7. Any path assertions in **`test/hookSync.test.ts`** or
   **`test/verify-config.test.ts`** will be updated only where config defaults or
   the resolved config location changed. Their hook security contracts remain
   unchanged.

## Requirement-to-change coverage

| Issue requirement | Planned coverage |
| --- | --- |
| R1 bootstrap | POSIX bootstrap, complete checkout/build, managed PATH symlink, clean-only fast-forward, metadata, hermetic shell tests |
| R2 onboard | preset over `install`, four defaults, product-local locator, doctor exit propagation, empty tracked status tests |
| R3 flat layout | single flat-first resolver, nested compatibility, per-workspace run state, second-product nesting, doctor/uninstall/start tests |
| R4 `coord N` | product/cwd resolution, shared `startIssue`, start then run in one process, explicit options retained |
| R5 issue digest | validated `gh` snapshot, config + title/body binding, atomic persisted snapshot, no owner plan prerequisite, failure cleanup |
| R6 agent plans | no protocol change; docs explicitly place plan authoring on `issue-N/<agent>` after launch |
| R7 docs/help | README happy path, both guides, examples, installer output, and CLI help rewritten together |
| R8 acceptance | bootstrap, onboard, shorthand/digest, human clone, and old nested layout regressions plus full existing suite |

## Implementation sequence

1. Add `WorkspaceLocation` and its tests; migrate install/doctor/uninstall to it
   before changing CLI behavior. Confirm old nested installs still resolve.
2. Add profile/default digest schema changes and make installer-generated fresh
   configs flat. Keep direct manual config parsing backward compatible.
3. Implement and test bootstrap independently, including ownership metadata;
   then consume that metadata in the install stamp.
4. Add owner locator helpers and the `onboard` preset, with doctor invocation
   and product-status assertions.
5. Add the GitHub issue module, canonical snapshot, runtime path, and digest
   integration. Prove all issue failures happen before launch/state effects.
6. Extract `startIssue`, add product resolution, and compose the numeric
   start-plus-run entry. Re-run recovery/error-path tests after the extraction.
7. Rewrite help, README, guides, config examples, and installer next steps in
   the same commit as the public behavior so no documented owner-plan ceremony
   remains.
8. Run `pnpm check:fast`, then `pnpm check` (including the four-agent canary)
   before offering implementation for review.

## Additional simplifications and explicit non-goals

### Simplifications included

- One workspace resolver replaces hard-coded `workspaces/<project>` joins and
  prevents install/start/doctor/uninstall layout drift.
- One start operation serves both `start` and numeric invocation; there is no
  subprocess choreography or duplicate startup transaction.
- Onboard reuses install and doctor; it is defaults plus composition, not a new
  installer or diagnostic implementation.
- One product-local config key replaces a global registry, stamp file in the
  tracked product, or repeated sibling-path inference.
- A canonical issue JSON file replaces a new database and is both the replay
  artifact and digest input.
- `digestPaths` remains a small optional compatibility escape hatch rather than
  adding a second `issueSource` configuration language.
- A managed symlink reuses the tested repository wrapper rather than emitting a
  second wrapper implementation from bootstrap.
- A second product nests without relocating the first; no automatic migration
  transaction or cross-workspace mirror sharing is required.

### Deliberately not in scope

- Creating or editing the GitHub issue on the owner's behalf.
- Fetching issue comments, labels, attachments, or later edits into an active
  run; only the start-time title/body snapshot binds the session.
- Replacing `gh` with a new OAuth/token client or adding non-GitHub issue
  providers in this issue.
- npm/Homebrew packaging, daemon/service installation, or automatic PATH file
  edits beyond installing `$HOME/.local/bin/coord` and printing a PATH hint.
- Moving existing runtime directories automatically. Compatibility is resolve
  and reuse, not a destructive migration.
- Adding coordination hooks, config, verify commands, or ignored tracked files
  to the product's default clone.
- Changing branch evidence schemas, consensus selection, finalization, or PR
  merge authority.

## Acceptance gate

Implementation is ready for peer review when:

1. a clean temporary machine fixture can bootstrap twice, fast-forward once,
   and refuses a dirty install without rewriting it;
2. `coord onboard <product>` with no flags creates four wired agent clones,
   `<parent>/coord-runtime/config.json`, a healthy doctor result, an owner-local
   locator, and an empty product Git status;
3. a normal fresh human clone of the same origin has no coordination hook or
   local locator;
4. `coord N` started from the onboarded product fetches issue N, persists the
   snapshot, binds config/title/body into `start.json`, launches once, and enters
   the run loop without any owner `.plans/issue-N/plan.md`;
5. missing/private/unreadable issue fixtures fail before runtime/tmux effects
   with create/auth remediation;
6. an existing `workspaces/<project>/config.json` install remains usable by
   start, doctor, and uninstall, while a second product has isolated run state;
7. agents are still ordered to publish their own R2 plan artifacts on their
   issue branches; and
8. `pnpm check` passes with no weakening of hook, evidence, or finalization
   regressions.

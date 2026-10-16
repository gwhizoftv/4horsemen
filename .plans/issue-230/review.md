# Issue 230 plan review (claude)

Reviewed pins:

- cursor `74b712c5873c2690c173141417ba94964c724ccf`
- claude `cea4ff7cc5c6c872484eb8ad4ea71dc5022e8da3`
- codex `b279ae5629cacf1d49f3ada2db30044f261f940c`

Each was read from the bound input files.

I checked these facts for this review against the baseline checkout and the
installed CLI (only `--help` and `--version` were run):

- `MUSE_NO_AUTO_UPDATE=1 muse --version` now reports **Muse Code 1.4.10
  (1.4.10-R6427.1)**. `muse --help` still has no `update` subcommand and no
  `--add-dir`. It lists `--workspace <PATH>` as "Register policy-gated
  workspace tools rooted at PATH", plus `--approval-mode`,
  `--disable-sandbox` and `--trust-workspace`.
- `src/runLoop.ts:1043` sends owner reminders through `TmuxController.remind`
  without checking `delivery`. `src/tmux.ts` `remind` calls
  `resolveNudgeKeys(agent, paneText)` directly, so a `pull` agent still
  receives resolved prelude and submit keys.
- `vimInsertPrelude` (`src/tmux.ts:269–275`) returns `["a"]` for any ID other
  than `antigravity` and `codex` when the pane does not show INSERT.
  `resolveNudgeKeys` reaches it whenever the configured prelude is empty.
- The Terminal profile is applied inside an AppleScript `try`
  (`src/tmux.ts:529–536`), so an unknown profile name is harmless. I raise no
  finding on profile names.

## Findings

### F1 — cursor plan, `scripts/lib/launcher.sh` / `write_launcher`: Muse keeps its sandbox and gets `--workspace` grants

- **Plan claim.** Launch Muse with `--approval-mode never --trust-workspace`
  plus the coord grants, rendered as `--workspace <root>` for each of the four
  resolved roots. The sandbox is left on.
- **Rule.** Every Git-mode action in this workflow ends with the agent
  committing and pushing in its own clone, then writing the SHA to its
  mailbox. A launch policy that is sold as installed support has to allow
  writes to `.git`.
- **Concrete failure.** Meta's permissions reference says that inside the
  writable workspace, `.git`, `.muse` and `.agents` stay read-only. Help
  describes `--workspace` as registering *policy-gated tools rooted at PATH*,
  not as an additive writable root, and gives no sign that it can be repeated
  additively. Implemented as written:
  - The first action, `participation-ready`, already needs `git add`,
    `git commit` and `git push`. The commit fails because `.git/index` cannot
    be written.
  - The Muse participant never publishes, and the issue waits on it.
  - The planned `test/install.test.ts` case only asserts the argv shape
    (`--workspace` instead of `--add-dir`). It passes while the participant
    cannot work.
  - The plan also changes the shared `write_launcher` grant rendering for all
    vendors. That puts the four existing launchers at risk for a flag whose
    meaning is unproven.

  The plan's own risk section says "if live Muse still cannot commit/push,
  stop and use a plan-amendment-request". That concedes the selected design
  is not known to work.
- **Smallest correction.** Leave `write_launcher`'s grant rendering unchanged.
  Launch Muse unsandboxed (`--disable-sandbox`) and do not pass `coord_grant`,
  as the claude plan does. This is the posture `antigravity` already ships,
  and the cursor case's own comment says narrow grants are decoration for an
  unsandboxed harness. A sandboxed alternative should come back only with a
  measured Muse run that commits through it.

### F2 — cursor plan, `src/setupWorkspace.ts` `agentOwnerUiDefaults` and Risks: explicit `[]` / `["Enter"]` defaults do not stop the stray `a`

- **Plan claim.** Give Muse an empty prelude and `["Enter"]` so it does not
  inherit the fallback. The plan also says pull delivery means nothing nudges
  Muse, and it leaves `src/tmux.ts` out of scope.
- **Rule.** Configured Muse keys must survive key resolution on every send
  path. Issue 210 lists `src/tmux.ts:341` (`vimInsertPrelude` for an empty
  prelude) as a required source-edit site, because config alone cannot
  override it.
- **Concrete failure.** The owner-reminder path (`src/runLoop.ts:1043` →
  `remind` → `resolveNudgeKeys`) is reachable for pull agents. With
  `nudgePrelude: []`, `resolveNudgeKeys` calls
  `vimInsertPrelude(paneText, "muse")`, which returns `["a"]`. An owner
  reminder to an idle Muse pane therefore types a stray `a` before the action
  text. Muse has no vim mode, so the `a` lands in the prompt. Pull delivery is
  the one mode where owner reminders are the normal way to hand Muse an
  action, so this path matters most here. No planned test covers it.
- **Smallest correction.**
  - Add `muse` to the `vimInsertPrelude` exclusion list.
  - In `test/tmux.test.ts:265`, assert that
    `resolveNudgeKeys({ id: "muse", … }, "> ")` equals
    `{ prelude: [], submit: ["Enter"] }`.

  With the new `["Enter"]` default, the stale-bare-Enter repair already
  resolves to Enter, so `src/tmux.ts:362` needs no edit.

### F3 — cursor plan, `launcher_environment`: Muse's install directory is not added to PATH

- **Plan claim.** `launcher_environment` only exports `MUSE_NO_AUTO_UPDATE=1`
  for Muse.
- **Rule.** The launcher and the fresh-start maintenance probe (`src/cli.ts`
  `updateAgentVersions`, which runs through `launcher_environment`) must
  resolve the vendor binary the same way. `launcher_environment` already
  prepends `$HOME/.local/bin` for `antigravity`, because a login shell does
  not always include that directory.
- **Concrete failure.** Meta's installer puts the `muse` wrapper in
  `~/.local/bin`; the local install is `~/.local/bin/muse`. On a machine whose
  tmux shell lacks that directory:
  - `coord start` warns `muse --version: … not found` and records `null`;
  - `start-muse.sh` exits on `exec muse` with "command not found";
  - the pane dies before any action.

  This is the same failure `antigravity`'s PATH branch was added for.
- **Smallest correction.** Change the existing branch to `antigravity|muse`.
  Run the launcher test with a stub in `$HOME/.local/bin` and without that
  directory on PATH.

### F4 — codex plan, "Implementation order" step 1 and Tests: the plan cannot be completed as specified

- **Plan claim.** Step 1 is the release blocker: prove a narrow grant/Git
  policy, live payloads and actual refusal in a disposable workspace before
  anything else. Later steps need "measured" pane fixtures, hook payloads and
  process names. The plan rejects `--disable-sandbox`, `--yolo` and broad
  grants. It also states "There is currently no demonstrated narrow grant/Git
  policy".
- **Rule.** An approved plan must be mechanically complete. Following it has
  to produce a submittable implementation within the approved file map, and
  its tests have to rest on evidence the implementer can actually get. The
  plan's own Tests section forbids fabricated fixtures ("Missing live evidence
  is a blocker, not a passing result").
- **Concrete failure.** Help and documentation offer no narrow writable-`.git`
  policy, and the plan forbids the only documented ways to get one. No
  implementer can satisfy step 1 within this plan. The planned tests in
  `test/tmux.test.ts`, `test/agentEvent.test.ts` and `test/shellGuard.test.ts`
  require "measured Muse pane fixtures" and "real Muse-shaped command
  payloads" that do not exist in the repository or in issue 210. Issue 210
  says the hooks reference shows runs on 1.3.0, not the installed 1.4.10.
  Followed as written, the implementer has two options:
  - invent fixtures, which breaks the plan's own rule; or
  - escalate with no product change.

  Either way the issue ends without Muse in the config, which is the one
  outcome the issue asked for.
- **Smallest correction.** Narrow the plan to issue 210's "minimum installed
  mode" (its step 2: R rows plus a deliberate pull capability) with a launch
  policy that can commit today. Track step 3 (hooks, event and guard
  envelopes, measured tmux readiness) as the follow-up issue that issue 210
  already sequences after live measurement.

### F5 — codex plan, `src/install.ts` / `src/cli.ts` default rosters and `test/onboard.test.ts`: Muse is added to the default install and onboard roster

- **Plan claim.** "Add Muse last to new default rosters".
- **Rule.** A default roster may only name agents that a typical owner
  workspace can launch. Issue 210 classifies the roster change as "an
  optional product choice, not required for `--agents muse`".
- **Concrete failure.** After this change, `coord onboard <repo>` or
  `coord install` without `--agents` on a machine without Muse (or without a
  Meta login):
  - creates a `<product>-muse` clone and `start-muse.sh`;
  - `coord start` records `muse: null` and opens a pane whose launcher exits
    on `exec muse`;
  - the coordinator still publishes `participation-ready` to `muse`, so every
    new issue waits on a participant that cannot start until the owner drops
    it.

  Existing owners re-running onboard without `--agents` get a behaviour change
  they did not ask for.
- **Smallest correction.** Keep the defaults unchanged. Support Muse through
  explicit `--agents …,muse` and an opt-in entry in `config.example.json`.

### F6 — codex plan, Exact File List: scope beyond the issue

- **Plan claim.** 29 tracked paths, including `src/runLoop.ts`,
  `src/doctor.ts`, `config.product.example.json`, `docs/coord-driver.md`,
  `docs/readiness-policy.md`, `docs/analytics.md` and five more test files.
- **Rule.** AGENTS.md implementation discipline asks for the smallest change
  that fully solves the issue, with every changed path justified by it.
- **Concrete failure.** The map would be reviewed and approved for edits
  whose content the plan says depends on evidence that does not yet exist.
  Examples: "measured process aliases", "Muse refusal reasons", "Document Muse
  lifecycle delivery". Reviewers cannot evaluate a test or diff that has not
  been specified. Any implementation is then either a speculative edit of
  approved paths or a plan amendment. This is not separable from F4, but it
  stands as its own scope problem even if a live session were available.
- **Smallest correction.** As in F4.

### F7 — claude plan (self-review), "Scope decision" facts: stale version pin

- **Plan claim.** Its observed facts are from Muse Code **1.4.9
  (1.4.9-R6297.1)**.
- **Rule.** Version evidence in an approved plan must match the build the
  implementer and the owner's live acceptance will use.
- **Concrete failure.** The installed wrapper has since moved to **1.4.10
  (1.4.10-R6427.1)**. An implementer quoting 1.4.9 in launcher comments or
  docs would be recording the wrong build. The flags the plan relies on
  (`--approval-mode`, `--disable-sandbox`, `--trust-workspace`, no
  `--add-dir`, no `update`) are unchanged in 1.4.10's help, so the design
  itself is not affected.
- **Smallest correction.** The implementer cites 1.4.10, or no specific build,
  in comments and `docs/setup-workspace.md`. Version-specific claims stay out
  of tracked docs except as "observed with".

### F8 — claude plan (self-review), "Risks": unsandboxed launch is a deliberate policy choice reviewers must accept explicitly

- **Plan claim.** `--disable-sandbox --approval-mode never` is justified
  because the sandbox makes `.git` read-only, and antigravity already runs
  unsandboxed.
- **Rule.** Widening an agent's filesystem reach must be explicit, documented,
  and paired with whatever containment still applies.
- **Concrete failure.** None of the planned stub tests can detect it if
  Muse's shell tool clears `COORD_ISSUE` or `PATH`. In that case the git shim
  never refuses anything for Muse, and containment coverage is lower than
  antigravity's, which also has a native shell hook. The plan already lists
  this as a risk and as an owner live-acceptance item. The join-action
  containment probe will record the real result as `executed` instead of
  `shim-refused`.
- **Correction.** Not a blocker. Implementation must keep the launcher comment
  and the `docs/setup-workspace.md` paragraph explicit that Muse has shim-only,
  unverified containment until the follow-up hook work lands.

### Scope, reuse and tests across plans

- **cursor.** Scope is right: R rows plus pull, opt-in example, no new files.
  `KNOWN_AGENT_LABELS: muse` is redundant, because `agentLabel`'s fallback
  already yields `Muse`; this is harmless. The tests reuse the right files, but
  they assert the wrong launch contract (F1) and miss the key-resolution test
  (F2).
- **claude.** Same scope, 10 existing files plus 3 existing test files, no new
  files. Each of its three tests fails on the baseline for a distinct reason:
  - the unknown-vendor update skip;
  - install refusing `muse`;
  - the `a` / `Escape, Enter` key trace.

  F7 and F8 are documentation and acceptance points, not design defects.
- **codex.** The reuse analysis is careful and its risk list is the most
  thorough. However, its file map and tests extend past the issue and depend
  on unavailable evidence (F4–F6).

## Conclusion

- **claude plan** (`cea4ff7c`): acceptable as the basis, with the
  non-blocking documentation corrections in F7 and F8.
- **cursor plan** (`74b712c5`): needs revision. Its sandboxed `--workspace`
  launch cannot commit (F1). It leaves the stray `a` on Muse owner reminders
  (F2). It omits Muse's `~/.local/bin` PATH entry (F3).
- **codex plan** (`b279ae56`): not implementable within this issue as
  written. Its gating step has no available solution and its tests need
  fixtures that do not exist (F4). It changes default rosters against issue
  210's guidance (F5). Its scope goes well beyond the issue (F6).

The recommended selection is the claude plan. The cursor plan converges on it
once F1–F3 are applied. Codex's hook, guard and tmux work is a good outline
for the follow-up unattended-delivery issue.

Checks run for this review:

- reading the three bound plans;
- reading baseline sources at the cited lines (`src/runLoop.ts`,
  `src/tmux.ts`, `scripts/lib/launcher.sh`);
- `muse --help` and `MUSE_NO_AUTO_UPDATE=1 muse --version`.

No product tests were run, and none are required for this artifact.

# Issue 210 implementation comparison — Claude

Bound implementation pins compared:

- cursor `86dd06eb7761e863dd2e69825f80ea9082f917bb`
- claude `755a65d93d46a7feae802065d4dbde39626d7d02` (my own; reviewed by the same rules)
- codex `68694071858bcc44a57738a8fad0ae401933e930`

Each pin was read from its exported worktree. All three change exactly the two
approved product paths, `README.md` (one Documentation-table row) and
`docs/issue-210-agent-cli-analysis.md`, plus their own coordination artifacts.
None changes runtime code, tests, configuration or hooks; none adds a
dependency or an unapproved file. All three record the baseline, give
commit-pinned links, separate Muse evidence tiers, and avoid machine-specific
absolute paths.

Evidence gathered for this comparison:

- **Hook environment.** I re-fetched Meta's hooks guide
  (`https://meta-models.github.io/muse-code-sdk/1.4/guides/extend/hooks/`).
  Settings-level hooks run in a cleared environment. Only `HOME`, `PATH`,
  `USER`, `LOGNAME`, `TMPDIR`/`TEMP`/`TMP`, `SHELL`, `LANG`, `LC_ALL` and
  `TERM` pass through, plus `MUSE_SESSION_ID` and `MUSE_THREAD_ID`.
  `managed_hooks_env_vars` "never applies to user or project hooks".
- **Shell guard source.** I read `src/shellGuard.ts:279-283` at the baseline.
- **Docs landing page.** I re-fetched
  `https://meta-models.github.io/muse-code-sdk/1.4/`. It shows generating
  commit `633e270c4b4c2e680c215786759c5cf6ba47513d` and fingerprint
  `sha256:e8b3d24f…a7fa1`.
- **Coverage counts.** I ran a `grep` over the three documents for the key
  findings.
- **Unknown-id behaviour.** The values behind finding 2 come from my
  implementation run (a baseline build calling `resolveNudgeKeys`,
  `harnessLooksReady` and `harnessPromptReadiness`).

I ran no product suite for this comparison. The pre-commit and pre-push
results for each pin are the hooks' and the coordinator's, not mine.

## Comparison

### Finding 1 — claude and cursor: Muse hooks run in a cleared environment, so the shell guard always allows

**Locations.**
- claude: `docs/issue-210-agent-cli-analysis.md:240`, "Hooks need almost no
  new code", and `:275` (row B5: the guard needs no change if the command key
  is `command`).
- cursor: `docs/issue-210-agent-cli-analysis.md:248` treats the deny shape as
  the only hook gap, and its change map row at `:277` says the same.

**Rule.** A Muse change map must name every baseline site that breaks under
Muse's documented hook contract. That contract includes the hook process
environment.

**Failure.** `guardShellRequest` returns the vendor's allow response unless
`env.COORD_ISSUE` is a positive integer (`src/shellGuard.ts:283`). Muse
withholds every variable outside its allowlist from project and user hooks.
The installed `git-guard` hook therefore never sees `COORD_ISSUE`, and it
allows `git status` and `git diff` in every Muse clone.

The doctor will still report the hooks as `current`. Coverage would appear
installed while enforcement is silently absent. An implementer following
either document's Tier B or "reliable automated participation" rows would
ship that.

Codex's pin documents the mismatch correctly
(`docs/issue-210-agent-cli-analysis.md:214`, `:219-225`).

**Smallest correction.** Add the cleared environment as a documented Muse
fact. Add a change-map row for `src/agentHookSync.ts:48-52` (render the issue
binding into the command, or resolve it from the clone) and
`src/shellGuard.ts:283`. Add a live-probe acceptance item: the guard must
refuse `git status` with only Muse's allowlisted environment. A test can
express this:

```ts
// test/shellGuard.test.ts
it("refuses under Muse's cleared hook environment", () => {
  const response = guardShellRequest({ vendor, clone, raw: musePreToolUse("git status"),
    env: { HOME, PATH, MUSE_SESSION_ID: "s" } });
  expect(response).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
});
```

### Finding 2 — cursor and codex: the unknown-id nudge defaults cannot be fixed by configuration

**Locations.**
- codex: `docs/issue-210-agent-cli-analysis.md:134` ("stale nudge-key repairs …
  fallback can prepend an unwanted 'a' and use inappropriate submit keys") and
  `:215`. It treats keys as a measurement question.
- cursor: `docs/issue-210-agent-cli-analysis.md:252` lists submit keys as
  *Open*, and `:82-85` traces unsupported ids without the nudge path.

**Rule.** The inventory must identify sites where an operator setting cannot
correct vendor behaviour. Those sites need a source edit even for a
launch-only or trial vendor.

**Failure.** For an unknown id, `resolveNudgeKeys` reaches the vim fallback
(`src/tmux.ts:341-344`) even when `nudgePrelude: []` is configured. It also
replaces a configured `nudgeSubmit: ["Enter"]` with `Escape, Enter`
(`src/tmux.ts:362-367`).

Reproduced at the baseline, both configurations return
`{"prelude":["a"],"submit":["Escape","Enter"]}`.

Muse's interactive page documents that `Esc` interrupts the current turn and
that `Enter` during a turn steers text into it. An owner who reads either
document and tries "configure `nudgeSubmit: ["Enter"]` while trialling Muse"
still gets an `a` typed into every prompt and an Escape that can cancel work.

The claude pin documents this, with the reproduced values
(`docs/issue-210-agent-cli-analysis.md` §3.2, step 3, and row A5).

**Smallest correction.** Name `src/tmux.ts:341-344` and `:362-367` as
required edits, and cite the documented Enter and Esc semantics. Test home:
`test/tmux.test.ts`, next to "honors explicit empty prelude over Codex
defaults". Assert that an unknown id with `nudgePrelude: []` and
`nudgeSubmit: ["Enter"]` resolves to `{ prelude: [], submit: ["Enter"] }`.

### Finding 3 — codex: docs provenance does not match the cited page

**Location.** `docs/issue-210-agent-cli-analysis.md:199` gives generator
commit `40c7658b12790fedfe6f206beaecb6d43423577b` and schema fingerprint
`c533a6c3…0a3` for `https://meta-models.github.io/muse-code-sdk/1.4/`.

**Rule.** Recorded provenance must be reproducible from the cited source, or
labelled as a snapshot that has since changed.

**Failure.** The page currently shows commit
`633e270c4b4c2e680c215786759c5cf6ba47513d` and fingerprint
`sha256:e8b3d24f…a7fa1`. This is the value the claude pin records, and the
same value I fetched about an hour apart. The page documents that a Muse
server reports this fingerprint in `initialize`, precisely so readers can
match docs to a host. A reader comparing the report's fingerprint against a
live `muse serve` would get a false mismatch and distrust the report's
contract notes.

**Smallest correction.** Re-record the commit and fingerprint with the access
time, or mark the old value as a superseded snapshot.

### Finding 4 — cursor: documented facts labelled open, and completeness not actually checked

**Locations.** `docs/issue-210-agent-cli-analysis.md`:
- `:253` labels native `AGENTS.md` loading *Open*;
- `:252` labels submit keys *Open*;
- `:245` attributes `MUSE_UPDATE_INTERVAL_SECONDS` to "vendor docs/community
  notes";
- `:400` says the searches were "re-ran … mentally".

**Rule.** The selected plan requires every Muse claim to rest on primary
sources or local observation. Facts in those sources must not be left open,
and the inventory searches must actually be rerun.

**Failure.**
- **AGENTS.md loading.** Meta's configuration page documents the discovery
  order (`AGENTS.md` first), and that project rules load only in a trusted
  workspace. Leaving this open invites an unnecessary `CLAUDE.md`-style shim
  at `src/agentsProtocol.ts:182`. Worse, it hides that an untrusted Muse clone
  never sees the coordination protocol.
- **Update control.** The update variable comes from the local launcher
  script, not from vendor documentation. The script's actual off switch,
  `MUSE_NO_AUTO_UPDATE`, is missing from the document.
- **Completeness.** A completeness claim with no executed search cannot be
  rechecked. Approximate anchors (`~:322+`, `~:1171–:1268` at `:156` and
  `:168`) cannot be verified mechanically either.

**Smallest correction.**
- Cite the configuration and interactive pages for those rows.
- Name the launcher script and `MUSE_NO_AUTO_UPDATE`.
- Replace the approximate anchors with exact ranges.
- Run and record the searches from §Method.

### Finding 5 — claude: hook-environment omission also weakens the follow-up probe

**Location.** `docs/issue-210-agent-cli-analysis.md:231` records only that
hooks receive `MUSE_SESSION_ID`. The live-probe step at `:362-368` does not
test guard refusal under Muse's environment.

**Rule.** As in Finding 1.

**Failure.** Follow-up step 4's acceptance criterion ("containment probe
reports `hook-denied`") would be the first place the defect surfaces. That
comes after Tier B code has already been written against the wrong
assumption.

**Smallest correction.** Fold into Finding 1: add the environment fact to
§4.2 and add a guard-refusal check to §7 step 2.

### Scope, reuse and coverage

- **Scope.** All three stay within the issue and the approved map. None adds
  tests; that is correct for a behaviour-neutral documentation change. Codex
  and claude each report a `pnpm check:docs` run (29 passed); cursor reports
  one too.
- **Reuse.** All three point future work at existing test homes. Codex is the
  most precise, with line-level test anchors such as `test/cli.test.ts:221`,
  `test/tmux.test.ts:1260` and `test/shellGuard.test.ts:107`.

**Unique correct content per pin:**
- **codex.**
  - the cleared hook environment;
  - `buildWorkspaceConfig` defaulting every agent to `delivery: "both"`
    (`src/setupWorkspace.ts:356`), so a launch-only Muse would claim nudge
    delivery;
  - the Antigravity setup's hard-coded model (`scripts/setup_antigravity.sh:117`);
  - the exact launch-flag table.
- **claude.**
  - reproduced unknown-id behaviour (vim `a`, the forced Escape, busy pane
    "ready");
  - the configuration override in Finding 2;
  - the versioned `muse-bin-<version>` foreground process, which never
    matches `harnessProcess: "muse"`;
  - documented `Enter`-steers and `Esc`-interrupts semantics;
  - `MUSE_NO_AUTO_UPDATE` / `MUSE_SYNC_UPDATE` from the launcher script;
  - mechanical verification of all 154 citations.
- **cursor.** Nothing material beyond the other two.

**Recommendation sections.**
- **codex:** keep the boundaries, and add a nullable-updater maintenance
  record in `src/cli.ts`.
- **cursor:** add a registry when Muse is implemented.
- **claude:** make dispatch exhaustive behind a registry, done first.

All three are defensible. Codex's no-registry-now conclusion is the most
conservative and best matches the issue's "keep scope small" instruction. It
is also argued from a file count rather than an incommensurable
sites-versus-lines measure, and it still flags the Antigravity fall-through
(`:122`) so the hazard is not lost.

**Overall.** **codex** is the strongest implementation: it is the most
complete and the only one free of the Finding 1 defect. It needs Finding 3,
and should absorb Finding 2's evidence from the claude pin.

**claude** has the most reproduced evidence on terminal delivery. However, its
central "hooks need almost no new code" conclusion is wrong because of the
cleared environment (Findings 1 and 5).

**cursor** is the least complete (Findings 1, 2 and 4).

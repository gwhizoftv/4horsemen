# Issue 230 plan review

Reviewed bound plans:

- cursor `74b712c5873c2690c173141417ba94964c724ccf`
- claude `cea4ff7cc5c6c872484eb8ad4ea71dc5022e8da3`
- codex `b279ae5629cacf1d49f3ada2db30044f261f940c`

Issue #230 asks to add Muse to normal config using the issue-210 Muse task
list. That document’s **Bounded follow-up** step 2 is minimum installed mode
(R rows + deliberate pull). Step 3 (A-row unattended delivery) must not be
advertised until live contracts are measured. No plan invents a new tracked
product module; reuse judgments below concern whether file maps and tests stay
inside that issue.

## Findings

1. **cursor Exact File List / `write_launcher` — render Muse grants as
   `--workspace` while keeping the sandbox.** Meta’s permissions docs (cited by
   claude/codex and issue 210) keep `.git` read-only inside the writable
   workspace; help shows no `--add-dir`. Rule: a “normal config” Muse
   participant must still stage/commit/push and write its mailbox for Git-mode
   and pull-mode receipts. Failure if followed as written: install succeeds and
   the example looks supported, but a sandboxed Muse cannot publish Git artifacts
   or reliably complete the workflow the config claims to enable; `--workspace`
   is not shown to lift the `.git` protection. Smallest correction: adopt a
   launch line that permits Git writes with an explicit rationale (claude’s
   `--approval-mode never --disable-sandbox --trust-workspace`, omitting fake
   `--add-dir` grants), or refuse to ship the example until a narrow grant/Git
   policy is proved—do not treat additive `--workspace` alone as sufficient.

2. **cursor Exact File List / Reuse — omit `src/tmux.ts` while setting
   `nudgePrelude: []`.** Issue 210’s unknown-vendor key trace and current
   `resolveNudgeKeys` (`src/tmux.ts` ~341–344) send an empty configured prelude
   through `vimInsertPrelude`, which still returns `["a"]` for any id other
   than `antigravity`/`codex`. Rule: empty config prelude must not insert vim
   `a` for Muse; config overrides alone cannot repair that path. Failure:
   `coord remind` (and any other caller of `resolveNudgeKeys`) types a stray
   `a` into a Muse pane even with pull delivery and `nudgePrelude: []`.
   Smallest correction: add `muse` to the `vimInsertPrelude` exclusion list and
   assert it in `test/tmux.test.ts` (as claude plans)—a small, justified edit
   even while deferring full A-row readiness.

3. **cursor `launcher_environment` — Muse-only `MUSE_NO_AUTO_UPDATE` without
   `~/.local/bin` on PATH.** Claude’s local observation (and the existing
   antigravity comment in `launcher.sh`) places the Muse installer binary under
   `~/.local/bin`, which non-login shells often lack. Rule: generated
   `start-muse.sh` and fresh-start maintenance must resolve the same `muse`
   binary the owner installed. Failure: launch/`--version` fail with “command
   not found” on common PATH setups even though Muse is installed. Smallest
   correction: extend the existing antigravity PATH branch to `antigravity|muse`
   (claude), then set `MUSE_NO_AUTO_UPDATE=1`.

4. **codex Scope / Conclusion / file map — full A-row unattended Muse plus
   default roster as this issue.** Codex targets hooks, shell-guard, measured
   tmux delivery, runLoop/doctor messaging, default install/onboard roster,
   both example configs, and `delivery: both` after gates—issue-210 step 3 and
   optional O rows. Rule: #230 + issue-210 step 2 require minimum installed /
   normal-config support with deliberate pull, without advertising unattended
   delivery before measured contracts. Failure: implementing the map as written
   expands far past “add muse to the config,” forces Muse onto every default
   install, and risks shipping guessed lifecycle/terminal mappings issue 210
   says not to advertise. Smallest correction: cut the product map to R-row
   launcher/maintenance/ignores/example (+ the vim-prelude fix above); keep
   A-row files and default-roster edits out of this issue.

5. **codex Implementation order §1 / launcher change — “proved Muse grant
   policy” while forbidding sandbox bypass and `--yolo`, with no proved argv.**
   Rule: a mechanically complete plan must name an implementable launch/grant
   contract, or escalate incompatibility before claiming normal-config support.
   Failure: the implementer is told to render only a proved policy and not to
   disable the sandbox, yet the plan admits no narrow grant/Git policy exists;
   there is then no legal `launcher_command` case that both commits and stays
   sandboxed, so the rest of the large map cannot complete. Smallest
   correction: either record a measured launch/grant line that permits the
   required writes (and lock it in `test/install.test.ts`), or stop at an
   explicit non-support / escalation outcome—do not gate a dozen A-row files on
   an empty proof.

6. **claude Alternatives / launcher — `--disable-sandbox` as the Git-write
   posture.** Rule: issue 210 rejects broad permission shortcuts that expose
   coordinator-owned state; grants must stay narrow. Failure mode if
   mis-read: an implementer could treat “unsandboxed” as permission to pass
   whole-runtime `--add-dir`/`--workspace` roots or to skip the git shim.
   Claude’s plan already omits `coord_grant` and documents antigravity-like
   posture; keep that constraint in the selected plan’s launcher comments and
   tests (exact argv, no grant flags, shim PATH still prepended). No further
   file-map expansion required if those tests stay as written.

## Conclusion

Prefer **claude `cea4ff7cc5c6c872484eb8ad4ea71dc5022e8da3`** as the closest
fit: R-row + pull delivery, nullable/skipped updater, `.muse/` ignore
alignment, opt-in example config, focused tests, no new product files, plus the
necessary Git-write launch posture, `~/.local/bin` PATH, and `vimInsertPrelude`
fix that cursor omits.

**cursor `74b712c5…`** is rightly scoped to minimum installed mode and good
reuse, but as written it under-specifies a working participant: `--workspace`
grants do not solve read-only `.git`, and skipping `tmux`/PATH leaves remind and
launch brittle.

**codex `b279ae56…`** correctly refuses to pretend `--workspace` or pull alone
fixes Git, and correctly demands live proof—but its product map overshoots the
issue into full unattended integration and default-roster membership, and its
grant section is not yet an implementable argv contract.

Select claude’s plan; fold in cursor’s explicit “do not change default install
rosters” stance (already in claude’s Alternatives) and keep A-row / registry /
quota work deferred.

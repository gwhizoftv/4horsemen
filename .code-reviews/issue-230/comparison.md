# Issue 230 implementation comparison

Compared bound product pins (implementation-ready commits):

- claude `cc767a47d481ff24b9bee4a2109872eed4bf73de`
- cursor `af7bc76b9a43ce64873560670bafe03da9cd75e5`
- codex `bf0763a60d36f1d322d1f8bb36ee819742b7784f`

All three implement the selected Claude plan’s minimum installed Muse mode:
`muse` launcher with `--approval-mode never --disable-sandbox --trust-workspace`
and no `coord_grant`, `MUSE_NO_AUTO_UPDATE=1` plus `~/.local/bin` on PATH,
nullable/skipped updater with `muse --version`, `delivery: "pull"`, Muse UI
defaults, `vimInsertPrelude` exclusion, `.muse/` in the three ignore lists,
`config.example.json` entry, and README/setup docs. No pin adds
`src/vendors.ts`, `scripts/setup_muse.sh`, default-roster changes, or A-row
hooks. `config.example.json` and `src/productIgnore.ts` bytes match across
pins.

## Comparison

1. **cursor `src/tmux.ts:264` (JSDoc) vs `:270` (code).** The rule: the
   `vimInsertPrelude` contract comment must name every id that skips the
   stray-`a` path, matching the guard. Failure if followed as written:
   maintainers reading only the comment can drop `muse` from the condition and
   reintroduce the issue-210 remind corruption (`prelude: ["a"]`) while
   believing Antigravity is the sole non-vim case. Claude’s pin keeps “Antigravity
   and Muse have no vim mode” at the same site; codex’s comment also covers
   Muse. Smallest check: keep the existing
   `expect(vimInsertPrelude("> ", "muse")).toEqual([])` (already present in
   cursor `test/tmux.test.ts:281`) and restore Muse in the JSDoc.

2. **cursor `test/install.test.ts:1254` ambient PATH vs codex
   `test/install.test.ts:1235` (`PATH: "/usr/bin:/bin"`).** The rule: the Muse
   launcher install test must fail if `launcher_environment` stops putting
   `$HOME/.local/bin` first, not pass by accidentally resolving a host `muse`.
   Failure: with ambient `PATH` still containing a real Muse install, a
   regression that omits the PATH prepend can still execute and satisfy argv
   asserts. Codex also pins the shim via
   `command -v git` → `<clone>/.coord/bin/git` and a spaced `HOME`
   (`test/install.test.ts:1216–1241`). Illustrative correction: set
   `PATH: "/usr/bin:/bin"` (and assert shim/`MUSE_NO_AUTO_UPDATE`) as codex does;
   claude’s capture of `MUSE_NO_AUTO_UPDATE=1` in argv (`:1259–1260`) is already
   stronger than cursor’s separate `.env` file alone.

3. **Shared launch posture (all three), e.g. claude
   `scripts/lib/launcher.sh:99`, cursor `:106`, codex `:99`.** The rule from
   the selected plan: Muse must be able to Git-publish, so the documented
   sandbox that keeps `.git` read-only cannot remain enabled. Failure mode to
   keep visible: `--disable-sandbox` lets Muse write anywhere the owner can,
   not only the mailbox—peer/runtime isolation is not filesystem-enforced.
   Codex’s `docs/setup-workspace.md` states that limitation most plainly;
   claude’s `### Muse Code` section is the clearest structured owner note;
   cursor’s shorter paragraph is accurate but thinner on shim/containment.
   No pin claims live Muse publication proof; that remains owner acceptance.

**Scope / reuse.** Each pin stays inside the issue file map, reuses
`write_launcher` / `validateAgentIds` / existing test homes, creates no new
product files, and adds only focused Muse cases in `test/cli.test.ts`,
`test/install.test.ts`, and `test/tmux.test.ts`. Maintenance-map naming
(`agentMaintenance` vs `agentExecutables`) is cosmetic.

**Ranking.** Prefer **codex `bf0763a60d36f1d322d1f8bb36ee819742b7784f`**: same
correct product behavior as the peers, with the strongest launcher regression
(PATH isolation, spaced home, shim presence, ignore/`check-ignore`) and the
most explicit containment caveat in docs. **claude `cc767a47…`** is a close
second (best docs heading structure, aligned tmux JSDoc). **cursor
`af7bc76b…`** is functionally acceptable but should adopt codex’s PATH-isolated
install assert and restore the Muse mention in the `vimInsertPrelude` comment
before it is treated as the merge candidate.

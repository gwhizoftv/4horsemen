# Plan — issue 158: restructure README for open-source release

Issue 158 asks for the root `README.md` to read as an open-source landing page.
It should say what `coord` is, why someone would use it, and how the
multi-agent workflow runs. Internal release-gate notes and low-level operator
detail should move to `docs/`. Two owner comments on the issue change the
issue's original blueprint:

- **Comment 1** supplies the hero banner graphic (1376×768 JPEG, "Open Source
  LLM Coordinator").
- **Comment 2** supplies the workflow flowchart (1376×768 JPEG) and says:
  **"do not use Mermaid"**. The issue's Mermaid section is therefore replaced
  by the owner's image.

This change is documentation only. No source, test, hook, or config file
changes.

## Exact File List to be changed or deleted

1. `README.md`: rewrite to the structure in **Conclusion → README outline**.
   Everything currently in it is either kept in short form, dropped because a
   doc already covers it, or moved (see item 2). The disposition table below is
   binding.
2. `docs/coord-driver.md`: receives the two README passages that no doc
   currently contains. Both move verbatim, with only heading levels and
   cross-references adjusted:
   - **Vendor quota.** The whole README section "Vendor quota evidence and
     resource holds" (Claude `StopFailure`/status-line tee, Codex `codexQuota`
     binding and helper limits, Cursor/Antigravity, closing paragraph) becomes
     a new `### Vendor quota evidence and resource holds` subsection under
     `## Owner controls`. It goes immediately after the existing
     `### Delivery safety and unknown holds` subsection (which ends just before
     `## Recovery and finalization`).
   - **Agent action fetch.** The README "Development" passage about
     `coord next --issue 42` (pull-capable agents, `coord.workspaceConfig` /
     `consensus.agentId`, and the explicit
     `COORD_AGENT=codex coord next ... --coord-root` form) is appended to the
     existing `## Agent completion contract` section.

No file is deleted.

### Disposition of current README content

| Current README section | Disposition | Where it lives afterwards |
|---|---|---|
| Intro paragraph ("standalone owner-side workflow driver … never merges") | Rewritten into the overview | README |
| Happy path: bootstrap `curl`, `coord onboard`, `gh issue create`, `coord 42` | Kept as the 3-step Quick Start | README |
| Inspect-before-run clone + `--source` / `COORD_SOURCE` / private fork | Dropped from README (already covered) | `docs/setup-workspace.md` § Bootstrap once |
| Paragraph on issue #139 release gates and the owner publication audit | Removed, as the issue requires | Already in `SECURITY.md` and `docs/setup-workspace.md` |
| Onboard defaults and what `coord N` does at start | Summarised in "How it works" | Details in `docs/coord-driver.md` § Starting and running |
| Owner-driven manual mode | One sentence plus a link | `docs/coord-driver.md` § Owner-driven manual lifecycle (already has `coord detach manual` and mutual exclusion) |
| Product isolation | Summarised as a value bullet | `docs/setup-workspace.md` § The rule everything else follows |
| Requirements | Kept as a short list | README |
| Product languages | Kept as a table | Detail stays in `docs/setup-workspace.md` § Product languages |
| License ("MIT is planned … deferred") | Corrected: `LICENSE` exists (MIT, © 2026 Michael Glenn Williams) | README links `LICENSE` |
| Advanced install, explicit `start`/`run`, resume/holds, foreground keys, `/steer` | Dropped from README (already covered) | `docs/setup-workspace.md` § Advanced install; `docs/coord-driver.md` § Starting and running and § Owner controls |
| Vendor quota evidence and resource holds | **Moved** (not covered anywhere else) | `docs/coord-driver.md` (new subsection) |
| Development commands | Kept in short form | README |
| `coord next` and the `complete` contract | **`coord next` moved**; `complete` already covered | `docs/coord-driver.md` § Agent completion contract |

## Exact file list to be created

1. `docs/images/coord-banner.jpg`: the owner's hero banner from issue
   comment 1, committed byte-for-byte.
   - Source: `https://github.com/user-attachments/assets/c33ec959-d864-4f93-88e1-34acd956737e`
   - sha256 `c77ae657df8f1bdd93aec29def61fb0b1d0c00242efa0ce58eb002aefe0295e6`
   - 465,987 bytes, JPEG 1376×768
2. `docs/images/coord-workflow.jpg`: the owner's workflow flowchart from issue
   comment 2, committed byte-for-byte.
   - Source: `https://github.com/user-attachments/assets/24a342e7-257c-4281-9d7b-676b30822544`
   - sha256 `a036510f55d07673000fbdc2bbdc8b73ce81f27b91a1f9b481d075a15257f450`
   - 401,982 bytes, JPEG 1376×768

To fetch them:

```sh
curl -fsSL -H "Authorization: token $(gh auth token)" <source> -o <path>
```

Then confirm the sha256 values above with `shasum -a 256`. Do not re-encode,
resize, or optimise either file; the owner supplied these exact assets.

## Reuse and Scope

**Reused, not duplicated**
- Operator detail already lives in `docs/coord-driver.md`, in these sections:
  Authority and safety model, Runtime topology, Owner-driven manual lifecycle,
  Starting and running, Profiles, Owner controls, Foreground interactive
  controls, Delivery safety and unknown holds, Agent completion contract, and
  Recovery and finalization.
- Install detail already lives in `docs/setup-workspace.md`, in these sections:
  Bootstrap once, Onboard a product, Advanced install, Uninstall, Product
  languages, Declaring verification, Workspace layouts and issue input, and
  Doctor.
- The README links to those sections instead of repeating them.
- `CONTRIBUTING.md`, `SECURITY.md`, and `LICENSE` already exist and are linked
  as they are.
- `docs/readiness-policy.md`, `docs/analytics.md`, and `docs/repo-map.md` are
  listed in the documentation index unchanged.

**Facts the README must state accurately** (each checked against the source or
docs during planning):
- Profiles are `solo`, `reviewed`, and `consensus`; onboarding defaults to
  `consensus` with all four agents (`docs/coord-driver.md` § Profiles).
- Revision is capped at three rounds (`DEFAULT_MAX_REVISION_ROUNDS` in
  `src/state.ts`; `src/ownerControls.ts` refuses round 4). This matches the
  image's "up to 3".
- The README prose must not repeat the image's simplification that a single
  "selected agent" implements. Under `consensus`, every active agent
  implements; the implementations are compared and balloted; one reviser
  revises. Under `reviewed`, one designated implementer continues.
- Finalization runs every configured argv check on a clean detached worktree
  at the cleanup pin, and any failure blocks the PR (§ Recovery and
  finalization).
- `coord-open-unmerged` leaves a draft PR for the owner. `coord-merged` merges
  it. So the README must not claim "never merges" without that qualifier.
- Onboard leaves the product's tracked tree byte-for-byte unchanged. Agents
  work in sibling clones. Runtime state lives outside every clone. The README
  must not overclaim "100% isolation" beyond those facts.
- Go, Rust, Node (pnpm/yarn/npm), and Make are auto-detected. Python needs
  `coord install --declare`.
- Supported platforms: macOS Terminal.app integration; elsewhere tmux only;
  native Windows is not promised.

**New files**
- The two images are the only new files. They are needed because the owner
  supplied them and rejected Mermaid.
- They are committed rather than hot-linked so the README renders from the
  repository itself (forks, mirrors, offline clones, release tarballs) and the
  bytes can be reviewed and versioned.
- `docs/images/` is a new directory. It sits under the existing `docs/`, and
  no image directory exists yet.

**Out of scope**
- The terminal screencast (the issue labels it "Follow-up").
- Any `docs/` rewrite beyond the two moved passages.
- The stale "no statusline installation" sentence in
  `docs/coord-driver.md` § Delivery safety and unknown holds (see Risks).
- `AGENTS.md`, `package.json` version, `githooks/`, `src/`, `test/`.

## Tests

No new automated test. Nothing executable changes, and a vitest case that
asserts README prose would be a brittle copy-text test with no behaviour behind
it (see Alternatives Rejected). The implementer runs these checks and quotes
the output in the commit or hand-off:

1. **Required suite:** `pnpm check:fast` (lint, typecheck, fast tests). It
   must pass unchanged. This proves the docs-only change touched nothing
   executable.
2. **Relative links resolve.** Every relative link and image in `README.md`
   must exist:

   ```sh
   grep -oE '\]\((\.?/?[^)#:]+)(#[^)]*)?\)|src="[^"]+"' README.md \
     | sed -E 's/^\]\(//; s/\)$//; s/^src="//; s/"$//; s/#.*//' \
     | grep -v '^https\?:' | sort -u \
     | while read -r p; do [ -e "$p" ] || echo "MISSING $p"; done
   ```

   Pass condition: no output. Before the change, `docs/images/*.jpg` does not
   exist, so the same command run against the new README fails.
3. **Issue requirements hold:**

   ```sh
   ! grep -nE 'issues/139|issue #139|```mermaid' README.md
   ```

   Pass condition: exit 0.
4. **Moved content landed:**

   ```sh
   grep -c 'codexQuota\|StopFailure\|coord next --issue' docs/coord-driver.md
   ```

   Pass condition: the count is ≥ 3. It is 0 before the change.
5. **Images are the owner's bytes:**

   ```sh
   shasum -a 256 docs/images/*.jpg
   ```

   Pass condition: both hashes match the values under
   "Exact file list to be created".
6. **Visual check:** view the rendered README on the pushed branch
   (`gh browse -b issue-158/<agent> README.md`). Confirm the banner and
   flowchart display, the tables render, and the badges load.

## Alternatives Rejected

- **Mermaid workflow diagram (the issue's original proposal).** The owner
  explicitly rejected it in comment 2. The owner's flowchart image is used
  instead, and short prose steps carry the accessible text.
- **Hot-linking the `github.com/user-attachments/...` URLs.** These assets
  belong to the issue, not the repository, so they can't be reviewed or
  versioned with the README and can break for forks or mirrors. Committing
  about 0.87 MB once is cheap and self-contained.
- **Re-encoding or shrinking the images.** It saves a few hundred KB but alters
  owner-supplied artwork. The current sizes are fine for a README.
- **Deleting the operator detail outright.** The vendor-quota and `coord next`
  passages exist nowhere else, so deleting them would lose documentation. They
  move to `docs/coord-driver.md` instead.
- **A new `docs/vendor-quota.md` file.** It would add a new file when
  `docs/coord-driver.md` § Owner controls already owns hold behaviour. A
  subsection keeps the material next to the hold docs it extends.
- **A vitest test asserting README headings or links.** Copy-text assertions
  have no behaviour under test and would churn on every wording edit. The
  scripted link and grep checks above give the same assurance for this change
  without adding permanent test surface.
- **Mermaid or SVG redraws of the banner, or a title other than `# coord`.**
  The issue blueprint names `# coord` and the owner supplied the banner. The
  CLI is `coord`; the repository name stays `coordination` in install URLs.

## Risks and Mitigations

- **Claims drift from behaviour** (e.g. "never merges", "sandboxed", a single
  implementer). Mitigation: the "Facts the README must state accurately" list
  in Reuse and Scope is binding. Prose describes profiles and the
  `coord-open-unmerged` / `coord-merged` PR policies precisely, and it links
  to the operator guide for detail.
- **The image simplifies the consensus flow** ("Selected agent implements").
  Mitigation: the image stays as the owner supplied it. The numbered prose
  under it states the profile-accurate sequence.
- **Losing documentation during the move.** Mitigation: the disposition table
  accounts for every current README section, and Tests check 4 proves the two
  uncovered passages arrived.
- **`docs/coord-driver.md` § Delivery safety and unknown holds says there is
  "no automatic recovery, vendor API polling, statusline installation".** That
  contradicts the moved vendor-quota subsection (issue #140 work). Mitigation:
  the new subsection sits directly after it, so a reader sees the newer
  behaviour next to the older note. Rewriting that pre-existing paragraph is
  outside this issue; a reviewer may ask for a one-line pointer, which would
  stay within `docs/coord-driver.md` and the approved file map.
- **External badge service (shields.io) unavailable.** Mitigation: badges are
  static labels with meaningful `alt` text. They carry no information that
  isn't also in the prose.
- **Repository size grows by about 0.87 MB.** Accepted: it is a one-time cost
  for owner-supplied artwork.
- **A coordination commit hook rejects binary files or the commit prefix.**
  Mitigation: commit through the normal hooks with the required `Claude: `
  (agent-specific) prefix. Do not bypass hooks; escalate if a hook refuses.

## Conclusion

Rewrite `README.md` as a landing page. Move the two passages no doc covers into
`docs/coord-driver.md`. Commit the owner's banner and flowchart under
`docs/images/`. Nothing executable changes, and `pnpm check:fast` must stay
green.

### README outline (binding order)

1. **Banner.** Centered `<img src="docs/images/coord-banner.jpg">` with
   descriptive `alt` text, above the title.
2. **`# coord`.** Then:
   - the tagline *"Multi-agent consensus engine and workflow driver for
     autonomous software development."*;
   - static badges: Claude Code, Codex, Cursor, Antigravity, License: MIT;
   - a one-paragraph overview: instead of trusting one model, `coord` gives
     several agents isolated Git clones, has them plan, review, implement, and
     ballot on a GitHub issue, mechanically verifies the exact pushed commits,
     and opens a PR for the owner.
3. **How it works.**
   - `<img src="docs/images/coord-workflow.jpg">` with `alt` text describing
     the loop.
   - Numbered steps, profile-accurate: issue snapshot; independent plans;
     plan review and ballot; implementation; peer code review and up to three
     revision rounds; finalization checks on a clean worktree; PR.
   - One sentence on `solo` / `reviewed` / `consensus`, linking
     `docs/coord-driver.md#profiles`.
4. **Why coord.** Five bullets, using the issue's value propositions in
   accurate wording:
   - two-tier peer review;
   - multi-agent consensus;
   - product tree untouched, with agents in their own clones;
   - mechanical verification of the exact pushed commit plus configured checks
     before the PR;
   - an owner control plane (status, pause/resume, steer, holds, detach).
5. **Quick start.**
   - Requirements: Node 26, pnpm 11, Git, authenticated `gh`, tmux, and the
     chosen harnesses.
   - Three numbered steps: install (bootstrap `curl … | sh`), onboard
     (`coord onboard /path/to/app`, with a `--agents codex --profile solo`
     variant), run (`gh issue create …` then `coord <N>`).
   - One line each linking the inspect-first install path and
     `coord manual` / explicit forms to their docs.
6. **Supported languages.** A table: Go `go.mod`, Rust `Cargo.toml`, Node
   (pnpm/yarn/npm), and Make are auto-detected; Python uses
   `coord install --declare`. Follow it with a link to
   `docs/setup-workspace.md#product-languages`.
7. **Platforms.** macOS (Terminal.app integration), others via tmux, native
   Windows not promised. One or two lines.
8. **Documentation.** An index with one-line descriptions:
   - `docs/coord-driver.md`
   - `docs/setup-workspace.md`
   - `docs/readiness-policy.md`
   - `docs/analytics.md`
   - `docs/repo-map.md`
   - `CONTRIBUTING.md`
   - `SECURITY.md`
9. **Development.** `pnpm install --frozen-lockfile`, `pnpm check:fast`,
   `pnpm check`, `./coord --help`, with a one-line description of each tier.
10. **License.** "MIT — see [LICENSE](LICENSE)." Distributed through GitHub,
    not npm.

# Issue 139 — implementation comparison (claude)

Bound implementation pins:

- claude `c79f036028456a635e092b9807c5e2a546561980`
- codex `16cc7f3f92e69eb7b575ab0cb6c7c057c6184998`
- cursor `3c2dd0bc666c99e9fd081e6f366ae5877d9539d5`

Each pin was read from its bound worktree and diffed against baseline
`845d28d091c530926fa4ab59d615654b56ac2977`. Coordination files
(`.plans/`, `.signals/`) are excluded from the diffs.

## Comparison

### Shared ground

All three pins land the same core change set:

- **New community files:** `CONTRIBUTING.md` and `SECURITY.md`.
- **`/tags`** is added to `.gitignore`.
- **Path scrub:** identical portable placeholders replace the
  `/Volumes/...` paths in `config.product.example.json` and
  `docs/analytics.md`. That keeps the existing
  `coordinatorConfigSchema.safeParse` example test green.
- **Install docs:** the README and `docs/setup-workspace.md` install sections
  are public-first, with `curl | sh` plus an inspect-first clone with
  `--source`.
- **`scripts/bootstrap.sh`:** comments and `--help` are rewritten with no
  behaviour change. The `COORD_SOURCE` default is unchanged.
- **Product-language docs:** a "Product languages" README section, and a
  `docs/setup-workspace.md` subsection with the detection table and a
  `--declare` Python example. All three note that `coord onboard` does not
  accept `--declare`, and that `config.product.example.json` is a full config
  rather than a declaration.
- **Test:** one hygiene case in the existing `shipped examples` block of
  `test/verify-config.test.ts`. All three use the same corrected
  private-wording regex, `/\b(?:repo|repository) is private\b|Private repos/i`.
  It fails on the baseline, because `README.md`, `docs/setup-workspace.md` and
  `scripts/bootstrap.sh` match it.
- **Not added by anyone:** `LICENSE` is absent from all three. The owner chose
  to add it outside this flow, because the coordinator's approved-path
  extractor drops root names that have no dot.
- **Untouched by everyone:** `src/`, `githooks/`, `AGENTS.md` and the version.

| | claude | codex | cursor |
| --- | --- | --- | --- |
| Files changed (non-coordination) | 10 | 9 | 11 |
| `package.json` `"license": "MIT"` | yes | no (asserts `private: true` instead) | yes |
| README license wording | links missing `LICENSE` | says `LICENSE` is deferred | "Released under the MIT License" |
| Detection table matches `proposeProjectPolicy` | yes (Node and Make rows exact) | yes (Node and Make rows exact) | approximate ("such as … `test`, `test:e2e`") |
| Unrelated test edits | none | none | `test/onboard.test.ts` timeout |
| Transient release-gate prose in README | none | yes | none |

### Findings

#### C1 — `README.md:257-259` (claude) and `README.md:137-139` (cursor) claim a license file that does not exist

- **Rule.** Public docs must not assert a license grant, or link to a license
  file, that the tree does not contain.
  - Cursor states "Released under the MIT License".
  - Mine says "MIT; see [`LICENSE`](LICENSE)".
  - Both pins also add `"license": "MIT"` to `package.json`.
  - No pin contains `LICENSE`.
- **Failure.** If either pin merges before the owner commits `LICENSE`:
  - Mine renders a dead link on GitHub.
  - Cursor's states that the code is released under MIT while the repository
    holds no license text.
  - `package.json` declares a license whose text the repository does not
    ship.
- **Codex avoids this.** Codex's `README.md:146-150` says that MIT is planned
  and `LICENSE` is deferred, and Codex leaves `package.json` without the field.
- **Fix sketch** (a test cannot assert the owner's timing). Either:
  - land the owner's `LICENSE` in the same merge, or
  - use codex's "planned, deferred" wording until it lands.

  Once `LICENSE` exists, the claude and cursor wording is correct.

#### C2 — `test/onboard.test.ts:141` (cursor) changes an unrelated test timeout

- **Rule.** An implementation stays within the issue. A test change must
  either prove the issue's behaviour or be in the approved plan.
- **Failure.** Raising the `applies the happy-path defaults…` case to
  `60_000` ms does not test anything in #139. The selected plan lists no
  `test/onboard.test.ts` change, and the fix is partial: under the same
  parallel load, `isolates the same issue number for two products sharing an
  outer runtime` (`test/onboard.test.ts:189`) also exceeded the 15 s
  `testTimeout` in this clone's `check:fast` runs. The edit therefore hides one
  symptom of a suite-wide load problem without fixing it, and it lands
  untracked inside a docs/release PR.
- **Smallest correction.** Drop the hunk. Track the onboard and vitest
  `onTaskUpdate` timeouts in their own issue.

#### C3 — `README.md:40-46` (codex) puts transient release-gate instructions in the permanent README

- **Rule.** A README describes the product as shipped. Pre-release owner
  steps belong in the tracking issue, which codex's own plan review (finding
  4) agreed with for `docs/public-release.md`.
- **Failure.** After the visibility flip, the README still tells every public
  reader things that will be stale:
  - "these preparation docs do not mean that the release gates … have
    passed";
  - the owner must "neutralize the tracked machine-specific runtime
    instruction in `AGENTS.md`";
  - the owner must "verify the anonymous cold install".

  The same applies to `SECURITY.md:21-28`, whose "Release gate: reporting
  availability is not yet verified by this change" line stays wrong once
  reporting is enabled. Each one needs a follow-up edit after release, or it
  misleads readers.
- **Smallest correction.** Keep the gates in issue #139. In `SECURITY.md`, keep
  only the reporter-facing fallback ("if the form is unavailable, do not
  disclose publicly").

#### C4 — `docs/setup-workspace.md` Node row (cursor) does not match the proposer

- **Rule.** The detection table cites `proposeProjectPolicy`, so it must
  describe what that function proposes (`src/setupWorkspace.ts:205-221`):
  - precommit is the first of `check:fast` / `check` / `lint`;
  - prepush is `test:e2e`;
  - checks is the first of `check` / `test`.
- **Failure.**
  - Cursor's single "Typical proposal" column says "scripts such as
    `check:fast`, `check`, `test`, `test:e2e`". A reader with only `lint` and
    `test` scripts cannot tell that `lint` becomes the precommit hook and
    `test` the finalization check.
  - The row also never says that only one script of each kind is picked.
- **Smallest correction.** Split the column into verify and checks, as the
  claude and codex tables do.

### Scope, reuse and coverage

- **claude.**
  - Smallest diff that covers the selected plan.
  - No unrelated edits.
  - Reuses `repoRoot` and the `shipped examples` block.
  - The test also pins `license === "MIT"`, which C1 makes premature until
    `LICENSE` lands.
- **codex.**
  - Most thorough language section: virtualenv/PATH note, argv not shell, and
    `--agents codex --profile solo` for a single-harness stranger.
  - Accurate about the missing `LICENSE`.
  - The README and SECURITY release-gate prose (C3) is the only scope excess.
  - The test asserts `private: true` rather than a license, which matches its
    no-license-field choice.
- **cursor.**
  - Clean community files.
  - Adds an out-of-scope timeout edit (C2).
  - Has the least precise detection table (C4).
  - Repeats the license claim of C1 in stronger wording.

**Ranking:**

1. **claude.** Its one defect (C1) disappears once the owner commits
   `LICENSE`, as they chose to do.
2. **codex.** Accurate, but its README carries text that goes stale after
   release (C3).
3. **cursor.** C1, C2 and C4.

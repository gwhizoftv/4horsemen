# Issue 95 implementation comparison (cursor)

Bound implementation pins (cite every pin):

- claude `b331e9a0cb4cf9acdc455eb272371278ddbc0414`
- codex `5f3c7a8b9c18d2f6abf6cc2cb3542609d42d4f17`
- cursor `1addcc238016dd198255fef585e0dbdbf3856ef0`

Selected plan: claude `8eb124c6495be6c19cb12afd3531c225b86166f5`.

## Comparison

All three pins deliver the issue’s acceptance spine against baseline
`4d65f30bd3c33edf83fc678b69f4cf3fa678f3a9`:

- Delete the live `origin/main` ship-gate vitest case; keep
  `parseDotVersion` / `isStrictlyGreater` unit coverage.
- Leave `package.json` at `0.0.18` (equal to `origin/main`) so mid-protocol
  `pnpm check:fast` no longer requires an advance.
- Restore plain `"test:fast": "vitest run --config vitest.config.ts"`.
- Soften `test/cli.test.ts` / `test/install.test.ts` to
  `JSON.parse(readFileSync(...package.json))` (no vacuous `packageVersion`
  self-compare).
- Keep `.github/workflows/version-bump.yml` trigger/steps; comment-only update
  so the Action remains the sole merge enforcement with `pnpm check:version-bump`.
- Rewrite `AGENTS.md`, `docs/coord-driver.md`, `docs/repo-map.md`, `src/cli.ts`,
  `src/install.ts`, and `src/versionBump.ts` away from “bump on every
  non-main check:fast.”

None of the three bumps to `0.0.19` in the implement pin, none leave the
`test:fast` rewrite wrapper, and none leave the precommit ship-gate sentence
in the committed `AGENTS.md` blob.

### Ranking

1. **claude `b331e9a0…`** — Closest to the selected plan and the strongest
   pin: hermetic equal / greater / base-exempt cases plus a fourth malformed
   head (`0.0.2-beta`) case; clearest AGENTS/docs wording that ordinary issue
   commits must not plan a bump; documents why CLI/install tests must not
   import `packageVersion`. Prefer this pin as the revision/merge spine.
2. **cursor `1addcc23…`** — Same product behavior and three focused hermetic
   `it`s with shared cleanup; AGENTS names both the `version-bump` workflow and
   `pnpm check:version-bump`. Lacks Claude’s malformed-version case.
3. **codex `5f3c7a8b…`** — Same behavior, but packs equal / greater / base into
   one `it` (see finding below) and has the tersest docs (no
   `check:version-bump` bullet in `docs/repo-map.md`).

### Findings

#### Codex — three gate decisions in one `it` hide later regressions

**File:** `test/versionBump.test.ts:29` (codex
`5f3c7a8b9c18d2f6abf6cc2cb3542609d42d4f17`)

**Rule:** Each distinct acceptance outcome (reject equal, accept greater,
exempt base) must be independently observable so a failure in the first
assertion cannot skip the others.

**Failure:** If equal-version rejection breaks, vitest stops inside the single
`it` and never exercises the greater-version or base-exempt expectations in
that run — a green-looking partial edit can drop base-branch exemption
coverage until someone notices.

**Smallest test:** Split into three `it`s (as cursor) or four including
malformed (as claude), each calling `checkVersionBump` once.

#### Cursor and Codex — no hermetic coverage of non-triple head versions

**File:** `test/versionBump.test.ts` (cursor `1addcc238016dd198255fef585e0dbdbf3856ef0`
ends at the base-exempt case ~L81–86; codex
`5f3c7a8b9c18d2f6abf6cc2cb3542609d42d4f17` has no malformed case). Contrast
claude `b331e9a0cb4cf9acdc455eb272371278ddbc0414` `test/versionBump.test.ts:83-87`.

**Rule:** After removing the live ship-gate case, decision branches inside
`checkVersionBump` that `pnpm check:fast` still runs must stay covered —
including the dotted-triple parse failure path in `src/versionBump.ts` that
sets `ok: false` when head is not `N.N.N`.

**Failure:** A regression that treats `0.0.2-beta` as comparable (or throws
instead of returning `ok: false`) is invisible on cursor/codex pins; only the
manual `pnpm check:version-bump` path would surface related wording, not the
parse-reject branch.

**Smallest test:** Add Claude’s case — fixture head `0.0.2-beta`, base
`0.0.1`, `headRef` non-main → `enforce: true`, `ok: false`.

#### No blocking product defects on any pin

No pin imports `packageVersion` into the version assertions, leaves
hardcoded `0.0.14`/`0.0.16`, advances `package.json` mid-protocol, keeps the
`test:fast` wrapper, or retains the committed AGENTS claim that `check:fast`
requires version `>` `origin/main`. Workflow job steps are unchanged on all
three.

## Verdict

Select **claude `b331e9a0cb4cf9acdc455eb272371278ddbc0414`** as the
implementation authority: it matches the selected plan, keeps version at
`0.0.18` for the equal-to-main proof, and is the only pin with hermetic
malformed-version coverage. Cursor is a close second (clearer per-case tests
than Codex). Codex should split its combined gate `it` before any
codex-based revision. Late `0.0.19` bump remains merge preparation on the PR
branch, not part of these implement pins.

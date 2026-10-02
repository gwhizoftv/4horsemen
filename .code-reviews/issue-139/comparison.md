# Issue 139 implementation comparison

Compared bound implementation pins:

- claude `c79f036028456a635e092b9807c5e2a546561980`
- codex `16cc7f3f92e69eb7b575ab0cb6c7c057c6184998`
- cursor `3c2dd0bc666c99e9fd081e6f366ae5877d9539d5`

Baseline: `845d28d091c530926fa4ab59d615654b56ac2977`. None of the pins change
`src/**`, hooks, or runtime behavior. All three land the same core public-release
preparation: community files, scrubbed examples, public-first bootstrap/README
wording, and a product-language section tied to `proposeProjectPolicy`.

## Comparison

### Shared across all three pins

Every implementation:

- Adds `CONTRIBUTING.md` and `SECURITY.md`.
- Scrubs `/Volumes/...` from `config.product.example.json` and `docs/analytics.md`
  (portable `/home/you/...` placeholders).
- Rewrites `scripts/bootstrap.sh` and install docs for public `curl | sh` first,
  with private-fork `--source` as the alternate.
- Adds `/tags` to `.gitignore`.
- Extends `test/verify-config.test.ts` with a hygiene case scanning README,
  `docs/*.md`, example configs, and `bootstrap.sh` for personal paths and
  private-install wording.
- Adds a **Product languages** subsection under `docs/setup-workspace.md` with
  the cargo → go → node → make detection order, a Python `--declare` example,
  and the note that `coord onboard` does not accept `--declare`.
- Leaves no root `LICENSE` file (consistent with the approved path map for
  these pins).

### Per-pin differences

| Area | claude `c79f036` | codex `16cc7f3f` | cursor `3c2dd0bc` |
| --- | --- | --- | --- |
| `package.json` | adds `"license": "MIT"` | unchanged | adds `"license": "MIT"` |
| README happy path | four-agent default; clone-then-`--source` shown | solo `--agents codex --profile solo` example; extensive owner release gates in prose | four-agent default; inspect-first clone commented |
| README license section | links to missing `LICENSE` | states MIT planned but `LICENSE` deferred | cites `"license": "MIT"` in `package.json` |
| `CONTRIBUTING.md` | short fork/topic-branch guide | longer guide with human-vs-agent split and release caveats | short fork/topic-branch guide |
| `SECURITY.md` | fallback when reporting not enabled | explicit **release gate** + issue #139 link | standard private-reporting text with enablement caveat |
| Hygiene test | asserts `package.json.license === "MIT"`; regex catches `Private repos` | asserts `private: true`; comment notes deferred `LICENSE` | asserts `package.json.license === "MIT"` |
| Extra product changes | none | none | `test/onboard.test.ts` timeout raised to 60s |
| Coordination artifacts in diff | plan/review/participation signal only | plan/review/participation signal only | plan/review/participation + implementation-ready signal |

### Findings

#### 1. claude `c79f036` — README links to a file that does not exist

**Location:** `README.md` line 259.

**Rule:** Public-facing docs must not cite paths that are absent from the tree
being shipped.

**Failure:** The License section reads `MIT; see LICENSE`, but no pin (including
claude's) adds a root `LICENSE`. A reader following the link gets a 404 on
GitHub and cannot read the license text the section promises.

**Smallest correction:** Match codex/cursor: state that MIT is selected and
recorded in `package.json`, and note that the root `LICENSE` file is an owner
follow-up—or drop the link until the file lands.

#### 2. cursor `3c2dd0bc` — onboard test change is outside the approved map

**Location:** `test/onboard.test.ts` line 141.

**Rule:** Implementations must stay within the approved path list; unrelated
test edits expand review scope without serving issue #139.

**Failure:** Only cursor's pin changes `test/onboard.test.ts`, raising one case
timeout from 15s to 60s. That file is not in the approved path map and the edit
does not guard any behavior this issue ships (docs, examples, community files).
It is an environment flake workaround, not focused coverage for the release prep.

**Smallest correction:** Revert the timeout change; if the suite is flaky under
load, address it in a separate issue with its own approved scope.

#### 3. codex `16cc7f3f` — strongest release-honesty posture; no blocking defect

Codex omits `package.json` `"license": "MIT"` but its README License section,
SECURITY.md release gate, and hygiene-test comment consistently treat root
`LICENSE` and public release as **incomplete preparation**, not finished OSS.
Its setup docs also spell out that `config.product.example.json` is a full
generated workspace config, not a drop-in `--declare` file—the distinction
codex's plan review flagged and cursor/claude partially cover elsewhere. No
separate finding against codex: it is the most internally consistent pin given
the approved path constraint that excludes `LICENSE`.

#### 4. claude and cursor — `package.json` license without root `LICENSE` is acceptable but README must match

**Location:** `package.json` (both pins); claude `README.md` line 259; cursor
`README.md` lines 137–140.

**Rule:** Metadata and prose should agree on licensing posture when the root
file is deferred.

**Failure (claude only):** claude adds `"license": "MIT"` but still tells readers
to open `LICENSE`. cursor's README correctly points at the manifest field
instead; no failure for cursor on this point.

**Smallest correction (claude):** Align the License section with the manifest
field, as cursor does.

### Scope, reuse, and tests

All three pins reuse existing `shipped examples` / `coordinatorConfigSchema`
coverage and extend one hygiene case rather than adding files or fixtures. None
duplicate `proposeProjectPolicy` or bootstrap behavioral tests—appropriate for
a docs-and-examples-only change. Claude's hygiene regex
(`Private repos` / `repository is private`) matches the bootstrap wording the
plan review required; cursor uses the same pattern. Codex's test deliberately
does not assert a license field, matching its deferred-`LICENSE` story.

### Recommendation

**Prefer codex `16cc7f3f92e69eb7b575ab0cb6c7c057c6184998` as the merge base:**
it stays within the approved map, documents release gates honestly, and avoids
the broken `LICENSE` link. Fold in claude/cursor's `"license": "MIT"` in
`package.json` if the owner wants manifest-level MIT before the root file lands.
Do not take cursor's `test/onboard.test.ts` timeout edit. Fix claude's README
License link if that pin is chosen instead.

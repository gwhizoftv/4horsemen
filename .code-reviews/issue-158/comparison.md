# Implementation comparison — issue 158

protocolVersion: 1
actionId: 33b72256-9498-4da7-8c84-292a09244b31
Reviewer: codex

## Comparison

Reviewed the four complete, coordinator-exported worktrees directly. The
following are the implementation pins, not their later readiness commits:

| Agent | Exact implementation pin | Assessment |
| --- | --- | --- |
| cursor | `73fd76fe0bdd4b10bf8b562f6b8533fcac7fa6a9` | Meets the main requirements; compact landing page with particularly explicit consensus/cleanup-pin/default-draft descriptions. |
| codex | `b76f4ed44679df78d107d1de66142a6983dc8f20` | Preferred: accurate workflow, concrete beginner guidance, explicit limits of isolation and verification, and the least historical/redundant relocated operator prose. |
| antigravity | `a907f2fc2f5ac5aedd7cf2ef8b295acfe61ffb04` | Meets the main requirements; accurate default consensus and draft-PR behavior, but exposes more internal mechanics and manual-mode commands on the landing page. |
| claude | `083a7d3189003733302049c1f317df9d0c84a2fa` | Strong, concise alternative; accessible introduction, clear profile distinctions, and minimal relocation without duplicating the completion paragraph. |

### Common correctness and scope

All four implement the selected plan's actual four product paths:
`README.md`, `docs/coord-driver.md`, `docs/images/coord-banner.jpg`, and
`docs/images/coord-workflow.jpg`. The action's changed-path lists additionally
contain issue coordination artifacts; those are not product scope expansion.
None changes source, tests, dependencies, hooks, package version, or unrelated
documentation. No candidate exploits the selected plan's overbroad extracted
path map to expand this issue.

All four place the supplied banner above the title, use the supplied workflow
image instead of Mermaid, provide text steps and nonempty image alternatives,
include the four agent badges and MIT badge, retain `## Requirements`, offer
install/onboard/run guidance with a solo alternative, link existing guides,
and correctly link the existing MIT license. The internal issue-139 release
narrative is gone from every README. All describe consensus participation and
the default unmerged draft PR without repeating the artwork's single-agent or
ready-to-merge simplifications as unconditional product behavior.

Every candidate reuses the existing operator/setup documentation and existing
test suites. The two required owner-supplied images are the only new product
files. No redundant setup guide, image-generation dependency, new abstraction,
or brittle README-copy assertion test was introduced. The complete vendor
quota passage is identical across all four guides, including helper limits,
version-bound recovery, and the final paragraph preserving other holds. All
retain both `coord next` examples under Agent completion contract.

### Distinguishing details

- **Codex:** `README.md:23-43` explicitly bounds the explanation to consensus,
  identifies all-agent implementation, one reviser, owner escalation, the
  cleanup commit, and both PR policies. `README.md:60-61` avoids representing
  sibling clones as a security sandbox or agreement as proof of correctness.
  `README.md:94-112` makes the four-harness prerequisite and replacement of
  example issue 42 explicit. `README.md:130-134` distinguishes detection from
  usable verification policy. The tradeoff is a somewhat longer README (170
  lines, versus 149 Cursor, 152 Claude, and 156 Antigravity).
- **Claude:** `README.md:15-20` is a particularly approachable overview, and
  `README.md:45-48` supplies the all-agent consensus detail that its shorter
  implementation step omits. It preserves a very compact three-step quickstart
  and keeps manual operation to a linked sentence. Its verification step
  (`README.md:38-40`) says accepted commit rather than spelling out the separate
  cleanup pin; the linked driver guide correctly explains that distinction.
- **Cursor:** `README.md:27-42` gives precise workflow semantics in a short
  page, including the cleanup pin and ballot-free publication. Unlike Codex
  and Antigravity, its run example (`README.md:90-94`) does not explicitly tell
  a newcomer to substitute the newly created issue number for 42. This is a
  small usability difference, not a reason to reject the entire implementation.
- **Antigravity:** `README.md:27-33` explains the workflow accurately but opens
  with automation-digest/state-machine details, while `README.md:92-104`
  retains a multi-command manual lifecycle block. Both are already covered in
  the linked guide; the other implementations better achieve the issue's
  front-page simplification. Its Python row (`README.md:116`) does say
  `--declare`, but the other candidates more clearly avoid suggesting that
  Python marker files are auto-detection inputs.

The guide changes are otherwise extremely close. Cursor and Antigravity add
another Git completion paragraph at `docs/coord-driver.md:448-451` even though
that section already explains SHA completion. Claude and Codex avoid that
duplication, as the selected disposition table requested. The underlying
section's incomplete explanation of response-mode completion predates this
change; it is not a newly discovered regression unique to either candidate.
Codex also removes the historical issue-126/issue-140 "this PR" framing at
`docs/coord-driver.md:674-681`, while preserving the rule that native
continuation alone does not authorize release. The other three remove the
stale no-telemetry claim but retain that historical paragraph. These are
maintainability differences, not demonstrated runtime failures.

### Validation and limitations

Independently checked all four exported READMEs and their local dependencies:

- Local links/images and Markdown fragments in README and CONTRIBUTING pass:
  Cursor 19, Codex 22, Antigravity 18, Claude 19 references. In particular,
  CONTRIBUTING's incoming `README.md#requirements` remains valid in every pin.
- Both image hashes match the selected plan in every worktree:
  banner `c77ae657df8f1bdd93aec29def61fb0b1d0c00242efa0ce58eb002aefe0295e6`;
  workflow `a036510f55d07673000fbdc2bbdc8b73ce81f27b91a1f9b481d075a15257f450`.
- GitHub's Markdown rendering API accepts each exact README: seven images
  with nonempty alt text and the expected table(s). Every one of the five
  rendered badge URLs per candidate successfully returns SVG. These are
  live rendering/asset checks, not browser screenshots or viewport-layout QA.
- Required-image order, absence of Mermaid/issue-139 narrative, relocated
  quota-section placement, and both action-fetch examples pass in all four.

No new automated tests are warranted for this prose-and-original-assets
change. For this review, `VITEST_MAX_WORKERS=2 pnpm check:fast` passed lint,
typechecking, and all 734 tests across 42 files (106.42 seconds for the test
suite), leaving timeouts and assertions unchanged. This is a check of this clone,
not a claim to have independently run each peer's suite. The prior Codex
implementation also passed full `pnpm check` with two workers and subsequently
passed its normal unmodified commit hook. Interactive browser layout QA
remains unverified; GitHub HTML checks do not substitute for it.

### Recommendation

No blocking documentation defect found in these four pinned implementations.
Select **codex**, with **claude** a close alternative, then **cursor**, then
**antigravity**. The preference is based on precision, beginner usability,
honest safety limits, and avoiding redundant/historical operator prose—not
on claiming that only one candidate preserves assets or passes link checks.
No product changes are included in this comparison submission.

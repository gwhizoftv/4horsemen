## Comparison

I compared the exact bound implementations from Cursor
`14496c05001a9e72f0a72301c5f12d0ebd597f75`, Codex
`b45393f18c9b0fe0ec0bf35e9bb7e41e5b19cb11`, and Claude
`c90717513ce4935b78c37feba7e18cda55028613`. I also ran each pin's focused
`test/agentLanguage.test.ts` suite; all three passed before the negative-control
probes described below.

**Recommended: Claude.** Claude is the closest implementation of the selected
outcome-oriented boundary. It cleans the tracked root instructions as well as
the templates, action scaffolds, hook-policy messages, and shell diagnostics;
preserves ordinary task English with explicit positive controls; scans every
file under both hook roots rather than assuming filename extensions; and
exercises populated context/change-scope action sections. It is the best base,
but the two mechanical gaps below should be corrected in revision.

- **Claude — `src/agentLanguage.ts:58-67`:** The rule must reject the issue's
  reported phase-name leak, “Join is done,” while still allowing ordinary verb
  uses such as “join the two path lists.” The implementation recognizes only
  `join artifact`, the legacy schema token, and `joined-`, so
  `findAgentLanguageViolations("Join is done; the coordinator issued a plan action.")`
  returns an empty list and the original regression can recur without failing
  the oracle. Add that exact report as a negative control and a phase-shaped
  match such as `join is (?:done|complete)` rather than restoring an
  indiscriminate bare-word ban.
- **Claude — `src/agentLanguage.ts:81-86`:** Every quoted operand emitted by a
  hook must be audited even when it contains ordinary shell escapes. The
  `"([^"]*)"` extractor treats an escaped quote as the end of the operand, so
  `echo "prefix \"the current step\" suffix"` hides the banned phrase; after
  adding that line to an extensionless canonical hook, the focused suite still
  passed. Use the escape-aware operand pattern already present in the Cursor or
  Codex implementation and add the escaped-quote case to the extractor test.

**Second: Cursor.** Cursor cleans the same current prose surfaces, has the most
robust double-quoted shell extractor, covers both `HookPolicyError` paths, and
tests the root instruction file and populated action sections. Its focused
suite passed, but its oracle does not preserve the selected plan's ordinary
task vocabulary and its hook walk leaves most canonical hooks unprotected.

- **Cursor — `src/agentLanguage.ts:49-59`:** The rule must distinguish internal
  phase framing from ordinary task prose and must still catch the reported
  “Join is done” phase name. Lines 51-54 continue to reject bare `R6`, `phase`,
  and the verb `gate` (for example, “checks that gate acceptance”), while lines
  56-59 allow “Join is done” completely. The result both forces harmless prose
  rewrites and misses the motivating regression. Add Claude's ordinary-English
  positive controls plus the exact reported sentence, then narrow the former
  patterns and add a phase-shaped Join pattern.
- **Cursor — `test/agentLanguage.test.ts:390-397`:** All hook-emitted text must
  be protected regardless of the hook filename. The `.sh` suffix filter skips
  `githooks/commit-msg`, `post-commit`, `post-merge`, `pre-commit`, and
  `pre-push`; adding `echo "the current step"` to `githooks/pre-commit` still
  leaves the focused suite green. Remove the suffix filter and retain the
  emitted-operand extractor so maintainer comments remain out of scope.

**Third: Codex.** Codex has the strongest shell operand extraction—it handles
both single- and double-quoted operands—and scans extensionless hooks. It also
updates the operator documentation. Those strengths do not compensate for an
agent-facing source file remaining dirty at the bound pin.

- **Codex — `AGENTS.md:32-46` and `test/agentLanguage.test.ts:332-337`:** The
  root instruction file an agent loads must obey the same language boundary as
  generated actions and installed templates. The pin retains “current step,”
  “typed nudge,” and “when a nudge did not land,” while the new tests scan only
  rendered/template guidance; consequently the focused suite passes although
  current agent-facing prose still contains the prohibited sequencing and
  delivery language. Apply the root wording used by Claude or Cursor and scan
  the tracked root file with any managed overlay removed.
- **Codex — `src/agentLanguage.ts:50-56`:** Ordinary task words must remain
  usable when they are not coordinator transitions. The unchanged bare
  `R[1-7]`, `phase`, `gate`, and `join` bans reject benign text such as “checks
  that gate acceptance” and “join the two path lists,” creating avoidable false
  positives. Retain Codex's escape-aware hook extractor, but use shaped
  phase-language cases with paired positive controls.

Accordingly, revise Claude's pin rather than merging the other implementations:
it already has the correct current surface coverage and ordinary-language
policy, and its remaining work is confined to strengthening the oracle and
shell operand parser. Cursor needs those fixes plus a broader hook scan; Codex
also needs the missing root product change and root-file regression coverage.

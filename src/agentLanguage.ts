import type { EvidenceId } from "./steps.js";

/**
 * The agent-facing language rule for issue 88.
 *
 * Coordinator internals — workflow step ids, gate ids, evidence ids, and the
 * delivery machinery that carries an action to a harness — are legitimate
 * vocabulary in state, the journal, analytics, CLI output, and operator docs.
 * They must not reach an agent. The surfaces that do reach an agent are the
 * rendered `action.md` body, the typed injection text, and the protocol overlay
 * installed into a clone.
 *
 * This module is the single list. It is a test-time invariant, not a runtime
 * guard: `outstanding` strings carry git output, branch names, and agent ids
 * supplied from outside this process, so a false positive must fail a test
 * rather than abort a run loop and strand an issue.
 */

export type BannedTerm = { readonly label: string; readonly pattern: string };

/** Every `EvidenceId`, as an alternation source. Exhaustive by construction. */
const EVIDENCE_IDS: readonly EvidenceId[] = [
  "join-published",
  "plan-published",
  "review-published",
  "plan-ballot-published",
  "selection-published",
  "implementation-pinned",
  "comparison-published",
  "comparison-ballot-published",
  "reviser-authorized",
  "revision-pinned",
  "consensus-ballot-published",
  "consensus-declared",
  "finalization-verified"
];

/**
 * Evidence ids are matched as an exact alternation rather than by suffix shape
 * (`-published`, `-pinned`, …). A shape rule also matches outcome-named
 * artifacts and paths that are legitimately agent-facing, so it would reject
 * text this repository is not trying to remove.
 */
const evidenceIdAlternation = [...EVIDENCE_IDS]
  .sort((left, right) => right.length - left.length)
  .join("|");

export const AGENT_FACING_BANNED_TERMS: readonly BannedTerm[] = [
  { label: "internal-step-id", pattern: String.raw`\bR[1-7]\.[a-z][a-z-]*` },
  { label: "internal-round-label", pattern: String.raw`\bR[1-7]\b` },
  { label: "gate-id", pattern: String.raw`\bgate-[1-7]\b` },
  { label: "phase-vocabulary", pattern: String.raw`\bphases?\b` },
  { label: "gate-vocabulary", pattern: String.raw`\bgates?\b` },
  { label: "delivery-vocabulary", pattern: String.raw`\bnudg[a-z]*\b` },
  { label: "participation-phase-name", pattern: String.raw`\bjoin(ed|ing)?\b` },
  { label: "evidence-id", pattern: `\\b(?:${evidenceIdAlternation})\\b` },
  { label: "internal-field-name", pattern: String.raw`\b(?:stepId|gateId|evidenceId)\b` }
];

/**
 * Every banned term found in `text`, as `"<label>: <match>"`, sorted and
 * de-duplicated. Empty when the text is clean.
 */
export const findAgentLanguageViolations = (text: string): readonly string[] => {
  const found = new Set<string>();
  for (const term of AGENT_FACING_BANNED_TERMS) {
    for (const match of text.matchAll(new RegExp(term.pattern, "gi"))) {
      found.add(`${term.label}: ${match[0]}`);
    }
  }
  return [...found].sort();
};

/**
 * Agent-facing name for the artifact behind an evidence id. Used wherever a
 * diagnostic that can reach an agent needs to name what it is complaining
 * about; the evidence id itself never leaves the coordinator.
 */
const AGENT_FACING_SUBJECT: Readonly<Record<EvidenceId, string>> = {
  "join-published": "the participation-readiness artifact",
  "plan-published": "the plan",
  "review-published": "the plan review",
  "plan-ballot-published": "the plan ballot",
  "selection-published": "the plan selection",
  "implementation-pinned": "the implementation signal",
  "comparison-published": "the comparison",
  "comparison-ballot-published": "the comparison ballot",
  "reviser-authorized": "the revision authorization",
  "revision-pinned": "the revision signal",
  "consensus-ballot-published": "the consensus ballot",
  "consensus-declared": "the consensus declaration",
  "finalization-verified": "the finalization signal"
};

export const agentFacingSubject = (evidenceId: EvidenceId): string => AGENT_FACING_SUBJECT[evidenceId];

export const agentFacingSubjects = (): readonly string[] => Object.values(AGENT_FACING_SUBJECT);

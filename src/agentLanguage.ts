import type { EvidenceId } from "./steps.js";

export type BannedTerm = {
  readonly label: string;
  readonly pattern: RegExp;
};

export const AGENT_FACING_BANNED_TERMS: readonly BannedTerm[] = [
  { label: "internal-step-id", pattern: /\bR[1-7]\.[a-z][a-z-]*/i },
  { label: "internal-round-label", pattern: /\bR[1-7]\b/ },
  { label: "gate-id", pattern: /\bgate-[1-7]\b/i },
  { label: "gate-vocabulary", pattern: /\bgates?\b/i },
  { label: "phase-vocabulary", pattern: /\bphases?\b/i },
  { label: "delivery-vocabulary", pattern: /\bnudg[a-z]*\b/i },
  { label: "join-vocabulary", pattern: /\bjoin(ed|ing)?\b/i },
  { label: "evidence-id", pattern: /\b[a-z]+(?:-[a-z]+)*-(published|pinned|declared|verified)\b/ },
  { label: "internal-field-name", pattern: /\b(stepId|gateId|evidenceId)\b/ }
];

export const findAgentLanguageViolations = (text: string): readonly string[] => {
  const violations = new Set<string>();
  for (const { label, pattern } of AGENT_FACING_BANNED_TERMS) {
    const regex = new RegExp(pattern.source, pattern.flags.includes("i") ? "gi" : "g");
    const matches = text.match(regex);
    if (matches !== null) {
      for (const match of matches) {
        violations.add(`${label}: ${match}`);
      }
    }
  }
  return [...violations].sort();
};

const AGENT_FACING_SUBJECTS: Readonly<Record<EvidenceId, string>> = {
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

export const agentFacingSubject = (evidenceId: EvidenceId): string => AGENT_FACING_SUBJECTS[evidenceId];

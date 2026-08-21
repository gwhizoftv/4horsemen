import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderAction } from "../src/action.js";
import { agentFacingSubject, findAgentLanguageViolations } from "../src/agentLanguage.js";
import { renderAgentsProtocolBlock } from "../src/agentsProtocol.js";
import { createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import { buildOrder } from "../src/runLoop.js";
import {
  cursorsStateSchema,
  initializeOperationalState,
  readCursorsState,
  readStartState,
  writeCursorsState
} from "../src/state.js";
import { STEP_DEFINITIONS, type EvidenceId, type WorkflowStepId } from "../src/steps.js";
import { renderNudgeText } from "../src/tmux.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "coord-lang-"));
  roots.push(root);
  const paths = issueRuntimePaths(root, 1);
  createIssueRuntime(paths, ["claude", "codex"]);
  initializeOperationalState(paths, {
    issue: 1,
    issueSessionId: `issue-1:${"a".repeat(40)}`,
    baselineSha: "a".repeat(40),
    profile: "consensus",
    originalRoster: ["claude", "codex"],
    branchTemplate: "issue-{issue}/{agent}",
    baseBranch: "main",
    maxRevisionRounds: 3,
    prPolicy: "coord-open-unmerged",
    automationDigest: "b".repeat(64),
    automationDigestScheme: "sha256-length-prefixed-v1",
    automationDigestSources: [{ id: "config", sha256: "b".repeat(64) }],
    trustedSourceCommit: "c".repeat(40),
    origin: "/origin.git",
    coordRoot: root,
    configPath: join(root, "config.json"),
    agents: [
      { id: "claude", root: "/clones/claude", launcher: "start-claude.sh", delivery: "pull" },
      { id: "codex", root: "/clones/codex", launcher: "start-codex.sh", delivery: "pull" }
    ],
    checks: [{ name: "check", argv: ["node", "-e", "process.exit(0)"] }],
    pollIntervalMs: 100
  });
  return { root, paths };
};

describe("agent-facing language enforcement", () => {
  it("detects forbidden vocabulary and passes clean text", () => {
    expect(findAgentLanguageViolations("Clean instruction without forbidden terms.")).toEqual([]);
    expect(findAgentLanguageViolations("Publish the join artifact")).toContain("join-vocabulary: join");
    expect(findAgentLanguageViolations("Execute step R1.join now")).toContain("internal-step-id: R1.join");
    expect(findAgentLanguageViolations("At gate-1-join we wait")).toContain("gate-id: gate-1");
    expect(findAgentLanguageViolations("Transition between phases")).toContain("phase-vocabulary: phases");
    expect(findAgentLanguageViolations("Even if you were not nudged")).toContain("delivery-vocabulary: nudged");
    expect(findAgentLanguageViolations("Missing implementation-pinned commit")).toContain(
      "evidence-id: implementation-pinned"
    );
    expect(findAgentLanguageViolations("Field stepId is missing")).toContain("internal-field-name: stepId");
  });

  it("inspects every generated action type in STEP_DEFINITIONS for language violations", () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    const cursors = readCursorsState(paths);

    for (const stepId of Object.keys(STEP_DEFINITIONS) as WorkflowStepId[]) {
      const round = stepId.startsWith("R6.") ? 1 : null;
      const order = buildOrder(paths, start, cursors, "codex", stepId, round);
      const rendered = renderAction(order);
      const violations = findAgentLanguageViolations(rendered);
      expect(violations, `Violations in step ${stepId}: ${violations.join(", ")}`).toEqual([]);
      expect(rendered).toContain("Before waiting for more input, re-read this file. If `actionId` has changed");
      expect(rendered).not.toContain("nudged");
    }
  });

  it("inspects seeded action types with citations and corrections for language violations", () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    const now = "2026-08-21T00:00:00.000Z";
    const baseCursors = readCursorsState(paths);
    const seededCursors = cursorsStateSchema.parse({
      ...baseCursors,
      accepted: [
        {
          stepId: "R1.join",
          agent: "claude",
          round: null,
          submissionSha: "1".repeat(40),
          path: ".signals/issue-1/participation-ready-claude.json",
          acceptedAt: now
        },
        {
          stepId: "R1.join",
          agent: "codex",
          round: null,
          submissionSha: "2".repeat(40),
          path: ".signals/issue-1/participation-ready-codex.json",
          acceptedAt: now
        },
        {
          stepId: "R2.plan",
          agent: "claude",
          round: null,
          submissionSha: "3".repeat(40),
          path: ".plans/issue-1/plan.md",
          approvedPaths: ["src/index.ts"],
          acceptedAt: now
        },
        {
          stepId: "R2.plan",
          agent: "codex",
          round: null,
          submissionSha: "4".repeat(40),
          path: ".plans/issue-1/plan.md",
          approvedPaths: ["src/index.ts"],
          acceptedAt: now
        },
        {
          stepId: "R3.review",
          agent: "claude",
          round: null,
          submissionSha: "5".repeat(40),
          path: ".plans/issue-1/review.md",
          acceptedAt: now
        },
        {
          stepId: "R3.review",
          agent: "codex",
          round: null,
          submissionSha: "6".repeat(40),
          path: ".plans/issue-1/review.md",
          acceptedAt: now
        },
        {
          stepId: "R3.plan-ballot",
          agent: "claude",
          round: null,
          submissionSha: "7".repeat(40),
          path: ".plans/issue-1/ballot-claude.json",
          choice: "claude",
          acceptedAt: now
        },
        {
          stepId: "R3.plan-ballot",
          agent: "codex",
          round: null,
          submissionSha: "8".repeat(40),
          path: ".plans/issue-1/ballot-codex.json",
          choice: "claude",
          acceptedAt: now
        },
        {
          stepId: "R3.publish-selection",
          agent: "claude",
          round: null,
          submissionSha: "9".repeat(40),
          path: ".plans/issue-1/selection.json",
          selectedAgents: ["claude"],
          acceptedAt: now
        },
        {
          stepId: "R4.implement",
          agent: "claude",
          round: null,
          submissionSha: "a".repeat(40),
          productPin: "b".repeat(40),
          path: ".signals/issue-1/implementation-ready-claude.json",
          acceptedAt: now
        },
        {
          stepId: "R5.compare-ballot",
          agent: "claude",
          round: null,
          submissionSha: "c".repeat(40),
          path: ".code-reviews/issue-1/ballot-claude.json",
          choice: "claude",
          acceptedAt: now
        },
        {
          stepId: "R5.reviser-auth",
          agent: "claude",
          round: null,
          submissionSha: "d".repeat(40),
          path: ".signals/issue-1/reviser-authorized.json",
          productPin: "b".repeat(40),
          reviser: "claude",
          acceptedAt: now
        },
        {
          stepId: "R6.revise",
          agent: "claude",
          round: 1,
          submissionSha: "e".repeat(40),
          productPin: "f".repeat(40),
          path: ".signals/issue-1/revision-ready-claude-round-1.json",
          acceptedAt: now
        }
      ]
    });
    writeCursorsState(paths, seededCursors);

    const outstanding = ["the implementation signal commit does not descend from its product pin"];
    for (const stepId of Object.keys(STEP_DEFINITIONS) as WorkflowStepId[]) {
      const round = stepId.startsWith("R6.") ? 1 : null;
      const order = buildOrder(paths, start, seededCursors, "claude", stepId, round, undefined, outstanding);
      const rendered = renderAction(order);
      const violations = findAgentLanguageViolations(rendered);
      expect(violations, `Violations in seeded step ${stepId}: ${violations.join(", ")}`).toEqual([]);
    }
  });

  it("verifies renderNudgeText contains no delivery or phase jargon", () => {
    const textWithoutId = renderNudgeText("/path/to/action.md");
    expect(findAgentLanguageViolations(textWithoutId)).toEqual([]);
    const textWithId = renderNudgeText("/path/to/action.md", "11111111-1111-4111-8111-111111111111");
    expect(findAgentLanguageViolations(textWithId)).toEqual([]);
    const textWithDigest = renderNudgeText(
      "/path/to/action.md",
      "11111111-1111-4111-8111-111111111111",
      "2222222222222222222222222222222222222222222222222222222222222222"
    );
    expect(findAgentLanguageViolations(textWithDigest)).toEqual([]);
  });

  it("verifies AGENTS protocol template contains no delivery or phase jargon", () => {
    const installRoot = join(process.cwd());
    const block = renderAgentsProtocolBlock(installRoot);
    expect(findAgentLanguageViolations(block)).toEqual([]);
  });

  it("verifies agentFacingSubject maps all EvidenceId values cleanly", () => {
    const evidenceIds: EvidenceId[] = [
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
    for (const id of evidenceIds) {
      const subject = agentFacingSubject(id);
      expect(subject).toBeTruthy();
      expect(findAgentLanguageViolations(subject)).toEqual([]);
    }
  });
});

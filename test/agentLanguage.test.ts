import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { renderAction } from "../src/action.js";
import {
  agentFacingSubject,
  findAgentLanguageViolations
} from "../src/agentLanguage.js";
import { renderAgentsProtocolBlock } from "../src/agentsProtocol.js";
import { createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import { buildOrder } from "../src/runLoop.js";
import { initializeOperationalState, mutateCursorsState, readCursorsState, readStartState } from "../src/state.js";
import { STEP_DEFINITIONS, type EvidenceId, type WorkflowStepId } from "../src/steps.js";
import { renderNudgeText } from "../src/tmux.js";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "coord-agent-lang-"));
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
    prPolicy: "owner-only",
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
  return paths;
};

const seedAccepted = (paths: ReturnType<typeof fixture>) => {
  const now = "2026-08-11T17:00:00.000Z";
  const tip = "c".repeat(40);
  mutateCursorsState(paths, (current) => ({
    ...current,
    accepted: [
      {
        stepId: "R2.plan" as const,
        agent: "claude",
        round: null,
        submissionSha: tip,
        path: ".plans/issue-1/plan.md",
        acceptedAt: now
      },
      {
        stepId: "R2.plan" as const,
        agent: "codex",
        round: null,
        submissionSha: tip,
        path: ".plans/issue-1/plan.md",
        acceptedAt: now
      },
      {
        stepId: "R3.review" as const,
        agent: "claude",
        round: null,
        submissionSha: tip,
        path: ".plans/issue-1/review.md",
        acceptedAt: now
      },
      {
        stepId: "R3.plan-ballot" as const,
        agent: "claude",
        round: null,
        submissionSha: tip,
        path: ".plans/issue-1/ballot-claude.json",
        acceptedAt: now,
        choice: "claude"
      },
      {
        stepId: "R4.implement" as const,
        agent: "claude",
        round: null,
        submissionSha: tip,
        path: ".signals/issue-1/implementation-ready-claude.json",
        acceptedAt: now,
        productPin: "d".repeat(40)
      },
      {
        stepId: "R5.compare-ballot" as const,
        agent: "claude",
        round: null,
        submissionSha: tip,
        path: ".code-reviews/issue-1/ballot-claude.json",
        acceptedAt: now,
        choice: "claude"
      },
      {
        stepId: "R6.revise" as const,
        agent: "claude",
        round: 1,
        submissionSha: tip,
        path: ".signals/issue-1/revision-ready-claude-round-1.json",
        acceptedAt: now,
        productPin: "e".repeat(40)
      }
    ]
  }));
};

describe("agent-facing language", () => {
  it("keeps every generated action type free of coordinator jargon", () => {
    const paths = fixture();
    const start = readStartState(paths);
    const cursors = readCursorsState(paths);
    for (const stepId of Object.keys(STEP_DEFINITIONS) as WorkflowStepId[]) {
      const round = stepId.startsWith("R6.") ? 1 : null;
      const rendered = renderAction(buildOrder(paths, start, cursors, "codex", stepId, round));
      expect(findAgentLanguageViolations(rendered), stepId).toEqual([]);
    }
  });

  it("stays clean when peer inputs are bound and corrections are attached", () => {
    const paths = fixture();
    seedAccepted(paths);
    const start = readStartState(paths);
    const cursors = readCursorsState(paths);
    const evidenceIds = Object.keys(
      Object.fromEntries(
        (Object.keys(STEP_DEFINITIONS) as WorkflowStepId[]).map((id) => [STEP_DEFINITIONS[id].evidenceId, true])
      )
    ) as EvidenceId[];
    for (const stepId of Object.keys(STEP_DEFINITIONS) as WorkflowStepId[]) {
      const round = stepId.startsWith("R6.") ? 1 : null;
      const outstanding = evidenceIds.map((id) => `${agentFacingSubject(id)} needs a correction`);
      const rendered = renderAction(buildOrder(paths, start, cursors, "codex", stepId, round, undefined, outstanding));
      expect(findAgentLanguageViolations(rendered), stepId).toEqual([]);
    }
  });

  it("keeps injected prompt text and install templates clean", () => {
    const actionId = "179da8c7-ae22-47eb-b6eb-211ceea6b732";
    const digest = "b".repeat(64);
    const path = "/runtime/issue-1/agents/codex/action.md";
    expect(findAgentLanguageViolations(renderNudgeText(path))).toEqual([]);
    expect(findAgentLanguageViolations(renderNudgeText(path, actionId))).toEqual([]);
    expect(findAgentLanguageViolations(renderNudgeText(path, actionId, digest))).toEqual([]);
    expect(findAgentLanguageViolations(renderAgentsProtocolBlock(repoRoot))).toEqual([]);
    expect(findAgentLanguageViolations(readFileSync(join(repoRoot, "templates/product/AGENTS.md"), "utf8"))).toEqual(
      []
    );
  });

  it("maps every evidence id to a clean subject and preserves internal join ids", () => {
    const evidenceIds = [
      ...new Set((Object.keys(STEP_DEFINITIONS) as WorkflowStepId[]).map((id) => STEP_DEFINITIONS[id].evidenceId))
    ] as EvidenceId[];
    expect(evidenceIds).toHaveLength(13);
    for (const id of evidenceIds) {
      expect(findAgentLanguageViolations(agentFacingSubject(id))).toEqual([]);
    }
    expect(STEP_DEFINITIONS["R1.join"].evidenceId).toBe("join-published");
    expect(STEP_DEFINITIONS["R1.join"].gateId).toBe("gate-1-join");
  });

  it("detects the known leak shapes", () => {
    expect(findAgentLanguageViolations("R1.join")).toContain("internal-step-id: R1.join");
    expect(findAgentLanguageViolations("gate-1-join").some((v) => v.startsWith("gate-id:"))).toBe(true);
    expect(
      findAgentLanguageViolations("execute the new action even if you were not nudged").some((v) =>
        v.startsWith("delivery-vocabulary:")
      )
    ).toBe(true);
    expect(findAgentLanguageViolations("join-published artifact").some((v) => v.startsWith("evidence-id:"))).toBe(
      true
    );
    expect(findAgentLanguageViolations("the current phase")).toContain("phase-vocabulary: phase");
  });
});

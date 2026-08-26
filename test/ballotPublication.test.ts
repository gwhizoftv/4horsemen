import { describe, expect, it } from "vitest";
import { batchInputSetHash, evidenceBranchFor } from "../src/ballotPublication.js";
import type { AcceptedResponse, StartState } from "../src/state.js";

const response = (agent: string, choice: string): AcceptedResponse => ({
  stepId: "R3.plan-ballot",
  agent,
  actionId: "b2337d85-6617-4e9f-8ace-901453764aa4",
  round: null,
  responseSha256: "a".repeat(64),
  path: `.plans/issue-1/ballot-${agent}.json`,
  choice,
  rationale: "reason",
  acceptedAt: "2026-01-01T00:00:00.000Z"
});

const start = {
  issue: 1,
  branchTemplate: "issue-{issue}/{agent}",
  baseBranch: "main",
  agents: [{ id: "codex" }, { id: "claude" }]
} as StartState;

describe("coordinator ballot publication", () => {
  it("reserves a non-agent evidence branch and binds ordered responses", () => {
    expect(evidenceBranchFor(start)).toBe("issue-1/coordinator-evidence");
    const first = batchInputSetHash({
      stepId: "R3.plan-ballot",
      round: null,
      activeRoster: ["codex", "claude"],
      responses: [response("codex", "codex"), { ...response("claude", "claude"), actionId: "c2337d85-6617-4e9f-8ace-901453764aa4" }],
      inputs: []
    });
    const second = batchInputSetHash({
      stepId: "R3.plan-ballot",
      round: null,
      activeRoster: ["claude", "codex"],
      responses: [{ ...response("claude", "claude"), actionId: "c2337d85-6617-4e9f-8ace-901453764aa4" }, response("codex", "codex")],
      inputs: []
    });
    expect(first).not.toBe(second);
  });
});

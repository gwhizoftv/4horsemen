import { describe, it, expect } from "vitest";
import { decide, handleDrop } from "../src/machine.js";
import type { StartConfig, Cursors, AgentCursor } from "../src/state.js";
import type { EvidenceObservation } from "../src/steps.js";

const sha = "a".repeat(40);
const sessionId = "issue-1:" + "a".repeat(40);
const now = "2026-01-01T00:00:00Z";

const makeStart = (overrides?: Partial<StartConfig>): StartConfig => ({
  formatVersion: 1 as const,
  issue: 1,
  issueSessionId: sessionId,
  baselineSha: sha,
  profile: "consensus",
  roster: ["alice", "bob", "carol", "dave"],
  baseBranch: "main",
  maxRevisionRounds: 3,
  prPolicy: "owner-only",
  automationDigest: "digest123",
  automationDigestScheme: "v3",
  trustedSourceCommit: "b".repeat(40),
  createdAt: now,
  ...overrides,
});

function makeCursor(overrides?: Partial<AgentCursor>): AgentCursor {
  return {
    stepId: "R1.join",
    actionId: "issue-1:alice:R1.join:1",
    status: "running",
    attempt: 1,
    delivery: "nudge",
    submissionSha: null,
    outstanding: [],
    updatedAt: now,
    ...overrides,
  };
}

function makeCursors(overrides?: Partial<Cursors>): Cursors {
  return {
    issueCursor: { gateId: "gate-1-join", round: null },
    agents: {
      alice: makeCursor(),
      bob: makeCursor(),
      carol: makeCursor(),
      dave: makeCursor(),
    },
    droppedAgents: [],
    paused: false,
    ...overrides,
  };
}

describe("decide", () => {
  it("with passing observations emits advance-cursor decisions", () => {
    const obs: EvidenceObservation[] = [
      { ok: true, agent: "alice", stepId: "R1.join", submissionSha: sha, outstanding: [] },
    ];
    const decisions = decide({ start: makeStart(), cursors: makeCursors(), observations: obs });
    expect(decisions.some(d => d.type === "advance-cursor" && d.agent === "alice")).toBe(true);
  });

  it("with failing observations emits reissue-action decisions", () => {
    const obs: EvidenceObservation[] = [
      { ok: false, agent: "alice", stepId: "R1.join", submissionSha: sha, outstanding: [{ code: "E1", message: "bad" }] },
    ];
    const decisions = decide({ start: makeStart(), cursors: makeCursors(), observations: obs });
    expect(decisions.some(d => d.type === "reissue-action" && d.agent === "alice")).toBe(true);
  });

  it("ignores observations from dropped agents", () => {
    const obs: EvidenceObservation[] = [
      { ok: true, agent: "alice", stepId: "R1.join", submissionSha: sha, outstanding: [] },
    ];
    const cursors = makeCursors({ droppedAgents: ["alice"] });
    const decisions = decide({ start: makeStart(), cursors, observations: obs });
    expect(decisions.some(d => d.type === "advance-cursor" && (d as { agent: string }).agent === "alice")).toBe(false);
  });

  it("advances gate when all active agents complete", () => {
    const agents = ["alice", "bob", "carol", "dave"];
    const obs: EvidenceObservation[] = agents.map(a => ({
      ok: true as const, agent: a, stepId: "R1.join" as const, submissionSha: sha, outstanding: [],
    }));
    const cursorsObj = makeCursors();
    const decisions = decide({ start: makeStart(), cursors: cursorsObj, observations: obs });
    expect(decisions.some(d => d.type === "advance-gate")).toBe(true);
  });

  it("prepares actions for next gate after advancement", () => {
    const agents = ["alice", "bob", "carol", "dave"];
    const obs: EvidenceObservation[] = agents.map(a => ({
      ok: true as const, agent: a, stepId: "R1.join" as const, submissionSha: sha, outstanding: [],
    }));
    const decisions = decide({ start: makeStart(), cursors: makeCursors(), observations: obs });
    expect(decisions.some(d => d.type === "prepare-action")).toBe(true);
  });

  it("notifies owner when revision round limit reached", () => {
    const agents = ["alice", "bob", "carol", "dave"];
    const obs: EvidenceObservation[] = agents.map(a => ({
      ok: true as const, agent: a, stepId: "R5.compare" as const, submissionSha: sha, outstanding: [],
    }));
    for (const a of agents) {
      obs.push({ ok: true, agent: a, stepId: "R5.compare-ballot", submissionSha: sha, outstanding: [] });
    }
    const cursors = makeCursors({
      issueCursor: { gateId: "gate-5-compare", round: 3 },
      agents: Object.fromEntries(agents.map(a => [a, makeCursor({ stepId: "R5.compare" })])),
    });
    const decisions = decide({ start: makeStart(), cursors, observations: obs });
    expect(decisions.some(d => d.type === "notify-owner")).toBe(true);
  });
});

describe("handleDrop", () => {
  it("refuses to drop non-existent agent", () => {
    const result = handleDrop("eve", makeStart(), makeCursors());
    expect(result.ok).toBe(false);
  });

  it("refuses to drop final active agent", () => {
    const start = makeStart({ roster: ["alice"] });
    const cursors = makeCursors({ agents: { alice: makeCursor() }, droppedAgents: [] });
    const result = handleDrop("alice", start, cursors);
    expect(result.ok).toBe(false);
  });

  it("succeeds for valid drop", () => {
    const result = handleDrop("alice", makeStart(), makeCursors());
    expect(result.ok).toBe(true);
  });
});

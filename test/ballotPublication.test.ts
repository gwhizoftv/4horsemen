import { describe, expect, it } from "vitest";
import {
  COORDINATOR_IDENTITY,
  buildBallotBatch,
  canonicalBallotBytes,
  computeBatchInputSetHash,
  evidenceCommitMessage,
  resolveEvidenceBranch
} from "../src/ballotPublication.js";
import { planBallotArtifactSchema, consensusBallotArtifactSchema } from "../src/protocol.js";
import { startStateSchema, type AcceptedResponse, type StartState } from "../src/state.js";
import type { BoundInput } from "../src/steps.js";

const now = "2026-08-25T00:00:00.000Z";

const start = (): StartState =>
  startStateSchema.parse({
    formatVersion: 4,
    issue: 110,
    issueSessionId: `issue-110:${"a".repeat(40)}`,
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
    coordRoot: "/runtime",
    completesRoot: "/completes",
    configPath: "/runtime/config.json",
    agents: [
      { id: "claude", root: "/c/claude", launcher: "start-claude.sh", delivery: "pull" },
      { id: "codex", root: "/c/codex", launcher: "start-codex.sh", delivery: "pull" }
    ],
    checks: [{ name: "check", argv: ["true"] }],
    pollIntervalMs: 1000,
    contextPaths: [],
    createdAt: now
  });

const response = (agent: string, overrides: Partial<AcceptedResponse> = {}): AcceptedResponse => ({
  stepId: "R3.plan-ballot",
  agent,
  actionId: `179da8c7-ae22-47eb-b6eb-211ceea6b73${agent === "claude" ? "1" : "2"}`,
  round: null,
  responseSha256: (agent === "claude" ? "c" : "d").repeat(64),
  choice: "codex",
  rationale: "clearest implementation strategy",
  acceptedAt: now,
  ...overrides
});

const planInputs: BoundInput[] = [
  { agent: "claude", commitSha: "1".repeat(40), path: ".plans/issue-110/plan.md", kind: "plan" },
  { agent: "codex", commitSha: "2".repeat(40), path: ".plans/issue-110/plan.md", kind: "plan" },
  { agent: "claude", commitSha: "3".repeat(40), path: ".plans/issue-110/review.md", kind: "review" }
];

describe("coordinator ballot publication", () => {
  it("builds canonical bytes whose every binding comes from trusted state", () => {
    const bytes = canonicalBallotBytes({
      stepId: "R3.plan-ballot",
      start: start(),
      response: response("claude"),
      inputs: planInputs,
      inputSetHash: "e".repeat(64),
      round: null
    });
    const parsed = planBallotArtifactSchema.parse(JSON.parse(bytes));

    // Version 2 marks coordinator authorship; the provenance pair says which
    // private handoff supplied the judgment.
    expect(parsed.protocolVersion).toBe(2);
    expect(parsed.actionId).toBe(response("claude").actionId);
    expect(parsed.responseSha256).toBe("c".repeat(64));
    expect(parsed.agent).toBe("claude");
    expect(parsed.issue).toBe(110);
    // Citations are rebuilt from the bound Git inputs, and the response carries
    // no citation fields at all, so they cannot have come from it.
    expect(parsed.plans.map((plan) => plan.commitSha)).toEqual(["1".repeat(40), "2".repeat(40)]);
    expect(parsed.reviews).toHaveLength(1);
    expect(bytes.endsWith("}\n")).toBe(true);
  });

  it("serializes the same inputs to the same bytes every time", () => {
    const once = canonicalBallotBytes({
      stepId: "R3.plan-ballot",
      start: start(),
      response: response("claude"),
      inputs: planInputs,
      inputSetHash: "e".repeat(64),
      round: null
    });
    // Reversed input order must not change a single byte: the persisted commit
    // SHA is only meaningful if the same state reproduces the same tree.
    const again = canonicalBallotBytes({
      stepId: "R3.plan-ballot",
      start: start(),
      response: response("claude"),
      inputs: [...planInputs].reverse(),
      inputSetHash: "e".repeat(64),
      round: null
    });
    expect(again).toBe(once);
  });

  it("puts the round and the bound revision pin in a consensus ballot", () => {
    const bytes = canonicalBallotBytes({
      stepId: "R6.ballot",
      start: start(),
      response: response("codex", {
        stepId: "R6.ballot",
        round: 2,
        choice: undefined,
        disposition: "approve"
      }),
      inputs: [
        { agent: "codex", commitSha: "9".repeat(40), path: ".signals/x.json", kind: "revision" }
      ],
      inputSetHash: "e".repeat(64),
      round: 2
    });
    expect(consensusBallotArtifactSchema.parse(JSON.parse(bytes))).toMatchObject({
      round: 2,
      revisionCommitSha: "9".repeat(40),
      disposition: "approve"
    });
  });

  it("writes one file per active agent at the familiar canonical paths", () => {
    const batch = buildBallotBatch({
      stepId: "R3.plan-ballot",
      start: start(),
      activeRoster: ["claude", "codex"],
      responses: [response("codex"), response("claude")],
      inputs: planInputs,
      round: null
    });
    // Ordered by the roster, not by arrival, so the file set is a function of
    // state rather than of timing.
    expect(batch.files.map((file) => file.path)).toEqual([
      ".plans/issue-110/ballot-claude.json",
      ".plans/issue-110/ballot-codex.json"
    ]);
    expect(batch.responseSha256s).toEqual(["c".repeat(64), "d".repeat(64)]);
    expect(batch.message).toBe("Coordinator: publish issue 110 plan ballot batch");
  });

  it("refuses to freeze a batch before the active denominator is complete", () => {
    expect(() =>
      buildBallotBatch({
        stepId: "R3.plan-ballot",
        start: start(),
        activeRoster: ["claude", "codex"],
        responses: [response("claude")],
        inputs: planInputs,
        round: null
      })
    ).toThrow(/before every active agent/);
  });

  it("binds the roster and the judgments into the batch identity", () => {
    const common = {
      kind: "plan-ballot-batch" as const,
      round: null,
      inputs: planInputs,
      responses: [response("claude"), response("codex")]
    };
    const base = computeBatchInputSetHash({ ...common, activeRoster: ["claude", "codex"] });

    // A roster change must produce a different batch, or a stale frozen batch
    // could be reused for a denominator it was never built against.
    expect(computeBatchInputSetHash({ ...common, activeRoster: ["codex", "claude"] })).not.toBe(base);
    expect(computeBatchInputSetHash({ ...common, activeRoster: ["claude"] })).not.toBe(base);
    // A changed judgment must too.
    expect(
      computeBatchInputSetHash({
        ...common,
        activeRoster: ["claude", "codex"],
        responses: [response("claude", { responseSha256: "f".repeat(64) }), response("codex")]
      })
    ).not.toBe(base);
    // As must a changed bound input.
    expect(
      computeBatchInputSetHash({
        ...common,
        activeRoster: ["claude", "codex"],
        inputs: [...planInputs.slice(1)]
      })
    ).not.toBe(base);
  });

  it("names the round only for consensus batches", () => {
    expect(evidenceCommitMessage("plan-ballot-batch", 110, null)).toBe(
      "Coordinator: publish issue 110 plan ballot batch"
    );
    expect(evidenceCommitMessage("comparison-ballot-batch", 110, null)).toBe(
      "Coordinator: publish issue 110 comparison ballot batch"
    );
    expect(evidenceCommitMessage("consensus-ballot-batch", 110, 2)).toBe(
      "Coordinator: publish issue 110 consensus ballot batch round 2"
    );
  });

  it("derives an evidence branch that cannot be an agent branch or the base branch", () => {
    expect(
      resolveEvidenceBranch({
        branchTemplate: "issue-{issue}/{agent}",
        issue: 110,
        roster: ["claude", "codex"],
        baseBranch: "main"
      })
    ).toBe("issue-110/coordinator-evidence");

    // An agent with the reserved id would make the coordinator publish onto
    // that agent's own branch.
    expect(() =>
      resolveEvidenceBranch({
        branchTemplate: "issue-{issue}/{agent}",
        issue: 110,
        roster: ["claude", "coordinator-evidence"],
        baseBranch: "main"
      })
    ).toThrow(/reserved/);

    // A template that ignores the agent renders every branch the same, which
    // would collide with an agent branch.
    expect(() =>
      resolveEvidenceBranch({
        branchTemplate: "issue-{issue}/shared{agent}",
        issue: 110,
        roster: ["claude"],
        baseBranch: "issue-110/sharedcoordinator-evidence"
      })
    ).toThrow(/base branch/);
  });

  it("commits as the driver rather than as any voting agent", () => {
    expect(COORDINATOR_IDENTITY.name).not.toMatch(/claude|codex|cursor/i);
    expect(COORDINATOR_IDENTITY.email).not.toMatch(/claude|codex|cursor/i);
  });
});

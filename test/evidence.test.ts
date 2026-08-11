import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { BoundInput, Order } from "../src/action.js";
import { evaluateEvidence, missingRequirements, type EvidenceContext } from "../src/evidence.js";
import { createMirror } from "../src/mirror.js";
import { computeInputSetHash } from "../src/protocol.js";
import { planSectionRequirements, stepById, type StepId } from "../src/steps.js";
import { createBareOrigin, createGitFixture, type GitFixture } from "./gitFixture.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

const baselineFile = { "README.md": "# base\n" };
const digest = "d".repeat(64);

type Harness = {
  context: EvidenceContext;
  fixture: GitFixture;
  baselineSha: string;
  /** Commit files onto the agent branch and push. Returns the new SHA. */
  publish: (message: string, files: Record<string, string>) => string;
};

const setup = (agent = "claude"): Harness => {
  const origin = createBareOrigin();
  const fixture = createGitFixture();

  cleanups.push(origin.cleanup, fixture.cleanup);

  fixture.git("remote", "add", "origin", origin.path);

  const baselineSha = fixture.commit("baseline", baselineFile);

  fixture.git("push", "--quiet", "origin", "main");
  fixture.git("checkout", "--quiet", "-b", `issue-1/${agent}`);
  fixture.git("push", "--quiet", "origin", `issue-1/${agent}`);

  const mirrorDir = mkdtempSync(join(tmpdir(), "coord-ev-mirror-"));

  cleanups.push(() => rmSync(mirrorDir, { recursive: true, force: true }));

  const mirror = createMirror(join(mirrorDir, "mirror.git"));

  mirror.ensure(origin.path);

  return {
    fixture,
    baselineSha,
    publish: (message, files) => {
      const sha = fixture.commit(message, files);

      fixture.git("push", "--quiet", "origin", `issue-1/${agent}`);

      return sha;
    },
    context: {
      mirror,
      issue: 1,
      issueSessionId: `issue-1:${baselineSha}`,
      baselineSha,
      automationDigest: digest,
      automationDigestScheme: "v3",
      branchFor: (who) => `issue-1/${who}`
    }
  };
};

const makeOrder = (stepId: StepId, agent: string, overrides: Partial<Order> = {}): Order => {
  const step = stepById(stepId);

  return {
    actionId: "opaque",
    agent,
    stepId,
    gateId: step.gateId,
    evidenceId: step.evidenceId,
    requiredPath: step.pathTemplate.replaceAll("{issue}", "1").replaceAll("{agent}", agent),
    attempt: 1,
    round: null,
    inputs: [],
    outstanding: [],
    completePath: "/owner/coord/issue-1/agents/claude/complete",
    task: "do the thing",
    ...overrides
  };
};

const envelope = (baselineSha: string, agent = "claude"): Record<string, unknown> => ({
  issue: 1,
  issueSessionId: `issue-1:${baselineSha}`,
  agent,
  createdAt: "2026-08-11T01:00:00Z"
});

describe("missingRequirements", () => {
  it("accepts a document with every required section filled in", () => {
    const plan = [
      "# Plan",
      "## Exact file map",
      "- src/a.ts",
      "## Tests",
      "unit tests",
      "## Risks and mitigations",
      "could break",
      "## Conclusion",
      "ship it"
    ].join("\n");

    expect(missingRequirements(plan, planSectionRequirements)).toEqual([]);
  });

  it("names each missing section", () => {
    const problems = missingRequirements("# Plan\n\nintro only\n", planSectionRequirements);

    expect(problems).toHaveLength(4);
    expect(problems.join(" ")).toContain("file map");
    expect(problems.join(" ")).toContain("conclusion");
  });

  it("treats a heading with no body as missing", () => {
    const plan = "## Exact file map\n\n- a\n\n## Tests\n\n## Risks\n\nx\n\n## Conclusion\n\ny\n";

    expect(missingRequirements(plan, planSectionRequirements)).toEqual([
      "missing or empty required section: tests"
    ]);
  });
});

describe("origin and reachability preconditions", () => {
  it("reports a transient failure rather than absent work when origin is unreachable", () => {
    const harness = setup();
    const broken: EvidenceContext = {
      ...harness.context,
      mirror: {
        ...harness.context.mirror,
        fetchBranch: () => ({ ok: false, kind: "transient", detail: "Could not resolve host: origin" })
      }
    };
    const result = evaluateEvidence(broken, makeOrder("R2.plan", "claude"), "a".repeat(40));

    expect(result.kind).toBe("transient");

    if (result.kind === "transient") {
      expect(result.detail).toContain("Could not resolve host");
    }
  });

  it("rejects a submission that is not reachable from the agent's branch", () => {
    const harness = setup();

    harness.publish("plan", { ".plans/issue-1/plan.md": "# Plan\n" });

    const result = evaluateEvidence(harness.context, makeOrder("R2.plan", "claude"), "0".repeat(40));

    expect(result).toMatchObject({ kind: "verdict" });

    if (result.kind === "verdict" && !result.outcome.ok) {
      expect(result.outcome.outstanding[0]).toContain("not reachable");
    }
  });

  it("rejects a real commit that lives on a different branch", () => {
    const harness = setup();

    harness.fixture.git("checkout", "--quiet", "main");
    harness.fixture.git("checkout", "--quiet", "-b", "issue-1/codex");

    const foreign = harness.fixture.commit("codex work", { ".plans/issue-1/plan.md": "# Codex\n" });

    harness.fixture.git("push", "--quiet", "origin", "issue-1/codex");

    const result = evaluateEvidence(harness.context, makeOrder("R2.plan", "claude"), foreign);

    expect(result.kind === "verdict" && result.outcome.ok).toBe(false);
  });

  it("reports the missing required path concretely", () => {
    const harness = setup();
    const sha = harness.publish("unrelated", { "notes.md": "hello\n" });
    const result = evaluateEvidence(harness.context, makeOrder("R2.plan", "claude"), sha);

    expect(result.kind === "verdict" && result.outcome.ok).toBe(false);

    if (result.kind === "verdict" && !result.outcome.ok) {
      expect(result.outcome.outstanding[0]).toContain(".plans/issue-1/plan.md");
    }
  });
});

describe("plan-published", () => {
  const fullPlan = [
    "# Plan",
    "## Exact file map",
    "- src/a.ts",
    "## Tests",
    "unit",
    "## Risks",
    "none",
    "## Conclusion",
    "ship"
  ].join("\n");

  it("accepts a plan with every required section", () => {
    const harness = setup();
    const sha = harness.publish("plan", { ".plans/issue-1/plan.md": fullPlan });

    expect(evaluateEvidence(harness.context, makeOrder("R2.plan", "claude"), sha)).toEqual({
      kind: "verdict",
      outcome: { ok: true }
    });
  });

  it("rejects a plan missing required sections", () => {
    const harness = setup();
    const sha = harness.publish("thin plan", { ".plans/issue-1/plan.md": "# Plan\n\nnot much\n" });
    const result = evaluateEvidence(harness.context, makeOrder("R2.plan", "claude"), sha);

    expect(result.kind === "verdict" && result.outcome.ok).toBe(false);

    if (result.kind === "verdict" && !result.outcome.ok) {
      expect(result.outcome.outstanding.length).toBeGreaterThan(1);
    }
  });
});

describe("join-published", () => {
  const joinPath = ".signals/issue-1/joined-claude.json";

  it("accepts a join bound to this run", () => {
    const harness = setup();
    const sha = harness.publish("join", {
      [joinPath]: JSON.stringify({
        ...envelope(harness.baselineSha),
        baselineSha: harness.baselineSha,
        automationDigest: digest,
        automationDigestScheme: "v3"
      })
    });

    expect(evaluateEvidence(harness.context, makeOrder("R1.join", "claude"), sha)).toEqual({
      kind: "verdict",
      outcome: { ok: true }
    });
  });

  it("rejects a join from a stale session", () => {
    const harness = setup();
    const sha = harness.publish("stale join", {
      [joinPath]: JSON.stringify({
        ...envelope(harness.baselineSha),
        issueSessionId: "issue-1:deadbeef",
        baselineSha: harness.baselineSha,
        automationDigest: digest,
        automationDigestScheme: "v3"
      })
    });
    const result = evaluateEvidence(harness.context, makeOrder("R1.join", "claude"), sha);

    expect(result.kind === "verdict" && result.outcome.ok).toBe(false);

    if (result.kind === "verdict" && !result.outcome.ok) {
      expect(result.outcome.outstanding.join(" ")).toContain("stale issue session");
    }
  });

  it("rejects a join declaring another agent", () => {
    const harness = setup();
    const sha = harness.publish("wrong agent", {
      [joinPath]: JSON.stringify({
        ...envelope(harness.baselineSha, "codex"),
        baselineSha: harness.baselineSha,
        automationDigest: digest,
        automationDigestScheme: "v3"
      })
    });
    const result = evaluateEvidence(harness.context, makeOrder("R1.join", "claude"), sha);

    expect(result.kind === "verdict" && result.outcome.ok).toBe(false);
  });

  it("rejects a join with a stale baseline", () => {
    const harness = setup();
    const sha = harness.publish("stale baseline", {
      [joinPath]: JSON.stringify({
        ...envelope(harness.baselineSha),
        baselineSha: "0".repeat(40),
        automationDigest: digest,
        automationDigestScheme: "v3"
      })
    });
    const result = evaluateEvidence(harness.context, makeOrder("R1.join", "claude"), sha);

    expect(result.kind === "verdict" && result.outcome.ok).toBe(false);

    if (result.kind === "verdict" && !result.outcome.ok) {
      expect(result.outcome.outstanding.join(" ")).toContain("baseline");
    }
  });

  it("rejects a malformed join document", () => {
    const harness = setup();
    const sha = harness.publish("malformed", { [joinPath]: "{not json" });
    const result = evaluateEvidence(harness.context, makeOrder("R1.join", "claude"), sha);

    expect(result.kind === "verdict" && result.outcome.ok).toBe(false);

    if (result.kind === "verdict" && !result.outcome.ok) {
      expect(result.outcome.outstanding.join(" ")).toContain("invalid JSON");
    }
  });

  it("rejects a join carrying an unknown key", () => {
    const harness = setup();
    const sha = harness.publish("extra key", {
      [joinPath]: JSON.stringify({
        ...envelope(harness.baselineSha),
        baselineSha: harness.baselineSha,
        automationDigest: digest,
        automationDigestScheme: "v3",
        note: "hello"
      })
    });

    expect(evaluateEvidence(harness.context, makeOrder("R1.join", "claude"), sha)).toMatchObject({
      kind: "verdict",
      outcome: { ok: false }
    });
  });
});

describe("plan-ballot-published", () => {
  const ballotPath = ".plans/issue-1/ballot-claude.json";

  const inputs = (): BoundInput[] => [
    { agent: "codex", path: ".plans/issue-1/plan.md", commitSha: "b".repeat(40) },
    { agent: "cursor", path: ".plans/issue-1/plan.md", commitSha: "c".repeat(40) }
  ];

  it("accepts a ballot citing exactly the bound inputs", () => {
    const harness = setup();
    const bound = inputs();
    const sha = harness.publish("ballot", {
      [ballotPath]: JSON.stringify({
        ...envelope(harness.baselineSha),
        inputSetHash: computeInputSetHash(bound),
        citations: bound,
        choice: "codex",
        rationale: "clearest"
      })
    });

    expect(
      evaluateEvidence(harness.context, makeOrder("R3.plan-ballot", "claude", { inputs: bound }), sha)
    ).toEqual({ kind: "verdict", outcome: { ok: true } });
  });

  it("rejects a ballot that omits a bound input", () => {
    const harness = setup();
    const bound = inputs();
    const partial = [bound[0] as BoundInput];
    const sha = harness.publish("partial ballot", {
      [ballotPath]: JSON.stringify({
        ...envelope(harness.baselineSha),
        inputSetHash: computeInputSetHash(partial),
        citations: partial,
        choice: "codex",
        rationale: "clearest"
      })
    });
    const result = evaluateEvidence(
      harness.context,
      makeOrder("R3.plan-ballot", "claude", { inputs: bound }),
      sha
    );

    expect(result.kind === "verdict" && result.outcome.ok).toBe(false);

    if (result.kind === "verdict" && !result.outcome.ok) {
      expect(result.outcome.outstanding.join(" ")).toContain("does not cite");
    }
  });

  it("rejects a ballot citing a stale commit for a bound input", () => {
    const harness = setup();
    const bound = inputs();
    const stale = bound.map((input, index) => (index === 0 ? { ...input, commitSha: "9".repeat(40) } : input));
    const sha = harness.publish("stale ballot", {
      [ballotPath]: JSON.stringify({
        ...envelope(harness.baselineSha),
        inputSetHash: computeInputSetHash(bound),
        citations: stale,
        choice: "codex",
        rationale: "clearest"
      })
    });
    const result = evaluateEvidence(
      harness.context,
      makeOrder("R3.plan-ballot", "claude", { inputs: bound }),
      sha
    );

    expect(result.kind === "verdict" && result.outcome.ok).toBe(false);
  });

  it("rejects a ballot citing a dropped agent's plan", () => {
    const harness = setup();
    const bound = [inputs()[0] as BoundInput];
    const withDropped = inputs();
    const sha = harness.publish("cites dropped", {
      [ballotPath]: JSON.stringify({
        ...envelope(harness.baselineSha),
        inputSetHash: computeInputSetHash(withDropped),
        citations: withDropped,
        choice: "codex",
        rationale: "clearest"
      })
    });
    const result = evaluateEvidence(
      harness.context,
      makeOrder("R3.plan-ballot", "claude", { inputs: bound }),
      sha
    );

    expect(result.kind === "verdict" && result.outcome.ok).toBe(false);

    if (result.kind === "verdict" && !result.outcome.ok) {
      expect(result.outcome.outstanding.join(" ")).toContain("not a bound input");
    }
  });

  it("rejects a mismatched inputSetHash", () => {
    const harness = setup();
    const bound = inputs();
    const sha = harness.publish("bad hash", {
      [ballotPath]: JSON.stringify({
        ...envelope(harness.baselineSha),
        inputSetHash: "e".repeat(64),
        citations: bound,
        choice: "codex",
        rationale: "clearest"
      })
    });
    const result = evaluateEvidence(
      harness.context,
      makeOrder("R3.plan-ballot", "claude", { inputs: bound }),
      sha
    );

    expect(result.kind === "verdict" && result.outcome.ok).toBe(false);

    if (result.kind === "verdict" && !result.outcome.ok) {
      expect(result.outcome.outstanding.join(" ")).toContain("inputSetHash");
    }
  });

  it("rejects a choice that is not among the bound plans", () => {
    const harness = setup();
    const bound = inputs();
    const sha = harness.publish("bad choice", {
      [ballotPath]: JSON.stringify({
        ...envelope(harness.baselineSha),
        inputSetHash: computeInputSetHash(bound),
        citations: bound,
        choice: "antigravity",
        rationale: "clearest"
      })
    });
    const result = evaluateEvidence(
      harness.context,
      makeOrder("R3.plan-ballot", "claude", { inputs: bound }),
      sha
    );

    expect(result.kind === "verdict" && result.outcome.ok).toBe(false);
  });
});

describe("implementation-pinned", () => {
  const signalPath = ".signals/issue-1/implementation-ready-claude.json";

  it("accepts a signal whose pin is an earlier product commit", () => {
    const harness = setup();
    const pin = harness.publish("implementation", { "src/feature.ts": "export const f = 1;\n" });
    const sha = harness.publish("signal", {
      [signalPath]: JSON.stringify({
        ...envelope(harness.baselineSha),
        baselineSha: harness.baselineSha,
        implementationCommitSha: pin
      })
    });

    expect(evaluateEvidence(harness.context, makeOrder("R4.implement", "claude"), sha)).toEqual({
      kind: "verdict",
      outcome: { ok: true }
    });
  });

  it("rejects a signal that pins the signal commit itself", () => {
    const harness = setup();

    harness.publish("implementation", { "src/feature.ts": "export const f = 1;\n" });

    // Publish a signal then rewrite it to name its own commit.
    const placeholder = harness.publish("signal", {
      [signalPath]: JSON.stringify({
        ...envelope(harness.baselineSha),
        baselineSha: harness.baselineSha,
        implementationCommitSha: "0".repeat(40)
      })
    });
    const selfPinned = harness.publish("self pinned", {
      [signalPath]: JSON.stringify({
        ...envelope(harness.baselineSha),
        baselineSha: harness.baselineSha,
        implementationCommitSha: placeholder
      })
    });
    const result = evaluateEvidence(
      harness.context,
      makeOrder("R4.implement", "claude"),
      placeholder
    );

    expect(result.kind === "verdict" && result.outcome.ok).toBe(false);
    expect(selfPinned).not.toBe(placeholder);
  });

  it("rejects a pin that does not exist on origin", () => {
    const harness = setup();
    const sha = harness.publish("signal", {
      [signalPath]: JSON.stringify({
        ...envelope(harness.baselineSha),
        baselineSha: harness.baselineSha,
        implementationCommitSha: "1".repeat(40)
      })
    });
    const result = evaluateEvidence(harness.context, makeOrder("R4.implement", "claude"), sha);

    expect(result.kind === "verdict" && result.outcome.ok).toBe(false);

    if (result.kind === "verdict" && !result.outcome.ok) {
      expect(result.outcome.outstanding.join(" ")).toContain("not present on origin");
    }
  });

  it("rejects a product change made after the pin", () => {
    const harness = setup();
    const pin = harness.publish("implementation", { "src/feature.ts": "export const f = 1;\n" });

    harness.publish("sneaky product change", { "src/feature.ts": "export const f = 2;\n" });

    const sha = harness.publish("signal", {
      [signalPath]: JSON.stringify({
        ...envelope(harness.baselineSha),
        baselineSha: harness.baselineSha,
        implementationCommitSha: pin
      })
    });
    const result = evaluateEvidence(harness.context, makeOrder("R4.implement", "claude"), sha);

    expect(result.kind === "verdict" && result.outcome.ok).toBe(false);

    if (result.kind === "verdict" && !result.outcome.ok) {
      expect(result.outcome.outstanding.join(" ")).toContain("post-pin-implementation-change");
    }
  });

  it("rejects a signal declaring a stale baseline", () => {
    const harness = setup();
    const pin = harness.publish("implementation", { "src/feature.ts": "1\n" });
    const sha = harness.publish("signal", {
      [signalPath]: JSON.stringify({
        ...envelope(harness.baselineSha),
        baselineSha: "2".repeat(40),
        implementationCommitSha: pin
      })
    });

    expect(evaluateEvidence(harness.context, makeOrder("R4.implement", "claude"), sha)).toMatchObject({
      kind: "verdict",
      outcome: { ok: false }
    });
  });
});

describe("revision-pinned and consensus ballots", () => {
  it("rejects a revision signal declaring the wrong round", () => {
    const harness = setup();
    const pin = harness.publish("revision", { "src/feature.ts": "export const f = 3;\n" });
    const sha = harness.publish("revision signal", {
      ".signals/issue-1/revision-ready-claude.json": JSON.stringify({
        ...envelope(harness.baselineSha),
        round: 1,
        basePin: pin,
        revisionCommitSha: pin
      })
    });
    const result = evaluateEvidence(
      harness.context,
      makeOrder("R6.revise", "claude", { round: 2, inputs: [{ agent: "claude", path: "x", commitSha: pin }] }),
      sha
    );

    expect(result.kind === "verdict" && result.outcome.ok).toBe(false);

    if (result.kind === "verdict" && !result.outcome.ok) {
      expect(result.outcome.outstanding.join(" ")).toContain("round");
    }
  });

  it("accepts a consensus ballot citing the bound revision pin", () => {
    const harness = setup();
    const pin = harness.publish("revision", { "src/feature.ts": "export const f = 3;\n" });
    const sha = harness.publish("consensus ballot", {
      ".code-reviews/issue-1/consensus-ballot-claude.json": JSON.stringify({
        ...envelope(harness.baselineSha),
        round: 1,
        pin,
        disposition: "approve",
        rationale: "looks right"
      })
    });

    expect(
      evaluateEvidence(
        harness.context,
        makeOrder("R6.ballot", "claude", {
          round: 1,
          inputs: [{ agent: "codex", path: "src", commitSha: pin }]
        }),
        sha
      )
    ).toEqual({ kind: "verdict", outcome: { ok: true } });
  });

  it("rejects a consensus ballot citing a different pin", () => {
    const harness = setup();
    const pin = harness.publish("revision", { "src/feature.ts": "export const f = 3;\n" });
    const sha = harness.publish("wrong pin ballot", {
      ".code-reviews/issue-1/consensus-ballot-claude.json": JSON.stringify({
        ...envelope(harness.baselineSha),
        round: 1,
        pin: "7".repeat(40),
        disposition: "approve",
        rationale: "looks right"
      })
    });
    const result = evaluateEvidence(
      harness.context,
      makeOrder("R6.ballot", "claude", {
        round: 1,
        inputs: [{ agent: "codex", path: "src", commitSha: pin }]
      }),
      sha
    );

    expect(result.kind === "verdict" && result.outcome.ok).toBe(false);
  });
});

describe("coordinator-internal steps", () => {
  it("are satisfied without reading origin", () => {
    const harness = setup();

    expect(evaluateEvidence(harness.context, makeOrder("R7.finalize", "claude"), "0".repeat(40))).toEqual({
      kind: "verdict",
      outcome: { ok: true }
    });
  });
});

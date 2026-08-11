import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { decide, gateComplete, nextGate, nextStepFor, type MachineInput } from "../src/machine.js";
import {
  gateDenominator,
  gatesForProfile,
  participantsFor,
  stepById,
  stepsForProfile,
  type AgentObservation,
  type Decision,
  type GateId,
  type Profile,
  type StepId
} from "../src/steps.js";

const roster = ["antigravity", "claude", "codex", "cursor"];
const now = "2026-08-11T01:00:00Z";
const sha = (fill: string): string => fill.repeat(40).slice(0, 40);

const observation = (agent: string, overrides: Partial<AgentObservation> = {}): AgentObservation => ({
  agent,
  hasAction: false,
  stepId: null,
  submissionSha: null,
  verification: null,
  harnessAlive: true,
  ...overrides
});

const makeInput = (overrides: Partial<MachineInput> = {}): MachineInput => ({
  profile: "consensus",
  activeAgents: roster,
  droppedAgents: [],
  gateId: "gate-1-join",
  round: null,
  selected: null,
  maxRevisionRounds: 3,
  paused: false,
  abandoned: false,
  satisfied: {},
  attempts: {},
  revisionRequested: false,
  observations: { agents: roster.map((agent) => observation(agent)), now },
  ...overrides
});

const kinds = (decisions: readonly Decision[]): string[] => decisions.map((decision) => decision.kind);

const forAgent = (decisions: readonly Decision[], agent: string): Decision[] =>
  decisions.filter((decision) => "agent" in decision && decision.agent === agent);

describe("profiles and denominators", () => {
  it("runs every gate under consensus", () => {
    expect(gatesForProfile("consensus")).toEqual([
      "gate-1-join",
      "gate-2-plans",
      "gate-3-selection",
      "gate-4-implementation",
      "gate-5-comparison",
      "gate-6-consensus",
      "gate-7-finalized"
    ]);
  });

  it("skips peer review and comparison under solo", () => {
    const gates = gatesForProfile("solo");

    expect(gates).not.toContain("gate-3-selection");
    expect(gates).not.toContain("gate-5-comparison");
    expect(gates).toContain("gate-4-implementation");
    expect(gates).toContain("gate-7-finalized");
  });

  it("counts every active agent for a four-agent join gate", () => {
    expect(gateDenominator("gate-1-join", "consensus", roster, null)).toBe(4);
  });

  it("shrinks the denominator when an agent is dropped", () => {
    expect(gateDenominator("gate-2-plans", "consensus", ["claude", "codex", "cursor"], null)).toBe(3);
  });

  it("makes every active agent an implementer under consensus", () => {
    expect(participantsFor(stepById("R4.implement"), "consensus", roster, null)).toEqual(roster);
  });

  it("restricts implementation to the selected agent under reviewed", () => {
    expect(participantsFor(stepById("R4.implement"), "reviewed", roster, "codex")).toEqual(["codex"]);
  });

  it("gives a single remaining agent every agent-facing step", () => {
    expect(participantsFor(stepById("R4.implement"), "consensus", ["claude"], null)).toEqual(["claude"]);
    expect(participantsFor(stepById("R6.revise"), "consensus", ["claude"], null)).toEqual(["claude"]);
  });

  it("assigns no participants to coordinator steps", () => {
    for (const stepId of ["R3.publish-selection", "R6.declare", "R7.finalize"] as StepId[]) {
      expect(participantsFor(stepById(stepId), "consensus", roster, null)).toEqual([]);
    }
  });

  it("keeps solo profile step count below consensus", () => {
    expect(stepsForProfile("solo").length).toBeLessThan(stepsForProfile("consensus").length);
  });
});

describe("ordering", () => {
  it("orders the first step for every agent that has no action", () => {
    const decisions = decide(makeInput());

    expect(decisions.filter((decision) => decision.kind === "order")).toHaveLength(4);
  });

  it("does not re-order an agent that already has an outstanding action", () => {
    const decisions = decide(
      makeInput({
        observations: {
          agents: roster.map((agent) => observation(agent, { hasAction: agent === "claude" })),
          now
        }
      })
    );

    expect(forAgent(decisions, "claude")).toHaveLength(0);
    expect(forAgent(decisions, "codex").map((decision) => decision.kind)).toEqual(["order"]);
  });

  it("moves an agent to the next unsatisfied step in the gate", () => {
    const input = makeInput({
      gateId: "gate-3-selection",
      satisfied: { "R3.review": ["claude"] }
    });

    expect(nextStepFor(input, "claude")?.stepId).toBe("R3.plan-ballot");
    expect(nextStepFor(input, "codex")?.stepId).toBe("R3.review");
  });

  it("returns no step for an agent that has finished the gate", () => {
    const input = makeInput({
      gateId: "gate-2-plans",
      satisfied: { "R2.plan": roster }
    });

    expect(nextStepFor(input, "claude")).toBeNull();
  });
});

describe("intent and proof matrix", () => {
  it("waits when there is no submission and an action is outstanding", () => {
    const decisions = decide(
      makeInput({
        observations: { agents: [observation("claude", { hasAction: true })], now },
        activeAgents: ["claude"]
      })
    );

    expect(kinds(decisions)).toEqual(["wait"]);
  });

  it("accepts and clears on passing evidence", () => {
    const decisions = decide(
      makeInput({
        activeAgents: ["claude"],
        observations: {
          agents: [
            observation("claude", {
              hasAction: true,
              submissionSha: sha("a"),
              verification: { kind: "verdict", outcome: { ok: true } }
            })
          ],
          now
        }
      })
    );

    expect(kinds(decisions)).toContain("accept");
    expect(kinds(decisions)).toContain("clear-completion");
  });

  it("clears and re-orders with concrete outstanding detail on failing evidence", () => {
    const decisions = decide(
      makeInput({
        activeAgents: ["claude"],
        observations: {
          agents: [
            observation("claude", {
              hasAction: true,
              submissionSha: sha("a"),
              verification: {
                kind: "verdict",
                outcome: { ok: false, outstanding: [".signals/issue-1/joined-claude.json is missing"] }
              }
            })
          ],
          now
        }
      })
    );
    const reorder = decisions.find((decision) => decision.kind === "reorder");

    expect(kinds(decisions)).toContain("clear-completion");
    expect(reorder).toBeDefined();

    if (reorder?.kind === "reorder") {
      expect(reorder.outstanding[0]).toContain("joined-claude.json");
    }
  });

  it("preserves the submission and emits no verdict on a transient failure", () => {
    const decisions = decide(
      makeInput({
        activeAgents: ["claude"],
        observations: {
          agents: [
            observation("claude", {
              hasAction: true,
              submissionSha: sha("a"),
              verification: { kind: "transient", detail: "Could not resolve host: origin" }
            })
          ],
          now
        }
      })
    );

    expect(kinds(decisions)).toEqual(["retry-verification"]);
    // Critically: no clear-completion, no reorder, no missing-artifact verdict.
    expect(kinds(decisions)).not.toContain("clear-completion");
    expect(kinds(decisions)).not.toContain("reorder");
  });
});

describe("indefinite waiting", () => {
  it("keeps re-ordering after any number of failed submissions", () => {
    for (const attempt of [1, 5, 50, 5000]) {
      const decisions = decide(
        makeInput({
          activeAgents: ["claude", "codex"],
          attempts: { claude: attempt },
          observations: {
            agents: [
              observation("claude", {
                hasAction: true,
                submissionSha: sha("a"),
                verification: { kind: "verdict", outcome: { ok: false, outstanding: ["still missing"] } }
              }),
              observation("codex", { hasAction: true })
            ],
            now
          }
        })
      );

      expect(kinds(decisions)).toContain("reorder");
      // No attempt count ever drops, advances, or terminates.
      expect(kinds(decisions)).not.toContain("advance-gate");
      expect(kinds(decisions)).not.toContain("await-owner");
      expect(kinds(decisions)).not.toContain("finalize");
    }
  });

  it("holds a shared gate open while one agent has not submitted", () => {
    const decisions = decide(
      makeInput({
        gateId: "gate-2-plans",
        satisfied: { "R2.plan": ["antigravity", "claude", "codex"] },
        observations: { agents: [observation("cursor", { hasAction: true })], now }
      })
    );

    expect(kinds(decisions)).not.toContain("advance-gate");
    expect(kinds(decisions)).toEqual(["wait"]);
  });

  it("notifies the owner without changing the workflow", () => {
    const decisions = decide(
      makeInput({
        activeAgents: ["claude", "codex"],
        attempts: { claude: 12 },
        observations: {
          agents: [
            observation("claude", {
              hasAction: true,
              submissionSha: sha("a"),
              verification: { kind: "verdict", outcome: { ok: false, outstanding: ["nope"] } }
            })
          ],
          now
        }
      })
    );
    const notify = decisions.find((decision) => decision.kind === "notify-owner");

    expect(notify).toBeDefined();

    if (notify?.kind === "notify-owner") {
      expect(notify.message).toContain("attempt 13");
    }
  });
});

describe("owner drop", () => {
  const dropped = makeInput({
    activeAgents: ["antigravity", "claude", "cursor"],
    droppedAgents: ["codex"],
    gateId: "gate-2-plans",
    observations: {
      agents: [
        observation("codex", { hasAction: true, submissionSha: sha("f") }),
        observation("claude", { hasAction: true })
      ],
      now
    }
  });

  it("ignores a dropped agent's completion and clears it", () => {
    const decisions = decide(dropped);

    expect(forAgent(decisions, "codex").map((decision) => decision.kind)).toEqual(["clear-completion"]);
    expect(kinds(decisions)).not.toContain("accept");
  });

  it("issues no order to a dropped agent", () => {
    const decisions = decide({
      ...dropped,
      observations: { agents: [observation("codex")], now }
    });

    expect(decisions.filter((decision) => decision.kind === "order")).toHaveLength(0);
  });

  it("shrinks the gate denominator so the remaining agents can complete it", () => {
    expect(gateDenominator("gate-2-plans", "consensus", dropped.activeAgents, null)).toBe(3);

    const decisions = decide({
      ...dropped,
      satisfied: { "R2.plan": ["antigravity", "claude", "cursor"] },
      observations: { agents: [], now }
    });

    expect(kinds(decisions)).toContain("advance-gate");
  });

  it("never lists a dropped agent as a participant, even if it published first", () => {
    const step = stepById("R3.plan-ballot");

    expect(participantsFor(step, "consensus", dropped.activeAgents, null)).not.toContain("codex");
  });

  it("degrades to solo behaviour when one agent remains", () => {
    const solo = makeInput({
      activeAgents: ["claude"],
      droppedAgents: ["antigravity", "codex", "cursor"],
      gateId: "gate-4-implementation",
      observations: { agents: [observation("claude")], now }
    });

    expect(nextStepFor(solo, "claude")?.stepId).toBe("R4.implement");
    expect(gateDenominator("gate-4-implementation", "consensus", ["claude"], null)).toBe(1);
  });
});

describe("gate advancement", () => {
  it("advances when every participant has satisfied every step", () => {
    const input = makeInput({
      gateId: "gate-1-join",
      satisfied: { "R1.join": roster },
      observations: { agents: [], now }
    });

    expect(gateComplete(input)).toBe(true);
    expect(nextGate(input)).toBe("gate-2-plans");
    expect(kinds(decide(input))).toContain("advance-gate");
  });

  it("does not advance when one participant is missing", () => {
    const input = makeInput({
      gateId: "gate-1-join",
      satisfied: { "R1.join": ["claude", "codex", "cursor"] },
      observations: { agents: [], now }
    });

    expect(gateComplete(input)).toBe(false);
    expect(kinds(decide(input))).not.toContain("advance-gate");
  });

  it("finalizes rather than advancing at the last gate", () => {
    const input = makeInput({
      gateId: "gate-7-finalized",
      observations: { agents: [], now }
    });

    expect(nextGate(input)).toBeNull();
    expect(kinds(decide(input))).toContain("finalize");
  });

  it("skips the solo profile's absent gates when advancing", () => {
    const input = makeInput({
      profile: "solo",
      activeAgents: ["claude"],
      gateId: "gate-2-plans",
      satisfied: { "R2.plan": ["claude"] },
      observations: { agents: [], now }
    });

    expect(nextGate(input)).toBe("gate-4-implementation");
  });
});

describe("revision rounds", () => {
  const atRound = (round: number, revisionRequested: boolean): MachineInput =>
    makeInput({
      gateId: "gate-6-consensus",
      round,
      revisionRequested,
      selected: "claude",
      satisfied: {
        "R6.revise": ["claude"],
        "R6.ballot": roster
      },
      observations: { agents: [], now }
    });

  it("allows rounds 1 through 3 to continue", () => {
    for (const round of [1, 2]) {
      expect(kinds(decide(atRound(round, true)))).not.toContain("await-owner");
    }
  });

  it("requires owner action after round 3 and never enters round 4", () => {
    const decisions = decide(atRound(3, true));
    const awaiting = decisions.find((decision) => decision.kind === "await-owner");

    expect(awaiting).toBeDefined();

    if (awaiting?.kind === "await-owner") {
      expect(awaiting.reason).toContain("3");
      expect(awaiting.reason).toContain("owner action required");
    }

    expect(kinds(decisions)).not.toContain("advance-gate");
  });

  it("advances normally at round 3 when no further revision was requested", () => {
    expect(kinds(decide(atRound(3, false)))).toContain("advance-gate");
  });

  it("honours a lower configured limit", () => {
    const input = { ...atRound(1, true), maxRevisionRounds: 1 };

    expect(kinds(decide(input))).toContain("await-owner");
  });
});

describe("owner controls", () => {
  it("only waits while paused", () => {
    const decisions = decide(
      makeInput({
        paused: true,
        observations: { agents: [observation("claude")], now }
      })
    );

    expect(kinds(decisions)).toEqual(["wait"]);
  });

  it("awaits the owner when abandoned", () => {
    const decisions = decide(
      makeInput({
        abandoned: true,
        observations: { agents: [observation("claude")], now }
      })
    );

    expect(kinds(decisions)).toEqual(["await-owner"]);
  });

  it("emits no orders while paused even with work outstanding", () => {
    const decisions = decide(
      makeInput({
        paused: true,
        observations: {
          agents: [
            observation("claude", {
              submissionSha: sha("a"),
              verification: { kind: "verdict", outcome: { ok: true } }
            })
          ],
          now
        }
      })
    );

    expect(kinds(decisions)).not.toContain("accept");
    expect(kinds(decisions)).not.toContain("order");
  });
});

describe("purity", () => {
  it("imports no effectful module", () => {
    const source = readFileSync(new URL("../src/machine.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);

    // The reducer may only depend on the shared vocabulary. Importing
    // evidence.ts would pull in mirror.ts and the Git boundary with it.
    expect(imports).toEqual(["./steps.js"]);

    for (const forbidden of ["evidence", "mirror", "node:fs", "node:child_process", "tmux", "state"]) {
      expect(source).not.toContain(`"./${forbidden}.js"`);
      expect(source).not.toContain(`"${forbidden}"`);
    }
  });

  it("returns the same decisions for the same input", () => {
    const input = makeInput({ gateId: "gate-2-plans" });

    expect(decide(input)).toEqual(decide(input));
  });

  it("does not mutate its input", () => {
    const input = makeInput();
    const snapshot = JSON.stringify(input);

    decide(input);

    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("covers every profile without touching a boundary", () => {
    for (const profile of ["solo", "reviewed", "consensus"] as Profile[]) {
      const gates = gatesForProfile(profile);

      for (const gateId of gates as GateId[]) {
        expect(() => decide(makeInput({ profile, gateId, observations: { agents: [], now } }))).not.toThrow();
      }
    }
  });
});

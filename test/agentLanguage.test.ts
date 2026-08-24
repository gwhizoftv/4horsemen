import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderAction } from "../src/action.js";
import { computeInputSetHash, evaluateEvidence, type EvidenceMirror } from "../src/evidence.js";
import {
  AGENT_FACING_BANNED_TERMS,
  agentFacingSubject,
  agentFacingSubjects,
  findAgentLanguageViolations,
  shellEmittedText
} from "../src/agentLanguage.js";
import { HookPolicyError, runVerifyPhase, verifyCommands } from "../src/hookPolicy.js";
import { renderAgentsProtocolBlock } from "../src/agentsProtocol.js";
import { AGENTS_PROTOCOL_MARKERS, removeManagedBlock } from "../src/productIgnore.js";
import { COORD_IDLE_SENTINEL } from "../src/tmux.js";
import { createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import { buildOrder } from "../src/runLoop.js";
import {
  cursorsStateSchema,
  initializeOperationalState,
  readCursorsState,
  readStartState,
  writeCursorsState,
  type CoordinatorConfig
} from "../src/state.js";
import { STEP_DEFINITIONS, type EvidenceId, type WorkflowStepId } from "../src/steps.js";
import { renderNudgeText } from "../src/tmux.js";

const repoRoot = new URL("..", import.meta.url).pathname;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "coord-language-"));
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

/** Accepted submissions for every step that later steps bind as inputs. */
const seedAcceptedSubmissions = (paths: ReturnType<typeof fixture>) => {
  const now = "2026-08-21T00:00:00.000Z";
  const current = readCursorsState(paths);
  const accepted = [
    ...current.activeRoster.map((agent) => ({
      stepId: "R2.plan" as const,
      agent,
      round: null,
      submissionSha: "1".repeat(40),
      path: `.plans/issue-1/plan.md`,
      approvedPaths: ["src/steps.ts"],
      acceptedAt: now
    })),
    ...current.activeRoster.map((agent) => ({
      stepId: "R3.review" as const,
      agent,
      round: null,
      submissionSha: "2".repeat(40),
      path: `.plans/issue-1/review.md`,
      acceptedAt: now
    })),
    ...current.activeRoster.map((agent) => ({
      stepId: "R3.plan-ballot" as const,
      agent,
      round: null,
      submissionSha: "3".repeat(40),
      choice: "claude",
      path: `.plans/issue-1/ballot-${agent}.json`,
      acceptedAt: now
    })),
    ...current.activeRoster.map((agent) => ({
      stepId: "R4.implement" as const,
      agent,
      round: null,
      submissionSha: "4".repeat(40),
      productPin: "5".repeat(40),
      path: `.signals/issue-1/implementation-ready-${agent}.json`,
      acceptedAt: now
    })),
    ...current.activeRoster.map((agent) => ({
      stepId: "R5.compare-ballot" as const,
      agent,
      round: null,
      submissionSha: "6".repeat(40),
      choice: "codex",
      path: `.code-reviews/issue-1/ballot-${agent}.json`,
      acceptedAt: now
    })),
    {
      stepId: "R6.revise" as const,
      agent: "codex",
      round: 1,
      submissionSha: "7".repeat(40),
      productPin: "8".repeat(40),
      path: ".signals/issue-1/revision-ready-codex-round-1.json",
      acceptedAt: now
    },
    ...current.activeRoster.map((agent) => ({
      stepId: "R6.ballot" as const,
      agent,
      round: 1,
      submissionSha: "9".repeat(40),
      disposition: "approve" as const,
      path: `.code-reviews/issue-1/consensus-ballot-${agent}-round-1.json`,
      acceptedAt: now
    }))
  ];
  writeCursorsState(
    paths,
    cursorsStateSchema.parse({
      ...current,
      reviser: "codex",
      selection: {
        planAgents: ["claude"],
        implementationAgent: "codex",
        implementationPin: "5".repeat(40),
        reviser: "codex"
      },
      accepted,
      updatedAt: now
    })
  );
};

const everyStep = Object.keys(STEP_DEFINITIONS) as WorkflowStepId[];
const roundOf = (stepId: WorkflowStepId): number | null => (stepId.startsWith("R6.") ? 1 : null);

const renderEveryStep = (paths: ReturnType<typeof fixture>, outstanding: readonly string[] = []): Map<WorkflowStepId, string> => {
  const start = readStartState(paths);
  const cursors = readCursorsState(paths);
  const rendered = new Map<WorkflowStepId, string>();
  for (const stepId of everyStep) {
    const order = buildOrder(
      paths,
      start,
      cursors,
      "codex",
      stepId,
      roundOf(stepId),
      "b2337d85-6617-4e9f-8ace-901453764aa4",
      outstanding
    );
    rendered.set(stepId, renderAction(order));
  }
  return rendered;
};

describe("agent-facing language", () => {
  it("keeps internal vocabulary out of every generated action type", () => {
    const paths = fixture();
    for (const [stepId, body] of renderEveryStep(paths)) {
      expect(findAgentLanguageViolations(body), stepId).toEqual([]);
    }
  });

  it("keeps internal vocabulary out of every generated action once inputs are bound", () => {
    const paths = fixture();
    seedAcceptedSubmissions(paths);
    const rendered = renderEveryStep(paths);
    // Prove the seeding actually produced bound citations, so this is not a
    // second pass over the same empty-input bodies.
    expect(rendered.get("R3.plan-ballot")).toContain('"artifact": "plan-ballot"');
    expect(rendered.get("R3.plan-ballot")).toContain("1".repeat(40));
    for (const [stepId, body] of rendered) {
      expect(findAgentLanguageViolations(body), stepId).toEqual([]);
    }
  });

  it("keeps internal vocabulary out of the correction block", () => {
    const paths = fixture();
    seedAcceptedSubmissions(paths);
    const outstanding = agentFacingSubjects().map(
      (subject) => `${subject} pins ${"e".repeat(40)}, which is not an ancestor of current origin tip.`
    );
    for (const [stepId, body] of renderEveryStep(paths, outstanding)) {
      expect(body).toContain("Correct these outstanding items:");
      expect(findAgentLanguageViolations(body), stepId).toEqual([]);
    }
  });

  it("keeps internal vocabulary out of a correction block built from real evidence output", async () => {
    const paths = fixture();
    seedAcceptedSubmissions(paths);
    const start = readStartState(paths);
    const cursors = readCursorsState(paths);
    const stepId: WorkflowStepId = "R4.implement";
    const order = buildOrder(paths, start, cursors, "codex", stepId, null, "b2337d85-6617-4e9f-8ace-901453764aa4");
    const blob = JSON.stringify({
      protocolVersion: 1,
      artifact: "implementation-ready",
      issue: order.issue,
      issueSessionId: order.issueSessionId,
      agent: "codex",
      inputSetHash: computeInputSetHash(order.inputs),
      implementationCommitSha: "d".repeat(40),
      approvedPaths: [...order.approvedPaths]
    });
    const mirror: EvidenceMirror = {
      fetchBranch: async () => ({ ok: true, ref: "refs/remotes/origin/issue-1/codex", tip: "f".repeat(40) }),
      isReachable: async () => true,
      isAncestor: async () => true,
      readBlob: async () => blob,
      changedPaths: async () => ["src/steps.ts"],
      // Echo whatever subject the evaluator supplies, exactly as pinValidation does.
      validatePhasePin: async ({ subject }) => ({
        ok: false,
        reason: "history-rewrite",
        details: `${subject} pins ${"d".repeat(40)}, which is not an ancestor of current origin tip.`
      })
    };
    const observation = await evaluateEvidence(order, "e".repeat(40), mirror);

    // The strings under test come from the evaluator, not from this test, so a
    // regression in `pinErrors` reaches the rendered action instead of being
    // masked by feeding the subject map back through the renderer.
    expect(observation.status).toBe("rejected");
    expect(observation.outstanding.length).toBeGreaterThan(0);
    expect(findAgentLanguageViolations(observation.outstanding.join(" "))).toEqual([]);

    const reissued = renderAction(
      buildOrder(
        paths,
        start,
        cursors,
        "codex",
        stepId,
        null,
        "b2337d85-6617-4e9f-8ace-901453764aa4",
        observation.outstanding
      )
    );
    expect(reissued).toContain("Correct these outstanding items:");
    expect(findAgentLanguageViolations(reissued)).toEqual([]);
  });

  it("covers every workflow step and every evidence id", () => {
    expect(everyStep).toHaveLength(13);
    const subjects = new Set<string>();
    for (const stepId of everyStep) {
      const subject = agentFacingSubject(STEP_DEFINITIONS[stepId].evidenceId);
      expect(subject, stepId).toBeTruthy();
      subjects.add(subject);
    }
    expect(subjects.size).toBe(13);
    for (const subject of agentFacingSubjects()) {
      expect(findAgentLanguageViolations(subject), subject).toEqual([]);
    }
  });

  it("keeps internal vocabulary out of the injected text", () => {
    const path = "/runtime/issue-1/agents/codex/action.md";
    const actionId = "b2337d85-6617-4e9f-8ace-901453764aa4";
    const digest = "a".repeat(64);
    for (const text of [
      renderNudgeText(path),
      renderNudgeText(path, actionId),
      renderNudgeText(path, actionId, digest)
    ]) {
      expect(findAgentLanguageViolations(text), text).toEqual([]);
    }
  });

  it("keeps internal vocabulary out of the installed agent guidance", () => {
    expect(findAgentLanguageViolations(renderAgentsProtocolBlock(repoRoot))).toEqual([]);
    expect(
      findAgentLanguageViolations(readFileSync(join(repoRoot, "templates/product/AGENTS.md"), "utf8"))
    ).toEqual([]);
  });

  it("installs the exact idle line the terminal readiness check matches", () => {
    // The sentinel is a contract between the protocol block an agent reads and
    // the matcher in src/tmux.ts. A reword on either side must fail here rather
    // than silently stop proving that a pane is idle.
    const block = renderAgentsProtocolBlock(repoRoot);
    expect(block).toContain(COORD_IDLE_SENTINEL);
    expect(findAgentLanguageViolations(COORD_IDLE_SENTINEL)).toEqual([]);
  });

  it("reports the leaks issue 88 removed", () => {
    expect(findAgentLanguageViolations("R1.join")).toContain("internal-step-id: R1.join");
    expect(findAgentLanguageViolations("gate-1-join")).toContain("gate-id: gate-1");
    expect(
      findAgentLanguageViolations("execute the new action even if you were not nudged")
    ).toContain("delivery-vocabulary: nudged");
    expect(findAgentLanguageViolations("implementation-pinned artifact pins abc")).toContain(
      "evidence-id: implementation-pinned"
    );
    expect(findAgentLanguageViolations('"artifact": "join"')).toContain(
      'participation-phase-name: "artifact": "join"'
    );
    expect(findAgentLanguageViolations("publish the join artifact")).toContain(
      "participation-phase-name: join artifact"
    );
    expect(findAgentLanguageViolations("must not commit ungated")).toContain(
      "gate-inflection: ungated"
    );
    expect(findAgentLanguageViolations("the checks are gating this push")).toContain(
      "gate-inflection: gating"
    );
    expect(findAgentLanguageViolations("the format for the current step")).toContain(
      "workflow-sequence: current step"
    );
    expect(findAgentLanguageViolations("the final cleanup step deletes those paths")).toContain(
      "workflow-sequence: final cleanup step"
    );
    expect(AGENT_FACING_BANNED_TERMS.length).toBeGreaterThan(0);
  });

  it("leaves the ordinary task English the issue still permits", () => {
    // The issue allows plain words like plan, review, step, phase, and gate when
    // they describe the work. Only the phase-shaped forms above are banned, so a
    // narrowed rule must not start rejecting the prose the workflow depends on.
    for (const ordinary of [
      "Full `pnpm check` is what the coordinator runs before the pull request.",
      "Run the checks that gate acceptance in this repository.",
      "step through the findings in order",
      "publish the participation-readiness artifact",
      "join the two path lists before comparing them"
    ]) {
      expect(findAgentLanguageViolations(ordinary), ordinary).toEqual([]);
    }
  });

  it("does not flag the outcome-named paths the workflow still publishes", () => {
    const evidenceIds = everyStep.map((stepId) => STEP_DEFINITIONS[stepId].evidenceId);
    expect(evidenceIds).toContain<EvidenceId>("reviser-authorized");
    // The evidence id `reviser-authorized` is banned, so the published path uses
    // the artifact's own name instead. A suffix-shaped rule would reject both.
    expect(STEP_DEFINITIONS["R5.reviser-auth"].requiredPath(1, "codex", null)).toBe(
      ".signals/issue-1/reviser-authorization.json"
    );
    for (const path of [
      ".signals/issue-1/participation-ready-codex.json",
      ".signals/issue-1/implementation-ready-codex.json",
      ".signals/issue-1/reviser-authorization.json",
      ".signals/issue-1/revision-ready-codex-round-1.json",
      ".signals/issue-1/finalization-ready-codex.json"
    ]) {
      expect(findAgentLanguageViolations(path), path).toEqual([]);
    }
  });

  it("leaves internal identifiers untouched", () => {
    expect(STEP_DEFINITIONS["R1.join"].id).toBe("R1.join");
    expect(STEP_DEFINITIONS["R1.join"].gateId).toBe("gate-1-join");
    expect(STEP_DEFINITIONS["R1.join"].evidenceId).toBe("join-published");
  });

  it("keeps internal vocabulary out of the instruction file an agent loads here", () => {
    // The driver's own AGENTS.md is prose an agent reads at the start of every
    // session, and nothing scanned it until issue 88's second pass. The
    // installed protocol block is rendered from the template and covered above,
    // so it is stripped here rather than scanned twice: a clone carrying an
    // older installed copy must not fail this file's own content.
    const raw = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
    const tracked = removeManagedBlock(raw, "AGENTS.md", AGENTS_PROTOCOL_MARKERS).content;
    expect(tracked.length).toBeGreaterThan(0);
    expect(findAgentLanguageViolations(tracked)).toEqual([]);
  });

  it("keeps internal vocabulary out of the text the installed hooks print", () => {
    // Hook stderr lands in the agent's own terminal. Only the emitted operands
    // are agent-facing; the comments around them explain internals to a
    // maintainer and stay free to name steps, gates, and phases.
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });
    const files = [...walk(join(repoRoot, "githooks")), ...walk(join(repoRoot, "templates/hooks"))];
    // An empty walk would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(5);
    let emittedCount = 0;
    for (const file of files) {
      for (const text of shellEmittedText(readFileSync(file, "utf8"))) {
        emittedCount += 1;
        expect(findAgentLanguageViolations(text), `${file}: ${text}`).toEqual([]);
      }
    }
    expect(emittedCount).toBeGreaterThan(10);
  });

  it("extracts only the emitted operands of a shell source", () => {
    const source = [
      '# every step is gated here, and this comment may say so',
      'echo "  clean emitted line" >&2',
      '  printf "%s\\n" "second emitted line"',
      'value="not emitted: the current step"'
    ].join("\n");
    expect(shellEmittedText(source)).toEqual(["  clean emitted line", "%s\\n", "second emitted line"]);
  });

  it("keeps internal vocabulary out of the hook diagnostics an agent is shown", () => {
    const base = { verify: undefined } as unknown as CoordinatorConfig;
    let thrown: unknown;
    try {
      verifyCommands(base, "precommit");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HookPolicyError);
    expect(findAgentLanguageViolations((thrown as Error).message)).toEqual([]);

    const declared = {
      verify: { precommit: [{ name: "check", argv: ["node", "-e", ""] }], prepush: [] }
    } as unknown as CoordinatorConfig;
    const logged: string[] = [];
    for (const phase of ["precommit", "prepush"] as const) {
      runVerifyPhase({
        clone: "/clone",
        config: declared,
        phase,
        log: (message) => logged.push(message),
        runner: () => 0
      });
    }
    expect(logged.length).toBeGreaterThan(0);
    expect(findAgentLanguageViolations(logged.join(" "))).toEqual([]);
  });

  it("keeps internal vocabulary out of an action that carries context and change scope", () => {
    const paths = fixture();
    seedAcceptedSubmissions(paths);
    const start = readStartState(paths);
    const cursors = readCursorsState(paths);
    const order = buildOrder(
      paths,
      start,
      cursors,
      "codex",
      "R5.compare",
      null,
      "b2337d85-6617-4e9f-8ace-901453764aa4"
    );
    const body = renderAction({
      ...order,
      contextPaths: ["docs/coord-driver.md", "AGENTS.md"],
      changeScope: [
        { agent: "claude", commitSha: "5".repeat(40), paths: ["src/steps.ts"], truncated: false },
        { agent: "codex", commitSha: "6".repeat(40), paths: [], truncated: true }
      ]
    });
    // Prove both optional sections actually rendered, so this is not a third
    // pass over a body that omitted them.
    expect(body).toContain("## Repo context");
    expect(body).toContain("## Changed paths for the bound pins");
    expect(findAgentLanguageViolations(body)).toEqual([]);
  });
});

import { readComplete, clearComplete, writeAction, type InternalAction, generateActionId } from "./action.js";
import { evaluateEvidence } from "./evidence.js";
import { decide, handleDrop, type MachineInput } from "./machine.js";
import { fetchAgentBranch, MirrorFetchError } from "./mirror.js";
import { readStart, readCursors, writeCursors, appendJournal, type StartConfig, type Cursors } from "./state.js";
import { type EvidenceObservation, type Decision, type StepId, STEP_TABLE, resolvePathTemplate, GATE_ORDER } from "./steps.js";

const POLL_INTERVAL_MS = 2000;

export interface RunLoopOptions {
  coordRoot: string;
  issue: number;
  onDecision?: (d: Decision) => void;
  signal?: AbortSignal;
}

/** Run a single tick: poll all agents, evaluate evidence, produce decisions. */
export async function runTick(opts: RunLoopOptions): Promise<readonly Decision[]> {
  const { coordRoot, issue } = opts;
  const start = readStart(coordRoot, issue);
  const cursors = readCursors(coordRoot, issue);
  const activeAgents = start.roster.filter(a => !cursors.droppedAgents.includes(a));
  const observations: EvidenceObservation[] = [];

  for (const agent of activeAgents) {
    const sha = readComplete(coordRoot, issue, agent);
    if (!sha) continue;

    try {
      fetchAgentBranch(coordRoot, issue, agent);
    } catch (e) {
      if (e instanceof MirrorFetchError) {
        appendJournal(coordRoot, issue, {
          timestamp: new Date().toISOString(),
          event: "fetch-failed",
          agent,
          message: e.message,
        });
        continue;
      }
      throw e;
    }

    const cursor = cursors.agents[agent];
    if (!cursor) continue;

    const action = buildInternalAction(start, cursor.stepId as StepId, agent, cursor.attempt, cursors);
    const obs = evaluateEvidence(
      coordRoot, action, sha,
      start.issueSessionId, start.baselineSha,
      start.automationDigest, start.automationDigestScheme,
      activeAgents,
    );
    observations.push(obs);

    if (obs.ok) {
      clearComplete(coordRoot, issue, agent);
      appendJournal(coordRoot, issue, {
        timestamp: new Date().toISOString(),
        event: "evidence-passed",
        agent,
        stepId: cursor.stepId,
        submissionSha: sha,
      });
    } else {
      clearComplete(coordRoot, issue, agent);
      appendJournal(coordRoot, issue, {
        timestamp: new Date().toISOString(),
        event: "evidence-failed",
        agent,
        stepId: cursor.stepId,
        submissionSha: sha,
        outstanding: obs.outstanding,
      });
    }
  }

  const input: MachineInput = { start, cursors, observations };
  const decisions = decide(input);

  applyDecisions(coordRoot, issue, start, cursors, decisions);

  return decisions;
}

function buildInternalAction(start: StartConfig, stepId: StepId, agent: string, attempt: number, cursors: Cursors): InternalAction {
  const stepDef = STEP_TABLE.find(s => s.stepId === stepId);
  const requiredPath = stepDef ? resolvePathTemplate(stepDef.requiredPathTemplate, start.issue, agent) : "";
  const activeAgents = start.roster.filter(a => !cursors.droppedAgents.includes(a));
  const inputCommits: Record<string, string> = {};
  for (const a of activeAgents) {
    if (a === agent) continue;
    const c = cursors.agents[a];
    if (c?.submissionSha) inputCommits[a] = c.submissionSha;
  }

  return {
    actionId: generateActionId(start.issue, agent, stepId, attempt),
    agent,
    stepId,
    evidenceId: stepDef?.evidenceId ?? "join-published",
    requiredPath,
    issue: start.issue,
    attempt,
    inputCommits,
    outstanding: [],
  };
}

function applyDecisions(coordRoot: string, issue: number, start: StartConfig, cursors: Cursors, decisions: readonly Decision[]): void {
  let modified = false;

  for (const d of decisions) {
    switch (d.type) {
      case "advance-cursor": {
        const c = cursors.agents[d.agent];
        if (c) {
          c.status = "complete";
          c.submissionSha = d.submissionSha;
          c.updatedAt = new Date().toISOString();
          modified = true;
        }
        break;
      }
      case "reissue-action": {
        const c = cursors.agents[d.agent];
        if (c) {
          c.status = "ordered";
          c.attempt += 1;
          c.outstanding = [...d.outstanding];
          c.updatedAt = new Date().toISOString();
          modified = true;
          const action = buildInternalAction(start, d.stepId, d.agent, c.attempt, cursors);
          action.outstanding = d.outstanding;
          writeAction(coordRoot, issue, action);
        }
        break;
      }
      case "advance-gate": {
        const idx = GATE_ORDER.indexOf(d.gate);
        if (idx < GATE_ORDER.length - 1) {
          cursors.issueCursor.gateId = GATE_ORDER[idx + 1];
          modified = true;
        }
        break;
      }
      case "prepare-action": {
        const c = cursors.agents[d.agent];
        if (c) {
          c.stepId = d.stepId;
          c.status = "ordered";
          c.attempt = 1;
          c.submissionSha = null;
          c.outstanding = [];
          c.updatedAt = new Date().toISOString();
          modified = true;
          const action = buildInternalAction(start, d.stepId, d.agent, 1, cursors);
          writeAction(coordRoot, issue, action);
        }
        break;
      }
      case "notify-owner": {
        appendJournal(coordRoot, issue, {
          timestamp: new Date().toISOString(),
          event: "owner-notification",
          message: d.message,
        });
        break;
      }
      case "finalize": {
        appendJournal(coordRoot, issue, {
          timestamp: new Date().toISOString(),
          event: "finalization-started",
          approvedSha: d.approvedSha,
        });
        break;
      }
    }
  }

  if (modified) {
    writeCursors(coordRoot, issue, cursors);
  }
}

/** The main polling loop. Runs until aborted. */
export async function runLoop(opts: RunLoopOptions): Promise<void> {
  while (!opts.signal?.aborted) {
    await runTick(opts);
    await sleep(POLL_INTERVAL_MS);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Handle a drop command from the owner. */
export function executeDrop(coordRoot: string, issue: number, agent: string): { ok: true } | { ok: false; reason: string } {
  const start = readStart(coordRoot, issue);
  const cursors = readCursors(coordRoot, issue);
  const result = handleDrop(agent, start, cursors);
  if (!result.ok) return result;

  cursors.droppedAgents.push(agent);
  clearComplete(coordRoot, issue, agent);
  writeCursors(coordRoot, issue, cursors);
  appendJournal(coordRoot, issue, {
    timestamp: new Date().toISOString(),
    event: "agent-dropped",
    agent,
  });
  return { ok: true };
}

/** Handle pause command. */
export function executePause(coordRoot: string, issue: number): void {
  const cursors = readCursors(coordRoot, issue);
  cursors.paused = true;
  writeCursors(coordRoot, issue, cursors);
  appendJournal(coordRoot, issue, {
    timestamp: new Date().toISOString(),
    event: "paused",
  });
}

/** Handle resume command. */
export function executeResume(coordRoot: string, issue: number): void {
  const cursors = readCursors(coordRoot, issue);
  cursors.paused = false;
  writeCursors(coordRoot, issue, cursors);
  appendJournal(coordRoot, issue, {
    timestamp: new Date().toISOString(),
    event: "resumed",
  });
}

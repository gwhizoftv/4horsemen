import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { actionPath, completePath } from "./paths.js";
import { type StepId, type EvidenceId, type OutstandingItem } from "./steps.js";

/** Internal action representation (never fully exposed to agents). */
export interface InternalAction {
  actionId: string;
  agent: string;
  stepId: StepId;
  evidenceId: EvidenceId;
  requiredPath: string;
  issue: number;
  attempt: number;
  inputCommits: Record<string, string>;
  outstanding: readonly OutstandingItem[];
}

/** Generate an opaque action ID. Does not encode step/gate/phase. */
export function generateActionId(issue: number, agent: string, stepId: StepId, attempt: number): string {
  return `issue-${issue}:${agent}:${stepId}:${attempt}`;
}

/** Render action.md content. Only includes agent-facing information. */
export function renderActionMd(action: InternalAction, completionFilePath: string): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`actionId: ${action.actionId}`);
  lines.push(`agent: ${action.agent}`);
  lines.push(`requiredPath: ${action.requiredPath}`);
  lines.push("---");
  lines.push("");
  lines.push(renderTaskInstructions(action, completionFilePath));
  if (action.outstanding.length > 0) {
    lines.push("");
    lines.push("## Outstanding issues from previous submission");
    lines.push("");
    for (const item of action.outstanding) {
      lines.push(`- **${item.code}**: ${item.message}`);
    }
  }
  if (Object.keys(action.inputCommits).length > 0) {
    lines.push("");
    lines.push("## Input commits");
    lines.push("");
    for (const [agent, sha] of Object.entries(action.inputCommits)) {
      lines.push(`- ${agent}: ${sha}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function renderTaskInstructions(action: InternalAction, completionFilePath: string): string {
  return `Publish the required artifact at:\n${action.requiredPath}\n\nWhen done, write your submission commit SHA (the commit that contains that\nfile on origin) as the sole contents of:\n${completionFilePath}`;
}

/** Front-matter parsed from action.md. */
export interface ActionFrontMatter {
  actionId: string;
  agent: string;
  requiredPath: string;
}

/** Parse the front-matter from an action.md file. */
export function parseActionFrontMatter(content: string): ActionFrontMatter | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const lines = match[1].split("\n");
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf(": ");
    if (idx > 0) {
      fields[line.slice(0, idx)] = line.slice(idx + 2);
    }
  }
  if (!fields["actionId"] || !fields["agent"] || !fields["requiredPath"]) return null;
  return {
    actionId: fields["actionId"],
    agent: fields["agent"],
    requiredPath: fields["requiredPath"],
  };
}

/** Write action.md for an agent. */
export function writeAction(coordRoot: string, issue: number, action: InternalAction): void {
  const path = actionPath(coordRoot, issue, action.agent);
  const completionFile = completePath(coordRoot, issue, action.agent);
  writeFileSync(path, renderActionMd(action, completionFile), "utf8");
}

/** Read the current action.md for an agent, if it exists. */
export function readAction(coordRoot: string, issue: number, agent: string): ActionFrontMatter | null {
  const path = actionPath(coordRoot, issue, agent);
  if (!existsSync(path)) return null;
  return parseActionFrontMatter(readFileSync(path, "utf8"));
}

/** Parse the complete file. Returns a 40-hex SHA or null. */
export function readComplete(coordRoot: string, issue: number, agent: string): string | null {
  const path = completePath(coordRoot, issue, agent);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  const match = raw.match(/^(?:commit\s+)?([a-f0-9]{40})$/);
  return match ? match[1] : null;
}

/** Clear the complete file after processing. */
export function clearComplete(coordRoot: string, issue: number, agent: string): void {
  const path = completePath(coordRoot, issue, agent);
  if (existsSync(path)) unlinkSync(path);
}

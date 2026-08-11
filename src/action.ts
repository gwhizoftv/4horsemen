import { join } from "node:path";
import { writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { ensureContained } from "./paths.js";

export type InternalAction = {
  actionId: string;
  agent: string;
  task: string;
  inputs: string[];
  requiredPath: string;
};

export const renderAction = (root: string, action: InternalAction): void => {
  const content = `# Action: ${action.actionId}
Agent: ${action.agent}
Required Path: ${action.requiredPath}

## Task
${action.task}

## Inputs
${action.inputs.map(i => `- ${i}`).join("\\n")}

## Completion
Write your commit SHA to ${join(root, "complete")}.
`;
  
  const actionFile = ensureContained(root, "action.md");
  writeFileSync(actionFile, content, "utf8");
};

export const readCompleteFile = (root: string): string | null => {
  const completeFile = ensureContained(root, "complete");
  if (!existsSync(completeFile)) {
    return null;
  }
  const content = readFileSync(completeFile, "utf8").trim();
  return content;
};

export const clearCompleteFile = (root: string): void => {
  const completeFile = ensureContained(root, "complete");
  if (existsSync(completeFile)) {
    rmSync(completeFile);
  }
};

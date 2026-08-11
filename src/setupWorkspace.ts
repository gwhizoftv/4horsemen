import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runArgv } from "./runLoop.js";

export type AgentConfig = {
  id: string;
  cloneRoot: string;
  launcher: string;
};

export type WorkspaceConfig = {
  productRoot: string;
  agents: AgentConfig[];
  verify?: { name: string; argv: string[] }[];
  checks?: { name: string; argv: string[] }[];
  workflowCriticalPrefixes: string[];
  stamp: {
    installRoot: string;
    version: string;
    commit: string;
  };
};

export const createAgentClone = async (productRoot: string, cloneRoot: string, remoteUrl: string): Promise<void> => {
  if (!existsSync(cloneRoot)) {
    const parent = dirname(cloneRoot);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
    await runArgv(["git", "clone", productRoot, cloneRoot], parent);
    if (remoteUrl) {
      await runArgv(["git", "remote", "set-url", "origin", remoteUrl], cloneRoot);
    }
  }
};

export const writeAgentExclude = (cloneRoot: string, agentId: string, ignores: string[]): void => {
  const excludePath = join(cloneRoot, ".git", "info", "exclude");
  if (!existsSync(excludePath)) return;
  const content = `\n# ${agentId} agent-local files added by setup\ntags\ndirectory_tree.md\n.plans/\n.signals/\n.code-reviews/\n.amendments/\n.escalations/\nstart-*.sh\n` + ignores.join("\n") + "\n";
  appendFileSync(excludePath, content, "utf8");
};

export const setAgentGitConfig = async (cloneRoot: string, installRoot: string, agentId: string): Promise<void> => {
  await runArgv(["git", "config", "coord.installRoot", installRoot], cloneRoot);
  await runArgv(["git", "config", "consensus.agentId", agentId], cloneRoot);
  const label = agentId.charAt(0).toUpperCase() + agentId.slice(1);
  await runArgv(["git", "config", "consensus.agentLabel", label], cloneRoot);
};

export const writeWorkspaceConfig = (coordRoot: string, config: WorkspaceConfig): void => {
  if (!existsSync(coordRoot)) mkdirSync(coordRoot, { recursive: true });
  writeFileSync(join(coordRoot, "workspace.json"), JSON.stringify(config, null, 2), "utf8");
};

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { writeProductIgnore, removeProductIgnore } from "./productIgnore.js";
import { installShims, installVendorCopies, clearHooks } from "./hookSync.js";
import { createAgentClone, writeAgentExclude, setAgentGitConfig, writeWorkspaceConfig, type WorkspaceConfig } from "./setupWorkspace.js";

export type InstallOptions = {
  productRoot: string;
  coordRoot: string;
  agents: string[];
  writeProduct?: boolean;
  vendor?: boolean;
  cloneRoot?: string;
};

export const install = async (options: InstallOptions): Promise<void> => {
  const productRoot = resolve(options.productRoot);
  const coordRoot = resolve(options.coordRoot);
  const cloneRootBase = options.cloneRoot ? resolve(options.cloneRoot) : dirname(productRoot);
  const productName = productRoot.split('/').pop() || "product";

  if (options.writeProduct) {
    writeProductIgnore(productRoot, [
      ".plans/",
      ".signals/",
      ".code-reviews/",
      ".amendments/",
      ".escalations/",
      "start-*.sh"
    ].join("\n"));
  }

  const workspaceConfig: WorkspaceConfig = {
    productRoot,
    agents: [],
    workflowCriticalPrefixes: [".plans/", ".signals/", ".code-reviews/", ".amendments/", ".escalations/"],
    stamp: {
      installRoot: coordRoot,
      version: "1.0.0",
      commit: "unknown" // In a real implementation this would resolve the coordinator commit
    }
  };

  for (const agent of options.agents) {
    const cloneRoot = join(cloneRootBase, `${productName}-${agent}`);
    await createAgentClone(productRoot, cloneRoot, "");
    writeAgentExclude(cloneRoot, agent, []);
    await setAgentGitConfig(cloneRoot, coordRoot, agent);
    
    if (options.vendor) {
      installVendorCopies(cloneRoot);
    } else {
      installShims(cloneRoot);
    }

    const launcherPath = join(cloneRoot, `start-${agent}.sh`);
    writeFileSync(launcherPath, `#!/bin/bash\n# Launcher for ${agent}\n`, { mode: 0o755 });
    
    workspaceConfig.agents.push({
      id: agent,
      cloneRoot,
      launcher: `start-${agent}.sh`
    });
  }

  writeWorkspaceConfig(coordRoot, workspaceConfig);
  console.log(`Installed coordination to ${coordRoot}`);
};

export type UninstallOptions = {
  productRoot: string;
  coordRoot: string;
  deleteClones?: boolean;
};

export const uninstall = async (options: UninstallOptions): Promise<void> => {
  const productRoot = resolve(options.productRoot);
  const coordRoot = resolve(options.coordRoot);
  
  removeProductIgnore(productRoot);
  
  const configPath = join(coordRoot, "workspace.json");
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as WorkspaceConfig;
    for (const agent of config.agents) {
      if (options.deleteClones) {
        rmSync(agent.cloneRoot, { recursive: true, force: true });
      } else {
        clearHooks(agent.cloneRoot);
      }
    }
  }
  
  console.log(`Uninstalled coordination from ${coordRoot}`);
};

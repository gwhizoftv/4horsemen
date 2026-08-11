import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runArgv } from "./runLoop.js";

export const doctor = async (coordRoot: string): Promise<number> => {
  const configPath = join(coordRoot, "workspace.json");
  if (!existsSync(configPath)) {
    console.error(`Missing workspace.json in coord-root: ${coordRoot}`);
    return 1;
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    console.error(`Malformed workspace.json: ${error}`);
    return 1;
  }

  if (!config.productRoot) {
    console.error("workspace.json missing productRoot");
    return 1;
  }

  let hasErrors = false;

  for (const agent of config.agents || []) {
    const gitConfigResult = await runArgv(["git", "config", "coord.installRoot"], agent.cloneRoot);
    if (gitConfigResult.exitCode !== 0) {
      console.error(`Agent clone ${agent.cloneRoot} is missing coord.installRoot in git config.`);
      hasErrors = true;
    } else {
      const installRoot = gitConfigResult.stdout.trim();
      if (installRoot !== resolve(coordRoot)) {
        console.error(`Agent clone ${agent.cloneRoot} coord.installRoot mismatch. Expected ${resolve(coordRoot)}, got ${installRoot}`);
        hasErrors = true;
      }
    }

    const identityResult = await runArgv(["git", "config", "consensus.agentId"], agent.cloneRoot);
    if (identityResult.exitCode !== 0) {
      console.error(`Agent clone ${agent.cloneRoot} is missing consensus.agentId in git config.`);
      hasErrors = true;
    } else {
      const id = identityResult.stdout.trim();
      if (id !== agent.id) {
        console.error(`Agent clone ${agent.cloneRoot} consensus.agentId mismatch. Expected ${agent.id}, got ${id}`);
        hasErrors = true;
      }
    }
  }

  if (hasErrors) return 1;

  console.log("Doctor check passed.");
  return 0;
};

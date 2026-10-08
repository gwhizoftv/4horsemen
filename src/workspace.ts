import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { localConfigGet, localConfigSet, localConfigUnset, worktreeRoot } from "./gitExec.js";
import { containedPath } from "./paths.js";
import { readConfig } from "./state.js";

export const OWNER_WORKSPACE_CONFIG_KEY = "coord.ownerWorkspaceConfig";

export type WorkspaceLocation = {
  coordRoot: string;
  workspaceRoot: string;
  configPath: string;
  layout: "flat" | "nested";
};

const assertProject = (project: string): void => {
  if (!/^[A-Za-z0-9._-]+$/.test(project)) throw new Error(`Invalid project name '${project}'.`);
};

export const flatConfigPath = (coordRoot: string): string => containedPath(resolve(coordRoot), "config.json");

export const nestedWorkspaceRoot = (coordRoot: string, project: string): string => {
  assertProject(project);
  return containedPath(resolve(coordRoot), "workspaces", project);
};

export const nestedConfigPath = (coordRoot: string, project: string): string =>
  join(nestedWorkspaceRoot(coordRoot, project), "config.json");

const location = (coordRoot: string, project: string, layout: "flat" | "nested"): WorkspaceLocation => {
  const outer = resolve(coordRoot);
  const workspaceRoot = layout === "flat" ? outer : nestedWorkspaceRoot(outer, project);
  return { coordRoot: outer, workspaceRoot, configPath: join(workspaceRoot, "config.json"), layout };
};

const projectAt = (path: string): { kind: "valid"; project: string } | { kind: "invalid" } | { kind: "missing" } => {
  if (!existsSync(path)) return { kind: "missing" };
  try {
    return { kind: "valid", project: readConfig(path).project };
  } catch {
    return { kind: "invalid" };
  }
};

const sameExistingPath = (left: string, right: string): boolean => {
  try {
    return resolve(realpathSync(left)) === resolve(realpathSync(right));
  } catch {
    return false;
  }
};

const hasFlatRuntimeState = (coordRoot: string): boolean => {
  if (!existsSync(coordRoot)) return false;
  return readdirSync(coordRoot).some((entry) => entry === "mirror.git" || /^issue-[1-9][0-9]*$/.test(entry));
};

/** Issue numbers with runtime directories under this workspace root. */
export const listIssueNumbersInWorkspace = (workspaceRoot: string): number[] => {
  if (!existsSync(workspaceRoot)) return [];
  const issues: number[] = [];
  for (const entry of readdirSync(workspaceRoot)) {
    const matched = entry.match(/^issue-([1-9][0-9]*)$/);
    if (matched?.[1] !== undefined) issues.push(Number(matched[1]));
  }
  return issues.sort((left, right) => left - right);
};

/** Resolve an installed config, preferring a matching flat workspace. */
export const resolveWorkspaceLocation = (
  coordRoot: string,
  project: string,
  options: { acceptUnreadableFlat?: boolean } = {}
): WorkspaceLocation | null => {
  assertProject(project);
  const flat = location(coordRoot, project, "flat");
  const flatProject = projectAt(flat.configPath);
  if (flatProject.kind === "valid" && flatProject.project === project) return flat;

  const nested = location(coordRoot, project, "nested");
  if (existsSync(nested.configPath)) return nested;

  // Doctor explicitly opts in so it can classify the broken config. Mutating
  // callers must not adopt an unreadable flat slot as the requested product.
  if (flatProject.kind === "invalid" && options.acceptUnreadableFlat === true) return flat;
  return null;
};

/** Select the stable write target without replacing another product's flat slot. */
export const selectWorkspaceLocation = (coordRoot: string, project: string): WorkspaceLocation => {
  assertProject(project);
  const flat = location(coordRoot, project, "flat");
  const flatProject = projectAt(flat.configPath);
  if (flatProject.kind === "valid" && flatProject.project === project) return flat;

  const nested = location(coordRoot, project, "nested");
  if (existsSync(nested.configPath)) return nested;
  if (flatProject.kind !== "missing") return nested;
  if (hasFlatRuntimeState(resolve(coordRoot))) return nested;

  const workspaces = containedPath(resolve(coordRoot), "workspaces");
  if (existsSync(workspaces)) {
    const occupied = readdirSync(workspaces, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && existsSync(join(workspaces, entry.name, "config.json"))
    );
    if (occupied) return location(coordRoot, project, "nested");
  }
  return flat;
};

export const workspaceLocationFromConfig = (configPath: string): WorkspaceLocation => {
  const absolute = resolve(configPath);
  const config = readConfig(absolute);
  const workspaceRoot = dirname(absolute);
  const parent = dirname(workspaceRoot);
  if (basename(parent) === "workspaces" && basename(workspaceRoot) === config.project) {
    return { coordRoot: dirname(parent), workspaceRoot, configPath: absolute, layout: "nested" };
  }
  return { coordRoot: workspaceRoot, workspaceRoot, configPath: absolute, layout: "flat" };
};

export const recordOwnerWorkspace = (productRoot: string, configPath: string): void => {
  const root = worktreeRoot(resolve(productRoot));
  if (root === null) throw new Error(`${productRoot} is not a Git worktree.`);
  const config = readConfig(resolve(configPath));
  if (config.coordination === undefined || !sameExistingPath(config.coordination.productRoot, root)) {
    throw new Error(`Workspace config ${configPath} is not installed for repository ${root}.`);
  }
  localConfigSet(productRoot, OWNER_WORKSPACE_CONFIG_KEY, resolve(configPath));
};

export const clearOwnerWorkspace = (productRoot: string, configPath: string): void => {
  const configured = localConfigGet(productRoot, OWNER_WORKSPACE_CONFIG_KEY);
  if (
    configured !== null &&
    (resolve(configured) === resolve(configPath) ||
      (isAbsolute(configured) && existsSync(configured) && existsSync(configPath) && sameExistingPath(configured, configPath)))
  ) {
    localConfigUnset(productRoot, OWNER_WORKSPACE_CONFIG_KEY);
  }
};

export const clearOwnerWorkspaceLocator = (productRoot: string): void => {
  if (localConfigGet(productRoot, OWNER_WORKSPACE_CONFIG_KEY) !== null) {
    localConfigUnset(productRoot, OWNER_WORKSPACE_CONFIG_KEY);
  }
};

export const resolveWorkspaceFromProduct = (productOrClone: string): WorkspaceLocation => {
  const root = worktreeRoot(resolve(productOrClone));
  if (root === null) {
    throw new Error(`${productOrClone} is not inside a Git repository. Run coord from your onboarded repository, ` +
      "or pass --product <repository-path> (or --coord-root <runtime-path>).");
  }
  const configured = localConfigGet(root, OWNER_WORKSPACE_CONFIG_KEY);
  if (configured === null) {
    throw new Error(
      `${root} is not onboarded in this worktree, so it is not a repository coord knows. Run \`coord onboard ${root}\` once, ` +
        "or pass --product <repository-path> for a repository that is already onboarded."
    );
  }
  if (!isAbsolute(configured) || !existsSync(configured)) {
    throw new Error(
      `${OWNER_WORKSPACE_CONFIG_KEY} points at missing workspace config '${configured}'. Re-run \`coord onboard ${root}\`.`
    );
  }
  const config = readConfig(configured);
  if (config.coordination === undefined || !sameExistingPath(config.coordination.productRoot, root)) {
    throw new Error(
      `${OWNER_WORKSPACE_CONFIG_KEY} points at a workspace for another repository. Re-run \`coord onboard ${root}\`.`
    );
  }
  return workspaceLocationFromConfig(configured);
};

/**
 * The workspace for the Git worktree containing `path`: the owner's onboarded
 * repository, or a registered agent clone whose locator, identity and canonical
 * root all match the config. Stale, crossed or ambiguous locators are refused;
 * nothing else is scanned or guessed.
 */
export const resolveWorkspaceFromWorktree = (path: string, agentLocatorKey: string): WorkspaceLocation => {
  const root = worktreeRoot(resolve(path));
  if (root === null) return resolveWorkspaceFromProduct(path);
  const owner = localConfigGet(root, OWNER_WORKSPACE_CONFIG_KEY);
  const agentConfig = localConfigGet(root, agentLocatorKey);
  if (agentConfig === null) return resolveWorkspaceFromProduct(root);
  if (!isAbsolute(agentConfig) || !existsSync(agentConfig)) {
    throw new Error(`${agentLocatorKey} in ${root} points at missing workspace config '${agentConfig}'. Re-run coord install.`);
  }
  if (owner !== null && !(isAbsolute(owner) && existsSync(owner) && sameExistingPath(owner, agentConfig))) {
    throw new Error(`${root} has both an owner and an agent workspace locator for different workspaces; ` +
      "pass --product <repository-path> or --coord-root <runtime-path>.");
  }
  const config = readConfig(agentConfig);
  const agentId = localConfigGet(root, "consensus.agentId");
  const registered = config.agents.some((agent) =>
    agent.id === agentId && sameExistingPath(resolve(dirname(agentConfig), agent.root), root));
  if (!registered) {
    throw new Error(`${root} is not the registered clone for agent '${agentId ?? "(unset)"}' in ${agentConfig}; ` +
      "pass --product <repository-path> or --coord-root <runtime-path>.");
  }
  return workspaceLocationFromConfig(agentConfig);
};

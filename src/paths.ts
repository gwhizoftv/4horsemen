import { lstatSync, mkdirSync, realpathSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep, join } from "node:path";
import { homedir } from "node:os";

export class PathSafetyError extends Error {
  override readonly name = "PathSafetyError";
}

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const nearestExistingRealPath = (input: string): string => {
  let candidate = resolve(input);
  const suffix: string[] = [];

  while (true) {
    try {
      if (lstatSync(candidate).isSymbolicLink()) {
        throw new PathSafetyError(`Refusing symlink in coordinator runtime path: ${candidate}`);
      }
      return resolve(realpathSync(candidate), ...suffix.reverse());
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new PathSafetyError(`No existing parent could be resolved for ${input}.`);
      }
      suffix.push(candidate.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      candidate = parent;
    }
  }
};

export const isPathInside = (parent: string, child: string): boolean => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

export const containedPath = (root: string, ...parts: readonly string[]): string => {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, ...parts);
  if (!isPathInside(resolvedRoot, candidate)) {
    throw new PathSafetyError(`Refusing path outside coordinator root: ${candidate}`);
  }
  return candidate;
};

/** Reject an existing symlink at or below root on the way to candidate. */
export const assertNoSymlink = (root: string, candidate: string): void => {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = containedPath(resolvedRoot, relative(resolvedRoot, resolve(candidate)));
  const rel = relative(resolvedRoot, resolvedCandidate);
  const paths = [resolvedRoot];
  if (rel !== "") {
    let current = resolvedRoot;
    for (const component of rel.split(sep)) {
      current = resolve(current, component);
      paths.push(current);
    }
  }

  for (const path of paths) {
    try {
      if (lstatSync(path).isSymbolicLink()) {
        throw new PathSafetyError(`Refusing symlink in coordinator runtime path: ${path}`);
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }
};

export type SafeCoordRootOptions = {
  coordRoot: string;
  agentRoots: readonly string[];
  create?: boolean;
};

/** Resolve and validate the owner runtime root before the first state write. */
export const resolveSafeCoordRoot = (options: SafeCoordRootOptions): string => {
  const requested = resolve(options.coordRoot);
  assertNoSymlink(requested, requested);
  const coordReal = nearestExistingRealPath(requested);

  for (const agentRoot of options.agentRoots) {
    const agentReal = nearestExistingRealPath(agentRoot);
    if (isPathInside(agentReal, coordReal) || isPathInside(coordReal, agentReal)) {
      throw new PathSafetyError(
        `Coordinator root ${coordReal} overlaps configured agent clone ${agentReal}. Choose an external owner-controlled path.`
      );
    }
  }

  if (options.create === true) {
    mkdirSync(requested, { recursive: true, mode: 0o700 });
    assertNoSymlink(requested, requested);
  }
  return requested;
};

export type IssueRuntimePaths = {
  coordRoot: string;
  mirror: string;
  issueRoot: string;
  start: string;
  cursors: string;
  journal: string;
  agents: string;
};

export type WorkspaceLocation = {
  coordRoot: string;
  workspaceRoot: string;
  configPath: string;
};

export const resolveWorkspaceLocation = (coordRoot: string, project: string): WorkspaceLocation => {
  const root = resolve(coordRoot);
  const flatConfig = containedPath(root, "config.json");
  const nestedWorkspace = containedPath(root, "workspaces", project);
  const nestedConfig = containedPath(nestedWorkspace, "config.json");

  let flatExists = false;
  try {
    flatExists = lstatSync(flatConfig).isFile();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  let nestedExists = false;
  try {
    nestedExists = lstatSync(nestedConfig).isFile();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  let hasOtherWorkspaces = false;
  try {
    const workspacesDir = containedPath(root, "workspaces");
    hasOtherWorkspaces = lstatSync(workspacesDir).isDirectory();
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  if (flatExists && nestedExists) {
    throw new PathSafetyError(`Ambiguous workspace layout: found both ${flatConfig} and ${nestedConfig}. Please remove one.`);
  }

  if (flatExists) {
    return {
      coordRoot: root,
      workspaceRoot: root,
      configPath: flatConfig
    };
  }

  if (nestedExists) {
    return {
      coordRoot: root,
      workspaceRoot: nestedWorkspace,
      configPath: nestedConfig
    };
  }

  // If neither exists, decide which to create
  if (hasOtherWorkspaces) {
    return {
      coordRoot: root,
      workspaceRoot: nestedWorkspace,
      configPath: nestedConfig
    };
  } else {
    return {
      coordRoot: root,
      workspaceRoot: root,
      configPath: flatConfig
    };
  }
};

export const issueRuntimePaths = (workspace: WorkspaceLocation, issue: number): IssueRuntimePaths => {
  if (!Number.isInteger(issue) || issue < 1) {
    throw new PathSafetyError("Issue must be a positive integer.");
  }
  const root = resolve(workspace.workspaceRoot);
  const issueRoot = containedPath(root, `issue-${issue}`);
  return {
    coordRoot: resolve(workspace.coordRoot),
    mirror: containedPath(root, "mirror.git"),
    issueRoot,
    start: containedPath(issueRoot, "start.json"),
    cursors: containedPath(issueRoot, "cursors.json"),
    journal: containedPath(issueRoot, "journal.jsonl"),
    agents: containedPath(issueRoot, "agents")
  };
};

export type AgentRuntimePaths = {
  root: string;
  action: string;
  complete: string;
  renderLog: string;
};

const agentPattern = /^[a-z][a-z0-9-]{0,63}$/;

export const agentRuntimePaths = (paths: IssueRuntimePaths, agent: string): AgentRuntimePaths => {
  if (!agentPattern.test(agent)) {
    throw new PathSafetyError(`Invalid agent id: ${agent}`);
  }
  const root = containedPath(paths.agents, agent);
  return {
    root,
    action: containedPath(root, "action.md"),
    complete: containedPath(root, "complete"),
    renderLog: containedPath(root, "render.log")
  };
};

export const createIssueRuntime = (paths: IssueRuntimePaths, agents: readonly string[]): void => {
  assertNoSymlink(paths.coordRoot, paths.issueRoot);
  mkdirSync(paths.issueRoot, { recursive: true, mode: 0o700 });
  assertNoSymlink(paths.coordRoot, paths.issueRoot);
  assertNoSymlink(paths.coordRoot, paths.agents);
  mkdirSync(paths.agents, { recursive: true, mode: 0o700 });
  assertNoSymlink(paths.coordRoot, paths.agents);
  for (const agent of agents) {
    const runtime = agentRuntimePaths(paths, agent);
    assertNoSymlink(paths.coordRoot, runtime.root);
    mkdirSync(runtime.root, { recursive: true, mode: 0o700 });
    assertNoSymlink(paths.coordRoot, runtime.root);
  }
};

export type ProductRegistry = Record<string, { configPath: string; profile: string }>;

export const getRegistryPath = (): string => process.env.COORD_TEST_REGISTRY || join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "coordination", "registry.json");

export const readRegistry = (): ProductRegistry => {
  const path = getRegistryPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ProductRegistry;
  } catch {
    return {};
  }
};

export const writeRegistry = (registry: ProductRegistry): void => {
  const path = getRegistryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(registry, null, 2) + "\n", "utf8");
};

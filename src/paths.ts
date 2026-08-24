import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

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
  tmuxNamespace: string | null;
  /**
   * Stable short id for this workspace root. Always set (flat and nested) so
   * Terminal window titles for the same issue number cannot collide across
   * products sharing one outer coord-runtime.
   */
  terminalGroup: string;
  mirror: string;
  issueRoot: string;
  start: string;
  cursors: string;
  /** CLI lifecycle observations; deliberately separate from workflow authority. */
  agentLifecycle: string;
  journal: string;
  issueSnapshot: string;
  agents: string;
  issue: number;
  /** Sibling mailbox root; completion SHAs live here, not beside action.md. */
  completesRoot: string;
};

/** Default mailbox: sibling of coord-root named `completes`. */
export const defaultCompletesRoot = (coordRoot: string): string => resolve(dirname(resolve(coordRoot)), "completes");

export type SafeCompletesRootOptions = {
  coordRoot: string;
  completesRoot?: string;
  agentRoots?: readonly string[];
  create?: boolean;
};

/** Resolve the agent completion mailbox; it must not overlap coord-root or clones. */
export const resolveSafeCompletesRoot = (options: SafeCompletesRootOptions): string => {
  const coordReal = nearestExistingRealPath(options.coordRoot);
  const requested = resolve(options.completesRoot ?? defaultCompletesRoot(options.coordRoot));
  assertNoSymlink(requested, requested);
  const completesReal = nearestExistingRealPath(requested);
  if (isPathInside(coordReal, completesReal) || isPathInside(completesReal, coordReal)) {
    throw new PathSafetyError(
      `Completes root ${completesReal} overlaps coordinator root ${coordReal}. Choose a sibling mailbox.`
    );
  }
  for (const agentRoot of options.agentRoots ?? []) {
    const agentReal = nearestExistingRealPath(agentRoot);
    if (isPathInside(agentReal, completesReal) || isPathInside(completesReal, agentReal)) {
      throw new PathSafetyError(
        `Completes root ${completesReal} overlaps configured agent clone ${agentReal}.`
      );
    }
  }
  if (options.create === true) {
    mkdirSync(requested, { recursive: true, mode: 0o700 });
    assertNoSymlink(requested, requested);
  }
  return requested;
};

export const issueCompletesDir = (paths: IssueRuntimePaths): string =>
  containedPath(paths.completesRoot, `issue-${paths.issue}`);

/** Short stable fingerprint of a workspace root for Terminal title grouping. */
export const workspaceTerminalGroup = (coordRoot: string): string =>
  createHash("sha256").update(resolve(coordRoot)).digest("hex").slice(0, 10);

export const issueRuntimePaths = (coordRoot: string, issue: number, completesRoot?: string): IssueRuntimePaths => {
  if (!Number.isInteger(issue) || issue < 1) {
    throw new PathSafetyError("Issue must be a positive integer.");
  }
  const root = resolve(coordRoot);
  const issueRoot = containedPath(root, `issue-${issue}`);
  const terminalGroup = workspaceTerminalGroup(root);
  const mailbox = resolve(completesRoot ?? defaultCompletesRoot(root));
  return {
    coordRoot: root,
    // Nested workspaces also namespace tmux sessions; flat keeps legacy coord-N.
    tmuxNamespace: basename(dirname(root)) === "workspaces" ? terminalGroup : null,
    terminalGroup,
    mirror: containedPath(root, "mirror.git"),
    issueRoot,
    start: containedPath(issueRoot, "start.json"),
    cursors: containedPath(issueRoot, "cursors.json"),
    agentLifecycle: containedPath(issueRoot, "agent-lifecycle.json"),
    journal: containedPath(issueRoot, "journal.jsonl"),
    issueSnapshot: containedPath(issueRoot, "github-issue.json"),
    agents: containedPath(issueRoot, "agents"),
    issue,
    completesRoot: mailbox
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
  const completeDir = containedPath(issueCompletesDir(paths), agent);
  return {
    root,
    action: containedPath(root, "action.md"),
    complete: containedPath(completeDir, "complete"),
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
  mkdirSync(paths.completesRoot, { recursive: true, mode: 0o700 });
  assertNoSymlink(paths.completesRoot, paths.completesRoot);
  const mailboxIssue = issueCompletesDir(paths);
  assertNoSymlink(paths.completesRoot, mailboxIssue);
  mkdirSync(mailboxIssue, { recursive: true, mode: 0o700 });
  assertNoSymlink(paths.completesRoot, mailboxIssue);
  for (const agent of agents) {
    const runtime = agentRuntimePaths(paths, agent);
    assertNoSymlink(paths.coordRoot, runtime.root);
    mkdirSync(runtime.root, { recursive: true, mode: 0o700 });
    assertNoSymlink(paths.coordRoot, runtime.root);
    const completeDir = dirname(runtime.complete);
    assertNoSymlink(paths.completesRoot, completeDir);
    mkdirSync(completeDir, { recursive: true, mode: 0o700 });
    assertNoSymlink(paths.completesRoot, completeDir);
  }
};

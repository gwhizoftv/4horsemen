import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * The completion mailbox: a third tree that is a sibling of both the agent
 * clones and the coordinator runtime.
 *
 * Agents write `complete` and its advisory `ready` sibling. Leaving them beside
 * `action.md` forced every harness to hold a writable grant on the whole coord
 * root, which also holds `cursors.json`, `journal.jsonl`, and every peer's
 * order. Codex ran `--sandbox danger-full-access` for exactly that reason. The
 * mailbox is granted per issue and per agent, so a harness can publish its SHA
 * without reaching coordinator state or a peer's receipt.
 */
/**
 * Sibling `completes/`, then one segment identifying the workspace whose
 * receipts live under it.
 *
 * The mailbox is a *sibling* of the runtime directory so granting it never grants
 * coordinator state — that is the whole point of the third tree. Under that
 * sibling comes one segment naming the runtime, and the project too when the
 * workspace is nested.
 *
 * The naming segment was tried both ways. A bare `completes/` matches the
 * topology sketched on the issue, but `dirname(coordRoot)` is shared by every
 * runtime under one parent, so two workspaces resolve
 * `issue-42/claude/complete` to one file: last writer wins, and each
 * coordinator reads the other product's SHA as its own agent's intent. That is
 * not a corner case here — the repository's own fixtures mkdtemp every coord
 * root into one parent, and dropping the segment makes suites that never touch
 * this feature fail. `assertMailboxClaim` still guards the case a path cannot
 * separate: an explicitly configured root that another live workspace owns.
 */
export const defaultCompletesRoot = (coordRoot: string, workspaceName?: string): string => {
  const root = resolve(coordRoot);
  const identity = workspaceName === undefined ? [basename(root)] : [basename(root), workspaceName];
  return resolve(dirname(root), "completes", ...identity);
};

/** Marker naming the workspace whose receipts a mailbox root holds. */
export const mailboxClaimPath = (completesRoot: string): string =>
  containedPath(completesRoot, ".coord-workspace.json");

export type MailboxClaim = { configPath: string };

const readMailboxClaim = (path: string): MailboxClaim | null => {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof value === "object" && value !== null && typeof (value as MailboxClaim).configPath === "string") {
      return { configPath: (value as MailboxClaim).configPath };
    }
  } catch {
    return null;
  }
  return null;
};

/**
 * Refuse a mailbox root another workspace already owns, and claim it otherwise.
 *
 * Two flat runtimes under one parent derive the same root. Without this they
 * both publish `issue-42/claude/complete` to one file: whichever agent writes
 * last wins, and each coordinator reads the other product's SHA as its own
 * agent's intent — a wrong commit on an unexpected branch, with nothing in the
 * error naming the cause. Failing at install, where the operator can still pass
 * `--completes-root`, is the only point where that is cheap.
 *
 * The marker sits at the mailbox root. Agents are granted `issue-<n>/<agent>`
 * only, so it is outside every grant this design hands out.
 */
export const assertMailboxClaim = (input: {
  completesRoot: string;
  configPath: string;
  write: boolean;
}): void => {
  const claimPath = mailboxClaimPath(input.completesRoot);
  const existing = readMailboxClaim(claimPath);
  const owner = resolve(input.configPath);
  // A claim whose workspace config no longer exists is stale — that workspace
  // was uninstalled or deleted — so the mailbox is free. Only a claim held by a
  // workspace that still exists can conflict, which is the case where two live
  // products would actually write one receipt file.
  const heldByLiveWorkspace = existing !== null && existsSync(existing.configPath);
  if (heldByLiveWorkspace && resolve((existing as MailboxClaim).configPath) !== owner) {
    throw new PathSafetyError(
      `Completion mailbox ${resolve(input.completesRoot)} already holds receipts for ${(existing as MailboxClaim).configPath}. ` +
        "Two workspaces sharing one mailbox would overwrite each other's completion SHAs. " +
        "Re-run with --completes-root <path> to give this workspace its own."
    );
  }
  if (!input.write) return;
  if (existing !== null && resolve(existing.configPath) === owner) return;
  assertNoSymlink(input.completesRoot, claimPath);
  writeFileSync(claimPath, `${JSON.stringify({ configPath: owner }, null, 2)}\n`, { mode: 0o600 });
};

export type SafeCompletesRootOptions = {
  completesRoot: string;
  coordRoot: string;
  agentRoots?: readonly string[];
  create?: boolean;
};

/**
 * Resolve and validate the mailbox root. Unlike the runtime directory, this tree has
 * directories inside it that agents can write, so the containment checks matter
 * more here rather than less: a symlinked component would let a receipt write
 * land anywhere the coordinator later reads as intent.
 */
export const resolveSafeCompletesRoot = (options: SafeCompletesRootOptions): string => {
  const requested = resolve(options.completesRoot);
  assertNoSymlink(requested, requested);
  const completesReal = nearestExistingRealPath(requested);
  const coordReal = nearestExistingRealPath(options.coordRoot);

  if (isPathInside(coordReal, completesReal) || isPathInside(completesReal, coordReal)) {
    throw new PathSafetyError(
      `Completion mailbox ${completesReal} overlaps the coordinator runtime ${coordReal}. ` +
        "Granting the mailbox would grant coordinator state; choose a separate sibling path."
    );
  }

  for (const agentRoot of options.agentRoots ?? []) {
    const agentReal = nearestExistingRealPath(agentRoot);
    if (isPathInside(agentReal, completesReal) || isPathInside(completesReal, agentReal)) {
      throw new PathSafetyError(
        `Completion mailbox ${completesReal} overlaps configured agent clone ${agentReal}. ` +
          "The mailbox must sit outside every clone."
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
  /**
   * Coordination artifacts the current action binds, exported from the mirror
   * so agents read files instead of fetching peer blobs. Content-addressed and
   * immutable once written.
   */
  issueInputsRoot: string;
  /** Detached worktrees at bound product pins, one per distinct pin. */
  issueWorktreesRoot: string;
  /** Issue number, retained because the mailbox path is derived from it. */
  issue: number;
  /** Root of the completion mailbox tree; never inside `coordRoot`. */
  completesRoot: string;
  /** This issue's mailbox subtree: one directory per agent lives under it. */
  completesIssueRoot: string;
};

/** Short stable fingerprint of a workspace root for Terminal title grouping. */
export const workspaceTerminalGroup = (coordRoot: string): string =>
  createHash("sha256").update(resolve(coordRoot)).digest("hex").slice(0, 10);

export const issueRuntimePaths = (
  coordRoot: string,
  issue: number,
  completesRoot?: string
): IssueRuntimePaths => {
  if (!Number.isInteger(issue) || issue < 1) {
    throw new PathSafetyError("Issue must be a positive integer.");
  }
  const root = resolve(coordRoot);
  const issueRoot = containedPath(root, `issue-${issue}`);
  const terminalGroup = workspaceTerminalGroup(root);
  // Derived only when the caller has no configured root. Every path that must
  // survive an issue (start.json, resume, wipe) passes the persisted value.
  const mailbox = resolve(completesRoot ?? defaultCompletesRoot(root));
  if (isPathInside(root, mailbox) || isPathInside(mailbox, root)) {
    throw new PathSafetyError(
      `Completion mailbox ${mailbox} overlaps the coordinator runtime ${root}.`
    );
  }
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
    issueInputsRoot: containedPath(issueRoot, "inputs"),
    issueWorktreesRoot: containedPath(issueRoot, "worktrees"),
    issue,
    completesRoot: mailbox,
    completesIssueRoot: containedPath(mailbox, `issue-${issue}`)
  };
};

export type AgentRuntimePaths = {
  root: string;
  action: string;
  complete: string;
  ready: string;
  renderLog: string;
  /**
   * The directory holding `complete`, and the exact path a harness is granted.
   * Separate from `root`: the order is coordinator-owned, the receipt is not.
   */
  completeDir: string;
  /** Agent-writable ballot response directory under the issue runtime. */
  responsesDir: string;
};

const agentPattern = /^[a-z][a-z0-9-]{0,63}$/;
const actionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const RESERVED_EVIDENCE_AGENT = "coordinator-evidence";

/** Readiness uses the same per-agent writable drop as completion. */
export const readyReceiptPath = (completePath: string): string => containedPath(dirname(completePath), "ready");

export const agentRuntimePaths = (paths: IssueRuntimePaths, agent: string): AgentRuntimePaths => {
  if (!agentPattern.test(agent)) {
    throw new PathSafetyError(`Invalid agent id: ${agent}`);
  }
  const root = containedPath(paths.agents, agent);
  const completeDir = containedPath(paths.completesIssueRoot, agent);
  return {
    root,
    action: containedPath(root, "action.md"),
    // The receipt leaves the runtime directory; the order and the log do not.
    complete: containedPath(completeDir, "complete"),
    ready: readyReceiptPath(containedPath(completeDir, "complete")),
    renderLog: containedPath(root, "render.log"),
    completeDir,
    responsesDir: containedPath(root, "responses")
  };
};

export const agentResponsePath = (paths: IssueRuntimePaths, agent: string, actionId: string): string => {
  if (!actionIdPattern.test(actionId)) {
    throw new PathSafetyError(`Invalid action id for response path: ${actionId}`);
  }
  const runtime = agentRuntimePaths(paths, agent);
  return containedPath(runtime.responsesDir, `${actionId}.json`);
};

export const acceptedResponseArchivePath = (
  paths: IssueRuntimePaths,
  agent: string,
  actionId: string
): string => {
  if (!agentPattern.test(agent)) {
    throw new PathSafetyError(`Invalid agent id: ${agent}`);
  }
  if (!actionIdPattern.test(actionId)) {
    throw new PathSafetyError(`Invalid action id for archive path: ${actionId}`);
  }
  return containedPath(paths.issueRoot, "accepted-responses", agent, `${actionId}.json`);
};

export const evidenceWorktreePath = (paths: IssueRuntimePaths, label: string): string => {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(label)) {
    throw new PathSafetyError(`Invalid evidence worktree label: ${label}`);
  }
  return containedPath(paths.issueRoot, "evidence-worktrees", label);
};

/**
 * One immutable packet of bound coordination artifacts, named by the hash of
 * the input set it holds. Content addressing is what makes re-preparing the
 * same action a no-op rather than a rewrite.
 */
export const inputPacketPath = (paths: IssueRuntimePaths, inputSetHash: string): string => {
  if (!/^[0-9a-f]{64}$/.test(inputSetHash)) {
    throw new PathSafetyError(`Invalid input set hash: ${inputSetHash}`);
  }
  return containedPath(paths.issueInputsRoot, inputSetHash);
};

/**
 * One detached worktree at a bound product pin. The directory label is short
 * for legibility, but the full SHA is what the manifest and the action cite;
 * callers must verify the checked-out commit rather than trusting the label.
 */
export const inputWorktreePath = (paths: IssueRuntimePaths, agent: string, sha: string): string => {
  if (!agentPattern.test(agent)) throw new PathSafetyError(`Invalid agent id: ${agent}`);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new PathSafetyError(`Invalid pin for a worktree path: ${sha}`);
  return containedPath(paths.issueWorktreesRoot, `${agent}-${sha.slice(0, 8)}`);
};

export const createIssueRuntime = (paths: IssueRuntimePaths, agents: readonly string[]): void => {
  assertNoSymlink(paths.coordRoot, paths.issueRoot);
  mkdirSync(paths.issueRoot, { recursive: true, mode: 0o700 });
  assertNoSymlink(paths.coordRoot, paths.issueRoot);
  assertNoSymlink(paths.coordRoot, paths.agents);
  mkdirSync(paths.agents, { recursive: true, mode: 0o700 });
  assertNoSymlink(paths.coordRoot, paths.agents);
  const acceptedRoot = containedPath(paths.issueRoot, "accepted-responses");
  assertNoSymlink(paths.coordRoot, acceptedRoot);
  mkdirSync(acceptedRoot, { recursive: true, mode: 0o700 });
  assertNoSymlink(paths.coordRoot, acceptedRoot);
  // Created up front, empty, because the launcher resolves its grants once when
  // the harness starts and a directory that appears later can never reach the
  // running process.
  for (const materialized of [paths.issueInputsRoot, paths.issueWorktreesRoot]) {
    assertNoSymlink(paths.coordRoot, materialized);
    mkdirSync(materialized, { recursive: true, mode: 0o700 });
    assertNoSymlink(paths.coordRoot, materialized);
  }
  assertNoSymlink(paths.completesRoot, paths.completesIssueRoot);
  mkdirSync(paths.completesIssueRoot, { recursive: true, mode: 0o700 });
  assertNoSymlink(paths.completesRoot, paths.completesIssueRoot);
  for (const agent of agents) {
    if (agent === RESERVED_EVIDENCE_AGENT) {
      throw new PathSafetyError(`Agent id ${RESERVED_EVIDENCE_AGENT} is reserved for the evidence branch.`);
    }
    const runtime = agentRuntimePaths(paths, agent);
    assertNoSymlink(paths.coordRoot, runtime.root);
    mkdirSync(runtime.root, { recursive: true, mode: 0o700 });
    assertNoSymlink(paths.coordRoot, runtime.root);
    assertNoSymlink(paths.coordRoot, runtime.responsesDir);
    mkdirSync(runtime.responsesDir, { recursive: true, mode: 0o700 });
    assertNoSymlink(paths.coordRoot, runtime.responsesDir);
    // Checked against the mailbox root, not the runtime directory: the two trees are
    // deliberately disjoint, so containment must be asserted within each.
    assertNoSymlink(paths.completesRoot, runtime.completeDir);
    mkdirSync(runtime.completeDir, { recursive: true, mode: 0o700 });
    assertNoSymlink(paths.completesRoot, runtime.completeDir);
  }
};

/**
 * Remove this issue's mailbox subtree. Separate from the coord-runtime teardown
 * because the two trees fail independently: a stale receipt left behind is read
 * as completion intent by a later run that reuses the issue number.
 */
export const removeIssueMailbox = (paths: IssueRuntimePaths): boolean => {
  if (!existsSync(paths.completesIssueRoot)) return false;
  assertNoSymlink(paths.completesRoot, paths.completesIssueRoot);
  rmSync(paths.completesIssueRoot, { recursive: true, force: true });
  return true;
};

export type ResourceBindingPaths = { root: string; record: string; lock: string };

/**
 * Owner-runtime record that serializes Codex quota reads for one
 * home/account binding across every issue under this runtime directory (#140). The
 * key is a digest, so neither the home path nor the account id is exposed in
 * a file name.
 */
export const resourceBindingPaths = (coordRoot: string, codexHome: string, accountId: string): ResourceBindingPaths => {
  const key = createHash("sha256").update(`${resolve(codexHome)}\0${accountId}`).digest("hex").slice(0, 32);
  const root = containedPath(coordRoot, "resource-bindings");
  return { root, record: containedPath(root, `codex-${key}.json`), lock: containedPath(root, `codex-${key}.json.lock`) };
};

import { spawnSync } from "node:child_process";
import type { TmuxRunner, OwnerTerminalCloser, TmuxResult, SessionKey } from "./tmux.js";
import {
  closeDarwinTerminalWindows,
  MANUAL_SESSION_KEY,
  ownerSessionName,
  ownerTerminalTitlesToClose,
  TmuxController
} from "./tmux.js";
import { platform } from "node:os";

export type DetachIssueLogger = (message: string) => void;

/** Vitest sets this; refuse live owner-UI side effects so unit tests cannot kill dogfood sessions. */
const underVitest = (): boolean => process.env.VITEST !== undefined;

const vitestNoopTmuxRunner: TmuxRunner = async (): Promise<TmuxResult> => ({
  exitCode: 0,
  stdout: "",
  stderr: ""
});

const resolveTmuxRunner = (injected: TmuxRunner | undefined): TmuxRunner | undefined => {
  if (injected !== undefined) return injected;
  // Default runner would spawn real tmux; never do that from the test suite.
  return underVitest() ? vitestNoopTmuxRunner : undefined;
};

const resolveTerminalCloser = (injected: OwnerTerminalCloser | null | undefined): OwnerTerminalCloser | null => {
  if (injected !== undefined) return injected;
  if (underVitest()) return null;
  return platform() === "darwin" ? closeDarwinTerminalWindows : null;
};

const listSessionsLive = (): string[] => {
  const listed = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
  if ((listed.status ?? 1) !== 0) return [];
  return listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((name) => name !== "");
};

const killSessionLive = (name: string): void => {
  spawnSync("tmux", ["kill-session", "-t", name]);
};

export type DetachIssueOptions = {
  /** Issue number, or `"manual"` for the owner-driven manual UI (issue 76). */
  issue: SessionKey;
  agentIds: readonly string[];
  tmuxNamespace?: string | null;
  /** Workspace fingerprint for Terminal titles (always preferred over tmuxNamespace). */
  terminalGroup?: string | null;
  dryRun?: boolean;
  log?: DetachIssueLogger;
  tmuxRunner?: TmuxRunner;
  /** Override Terminal closer (tests). `null` skips closing. Default: platform closer. */
  terminalCloser?: OwnerTerminalCloser | null;
};

export type DetachIssueResult = {
  killedSessions: string[];
  closedTerminalTitles: string[];
  terminalClose: "closed" | "unsupported" | "failed" | "skipped";
  terminalError?: string;
};

const sessionPrefix = (key: SessionKey, namespace: string | null, group: string | null = null): string =>
  ownerSessionName(key, namespace, group);

/** Parse issue numbers from live tmux session names for this namespace. */
export const discoverCoordIssues = (sessionNames: readonly string[], namespace: string | null = null): number[] => {
  const issues = new Set<number>();
  for (const name of sessionNames) {
    if (namespace !== null && namespace !== "") {
      const safe = namespace.replace(/[^A-Za-z0-9_-]/g, "-");
      const matched = name.match(new RegExp(`^coord-(\\d+)-${safe}(?:-|$)`));
      if (matched?.[1] !== undefined) issues.add(Number(matched[1]));
      continue;
    }
    const matched = name.match(/^coord-(\d+)(?:-|$)/);
    if (matched?.[1] !== undefined) issues.add(Number(matched[1]));
  }
  return [...issues].sort((left, right) => left - right);
};

export const filterSessionsForIssue = (
  sessionNames: readonly string[],
  key: SessionKey,
  namespace: string | null = null,
  group: string | null = null
): string[] => {
  const prefix = sessionPrefix(key, namespace, group);
  return sessionNames.filter((name) => name === prefix || name.startsWith(`${prefix}-`));
};

const closeTitles = (
  titles: readonly string[],
  closer: OwnerTerminalCloser | null,
  dryRun: boolean,
  log: DetachIssueLogger
): Pick<DetachIssueResult, "closedTerminalTitles" | "terminalClose" | "terminalError"> => {
  if (titles.length === 0) {
    return { closedTerminalTitles: [], terminalClose: "skipped" };
  }
  if (dryRun) {
    log(`would close Terminal window(s): ${titles.join(", ")}\n`);
    return { closedTerminalTitles: [...titles], terminalClose: "skipped" };
  }
  if (closer === null) {
    log("Terminal window close is unavailable on this platform; tmux sessions were torn down.\n");
    return { closedTerminalTitles: [...titles], terminalClose: "unsupported" };
  }
  try {
    closer(titles);
    log(`closed Terminal window(s): ${titles.join(", ")}\n`);
    return { closedTerminalTitles: [...titles], terminalClose: "closed" };
  } catch (error) {
    const terminalError = error instanceof Error ? error.message : String(error);
    log(`could not close Terminal windows (${terminalError}).\n`);
    return { closedTerminalTitles: [...titles], terminalClose: "failed", terminalError };
  }
};

/**
 * Tear down owner UI for an issue: kill tmux sessions and close matching
 * Terminal.app windows. Leaves runtime, clones, and GitHub issue untouched.
 */
export const detachIssue = async (options: DetachIssueOptions): Promise<DetachIssueResult> => {
  const log = options.log ?? (() => undefined);
  const dryRun = options.dryRun === true;
  const closer = resolveTerminalCloser(options.terminalCloser);
  const titleGroup = options.terminalGroup ?? options.tmuxNamespace ?? null;
  const tmux = new TmuxController(
    resolveTmuxRunner(options.tmuxRunner),
    options.tmuxNamespace ?? null,
    null,
    closer,
    undefined,
    titleGroup
  );

  // Close Terminal windows first while titles/names still match. Killing tmux
  // first leaves idle bash shells and can clear custom titles, so close fails.
  const titles = ownerTerminalTitlesToClose(options.issue, options.agentIds, titleGroup);
  const closed = closeTitles(titles, closer, dryRun, log);

  const names = await tmux.listIssueSessions(options.issue);
  for (const name of names) {
    log(`${dryRun ? "would kill" : "killing"} tmux session ${name}\n`);
  }
  if (!dryRun && names.length > 0) {
    await tmux.killIssueSessions(options.issue);
  }

  return { killedSessions: names, ...closed };
};

export type DetachAllOwnerUiOptions = {
  agentIds: readonly string[];
  tmuxNamespace?: string | null;
  /** Workspace fingerprint for Terminal titles. */
  terminalGroup?: string | null;
  /** When set, only these issues; otherwise discover from live tmux sessions. */
  issues?: readonly number[];
  /** Also tear down this workspace's manual UI (issue 76), even with no issues. */
  includeManual?: boolean;
  dryRun?: boolean;
  log?: DetachIssueLogger;
  terminalCloser?: OwnerTerminalCloser | null;
  /** Inject session list (tests). */
  listSessions?: () => string[];
  /** Inject session killer (tests). */
  killSession?: (name: string) => void;
};

/**
 * Sync UI teardown for uninstall: kill this workspace's issue tmux sessions
 * and close matching `coord-N[-<group>]/<agent>` Terminal titles.
 * Pass `issues` from this workspace's `issue-*` dirs. Without a namespace,
 * do not discover issue numbers from the global tmux list — that killed other
 * products' `coord-N` sessions. With no matching issues, this is a no-op.
 *
 * `includeManual` adds this workspace's `coord-manual-<group>` session and its
 * titles. A workspace used only through `coord manual` has no `issue-*` dirs,
 * so the empty-issues short circuit must not skip that teardown.
 */
export const detachAllOwnerUiSync = (options: DetachAllOwnerUiOptions): DetachIssueResult => {
  const log = options.log ?? (() => undefined);
  const dryRun = options.dryRun === true;
  const namespace = options.tmuxNamespace ?? null;
  // Under Vitest, default to an empty session list / no-op kill so uninstall
  // fixtures cannot discover and destroy the operator's live coord sessions.
  const listed = (options.listSessions ?? (underVitest() ? () => [] : listSessionsLive))();
  const killSession = options.killSession ?? (underVitest() ? () => undefined : killSessionLive);
  // Flat workspaces share un-namespaced `coord-N` session names. Never invent
  // issue numbers from the global tmux list unless a namespace scopes them.
  const issues =
    options.issues !== undefined
      ? [...options.issues]
      : namespace !== null && namespace !== ""
        ? discoverCoordIssues(listed, namespace)
        : [];

  const titleGroup = options.terminalGroup ?? namespace;
  // Manual UI is always workspace-grouped; without a group there is nothing
  // safe to match, so never fall back to an unscoped `coord-manual`.
  const manualKeys: SessionKey[] =
    options.includeManual === true && titleGroup !== null && titleGroup !== "" ? [MANUAL_SESSION_KEY] : [];
  const keys: SessionKey[] = [...issues, ...manualKeys];

  if (keys.length === 0) {
    return { killedSessions: [], closedTerminalTitles: [], terminalClose: "skipped" };
  }

  const titles = new Set<string>();
  for (const key of keys) {
    for (const title of ownerTerminalTitlesToClose(key, options.agentIds, titleGroup)) {
      titles.add(title);
    }
  }

  const closer = resolveTerminalCloser(options.terminalCloser);
  const closed = closeTitles([...titles], closer, dryRun, log);

  const killedSessions: string[] = [];
  for (const key of keys) {
    for (const name of filterSessionsForIssue(listed, key, namespace, titleGroup)) {
      log(`${dryRun ? "would kill" : "killing"} tmux session ${name}\n`);
      if (!dryRun) killSession(name);
      killedSessions.push(name);
    }
  }

  return { killedSessions, ...closed };
};

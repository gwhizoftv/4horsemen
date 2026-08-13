import { spawnSync } from "node:child_process";
import type { TmuxRunner, OwnerTerminalCloser, TmuxResult } from "./tmux.js";
import {
  closeDarwinTerminalWindows,
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
  issue: number;
  agentIds: readonly string[];
  tmuxNamespace?: string | null;
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

const sessionPrefix = (issue: number, namespace: string | null): string =>
  `coord-${issue}${namespace === null || namespace === "" ? "" : `-${namespace.replace(/[^A-Za-z0-9_-]/g, "-")}`}`;

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
  issue: number,
  namespace: string | null = null
): string[] => {
  const prefix = sessionPrefix(issue, namespace);
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
  const tmux = new TmuxController(
    resolveTmuxRunner(options.tmuxRunner),
    options.tmuxNamespace ?? null,
    null,
    closer
  );

  const names = await tmux.listIssueSessions(options.issue);
  for (const name of names) {
    log(`${dryRun ? "would kill" : "killing"} tmux session ${name}\n`);
  }
  if (!dryRun && names.length > 0) {
    await tmux.killIssueSessions(options.issue);
  }

  const titles = ownerTerminalTitlesToClose(options.issue, options.agentIds, options.tmuxNamespace ?? null);
  const closed = closeTitles(titles, closer, dryRun, log);
  return { killedSessions: names, ...closed };
};

export type DetachAllOwnerUiOptions = {
  agentIds: readonly string[];
  tmuxNamespace?: string | null;
  /** When set, only these issues; otherwise discover from live tmux sessions. */
  issues?: readonly number[];
  dryRun?: boolean;
  log?: DetachIssueLogger;
  terminalCloser?: OwnerTerminalCloser | null;
  /** Inject session list (tests). */
  listSessions?: () => string[];
  /** Inject session killer (tests). */
  killSession?: (name: string) => void;
};

/**
 * Sync UI teardown for uninstall: kill discovered (or listed) issue tmux
 * sessions and close matching `coord-N[/<ns>]/<agent>` Terminal titles.
 * With no matching sessions/issues, this is a pure no-op — it must not close
 * bare agent-named Terminal tabs (that path hit unrelated windows with no tmux).
 */
export const detachAllOwnerUiSync = (options: DetachAllOwnerUiOptions): DetachIssueResult => {
  const log = options.log ?? (() => undefined);
  const dryRun = options.dryRun === true;
  const namespace = options.tmuxNamespace ?? null;
  // Under Vitest, default to an empty session list / no-op kill so uninstall
  // fixtures cannot discover and destroy the operator's live coord sessions.
  const listed = (options.listSessions ?? (underVitest() ? () => [] : listSessionsLive))();
  const killSession = options.killSession ?? (underVitest() ? () => undefined : killSessionLive);
  const issues =
    options.issues !== undefined && options.issues.length > 0
      ? [...options.issues]
      : discoverCoordIssues(listed, namespace);

  const killedSessions: string[] = [];
  for (const issue of issues) {
    for (const name of filterSessionsForIssue(listed, issue, namespace)) {
      log(`${dryRun ? "would kill" : "killing"} tmux session ${name}\n`);
      if (!dryRun) killSession(name);
      killedSessions.push(name);
    }
  }

  if (issues.length === 0) {
    return { killedSessions: [], closedTerminalTitles: [], terminalClose: "skipped" };
  }

  const titles = new Set<string>();
  for (const issue of issues) {
    for (const title of ownerTerminalTitlesToClose(issue, options.agentIds, namespace)) {
      titles.add(title);
    }
  }

  const closer = resolveTerminalCloser(options.terminalCloser);
  const closed = closeTitles([...titles], closer, dryRun, log);
  return { killedSessions, ...closed };
};

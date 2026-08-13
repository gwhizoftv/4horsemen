import type { TmuxRunner, OwnerTerminalCloser } from "./tmux.js";
import { TmuxController } from "./tmux.js";

export type DetachIssueLogger = (message: string) => void;

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

/**
 * Tear down owner UI for an issue: kill tmux sessions and close matching
 * Terminal.app windows. Leaves runtime, clones, and GitHub issue untouched.
 */
export const detachIssue = async (options: DetachIssueOptions): Promise<DetachIssueResult> => {
  const log = options.log ?? (() => undefined);
  const dryRun = options.dryRun === true;
  const tmux =
    options.terminalCloser === undefined
      ? new TmuxController(options.tmuxRunner, options.tmuxNamespace ?? null, null)
      : new TmuxController(options.tmuxRunner, options.tmuxNamespace ?? null, null, options.terminalCloser);

  const names = await tmux.listIssueSessions(options.issue);
  for (const name of names) {
    log(`${dryRun ? "would kill" : "killing"} tmux session ${name}\n`);
  }
  if (!dryRun && names.length > 0) {
    await tmux.killIssueSessions(options.issue);
  }

  const titles = tmux.ownerTerminalTitles(options.issue, options.agentIds);
  if (titles.length === 0) {
    return { killedSessions: names, closedTerminalTitles: [], terminalClose: "skipped" };
  }
  if (dryRun) {
    log(`would close Terminal window(s): ${titles.join(", ")}\n`);
    return { killedSessions: names, closedTerminalTitles: titles, terminalClose: "skipped" };
  }

  const closed = tmux.closeOwnerAgentClients(options.issue, options.agentIds);
  if (closed.status === "closed") {
    log(`closed Terminal window(s): ${closed.titles.join(", ")}\n`);
    return { killedSessions: names, closedTerminalTitles: [...closed.titles], terminalClose: "closed" };
  }
  if (closed.status === "unsupported") {
    log("Terminal window close is unavailable on this platform; tmux sessions were torn down.\n");
    return { killedSessions: names, closedTerminalTitles: [...closed.titles], terminalClose: "unsupported" };
  }
  log(`could not close Terminal windows (${closed.error ?? "unknown error"}).\n`);
  return {
    killedSessions: names,
    closedTerminalTitles: [...closed.titles],
    terminalClose: "failed",
    ...(closed.error === undefined ? {} : { terminalError: closed.error })
  };
};

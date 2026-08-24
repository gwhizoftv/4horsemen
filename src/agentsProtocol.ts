import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitOrThrow } from "./gitExec.js";
import {
  AGENTS_PROTOCOL_MARKERS,
  applyDelimitedBlock,
  removeManagedBlock,
  type IgnoreFileOutcome
} from "./productIgnore.js";

type Effects = { dryRun: boolean; log: (message: string) => void; changes: string[] };

const protocolTemplate = (installRoot: string): string =>
  join(installRoot, "templates", "product", "AGENTS.protocol.md");

export const renderAgentsProtocolBlock = (installRoot: string): string => {
  const inner = readFileSync(protocolTemplate(installRoot), "utf8").trimEnd();
  return `${AGENTS_PROTOCOL_MARKERS.begin}\n\n${inner}\n\n${AGENTS_PROTOCOL_MARKERS.end}`;
};

const writeProtocolFile = (path: string, existing: string, installRoot: string, dryRun: boolean): IgnoreFileOutcome => {
  const result = applyDelimitedBlock(existing, renderAgentsProtocolBlock(installRoot), path, AGENTS_PROTOCOL_MARKERS);
  if (!result.changed) return { path, changed: false, wrote: false };
  if (dryRun) return { path, changed: true, wrote: false };
  writeFileSync(path, result.content, "utf8");
  return { path, changed: true, wrote: true };
};

export const clearAgentsProtocolFile = (path: string, options: { dryRun: boolean }): IgnoreFileOutcome => {
  if (!existsSync(path)) return { path, changed: false, wrote: false };
  const result = removeManagedBlock(readFileSync(path, "utf8"), path, AGENTS_PROTOCOL_MARKERS);
  if (!result.changed) return { path, changed: false, wrote: false };
  if (options.dryRun) return { path, changed: true, wrote: false };
  writeFileSync(path, result.content, "utf8");
  return { path, changed: true, wrote: true };
};

const agentsMdTracked = (clone: string): boolean => git(clone, "ls-files", "--", "AGENTS.md").stdout.trim() !== "";

/** Drop a previous overlay so a fast-forward can update the committed AGENTS.md. */
export const liftCloneAgentsProtocol = (clone: string, options: Effects): void => {
  if (!existsSync(join(clone, ".git")) || !agentsMdTracked(clone)) return;
  if (options.dryRun) return;
  git(clone, "update-index", "--no-skip-worktree", "--", "AGENTS.md");
  git(clone, "checkout", "HEAD", "--", "AGENTS.md");
};

/**
 * Re-set the bit that hides the overlay from `git status`. Exported because
 * branch preparation must be able to put it back on its own: it clears the bit
 * to move `HEAD`, and a clone left with the bit clear shows AGENTS.md as an
 * uncommitted change that the agent is forbidden to clean up by hand.
 */
export const ensureAgentsMdSkipWorktree = (clone: string): void => {
  if (!agentsMdTracked(clone)) return;
  gitOrThrow(clone, "update-index", "--skip-worktree", "--", "AGENTS.md");
};

const protocolBlockIn = (content: string): string | null => {
  const begin = content.indexOf(AGENTS_PROTOCOL_MARKERS.begin);
  if (begin === -1) return null;
  const end = content.indexOf(AGENTS_PROTOCOL_MARKERS.end, begin);
  if (end === -1) return null;
  return content.slice(begin, end + AGENTS_PROTOCOL_MARKERS.end.length);
};

/**
 * Take a copy of the clone's current overlay before something clears it.
 *
 * A vendored clone records no install root (`configureCloneIdentity`), so the
 * template the overlay was rendered from cannot be located afterwards. The
 * bytes already in the clone are that same text, and they are always readable.
 */
export const captureCloneAgentsProtocol = (clone: string): string | null => {
  const path = join(clone, "AGENTS.md");
  if (!existsSync(path)) return null;
  return protocolBlockIn(readFileSync(path, "utf8"));
};

/** Put a captured overlay back on top of whatever AGENTS.md the new HEAD brought in. */
export const restoreCapturedAgentsProtocol = (clone: string, block: string): void => {
  const path = join(clone, "AGENTS.md");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const result = applyDelimitedBlock(existing, block, path, AGENTS_PROTOCOL_MARKERS);
  if (result.changed) writeFileSync(path, result.content, "utf8");
  ensureAgentsMdSkipWorktree(clone);
};

/**
 * True when the worktree AGENTS.md differs from HEAD only by the managed
 * overlay. That is exactly the state a run leaves behind when it clears the bit
 * and then fails to restore it, and it must not be mistaken for a dirty clone.
 */
export const agentsMdDiffersOnlyByProtocol = (clone: string): boolean => {
  const path = join(clone, "AGENTS.md");
  if (!existsSync(path)) return false;
  const head = git(clone, "show", "HEAD:AGENTS.md");
  if (head.exitCode !== 0) return false;
  try {
    return removeManagedBlock(readFileSync(path, "utf8"), path, AGENTS_PROTOCOL_MARKERS).content === head.stdout;
  } catch {
    // A begin marker with no end marker is a real edit, not our overlay.
    return false;
  }
};

/** What branch preparation must be able to assert about a clone before launch. */
export const cloneAgentsProtocolState = (
  clone: string
): { tracked: boolean; overlayPresent: boolean; skipWorktree: boolean } => {
  const tracked = agentsMdTracked(clone);
  const path = join(clone, "AGENTS.md");
  const overlayPresent = existsSync(path) && protocolBlockIn(readFileSync(path, "utf8")) !== null;
  const skipWorktree = tracked && git(clone, "ls-files", "-v", "--", "AGENTS.md").stdout.startsWith("S");
  return { tracked, overlayPresent, skipWorktree };
};

/**
 * Keep the coordination protocol in the clone's AGENTS.md so agents can rely on
 * that file even when the product's tracked copy is a short human note.
 * skip-worktree hides the overlay from `git status` so wipe/sync still see a
 * clean clone.
 */
export const writeCloneAgentsProtocol = (input: {
  clone: string;
  installRoot: string;
  options: Effects;
}): void => {
  const path = join(input.clone, "AGENTS.md");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const outcome = writeProtocolFile(path, existing, input.installRoot, input.options.dryRun);
  if (!outcome.changed) {
    if (!input.options.dryRun) ensureAgentsMdSkipWorktree(input.clone);
    input.options.log(`AGENTS.md protocol already current in ${input.clone}\n`);
    return;
  }
  input.options.changes.push(`write AGENTS.md protocol in ${input.clone}`);
  input.options.log(`${input.options.dryRun ? "would write" : "wrote"} AGENTS.md protocol in ${input.clone}\n`);
  if (!input.options.dryRun) ensureAgentsMdSkipWorktree(input.clone);
};

export const writeProductAgentsProtocol = (input: {
  productRoot: string;
  installRoot: string;
  project: string;
  baseBranch: string;
  toolchain: string | undefined;
  createdFile: boolean;
  options: Effects;
}): void => {
  const path = join(input.productRoot, "AGENTS.md");
  if (input.createdFile && !existsSync(path)) {
    const template = join(input.installRoot, "templates", "product", "AGENTS.md");
    const intro = readFileSync(template, "utf8")
      .replaceAll("{{PROJECT}}", input.project)
      .replaceAll("{{BASE_BRANCH}}", input.baseBranch)
      .replaceAll("{{TOOLCHAIN}}", input.toolchain ?? "declared in the owner workspace config")
      .trimEnd();
    const content = `${intro}\n\n${renderAgentsProtocolBlock(input.installRoot)}\n`;
    input.options.changes.push(`write ${path}`);
    if (input.options.dryRun) {
      input.options.log(`would write ${path}\n`);
      return;
    }
    writeFileSync(path, content, "utf8");
    input.options.log(`wrote ${path}\n`);
    return;
  }
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const outcome = writeProtocolFile(path, existing, input.installRoot, input.options.dryRun);
  if (!outcome.changed) {
    input.options.log(`AGENTS.md already exists in ${input.productRoot}; protocol already current\n`);
    return;
  }
  input.options.changes.push(`update ${path}`);
  input.options.log(
    `${input.options.dryRun ? "would update" : "updated"} ${path} (human text outside the protocol block is unchanged)\n`
  );
};

/** Claude Code does not load AGENTS.md natively; the shim imports it. */
export const writeClaudeAgentsShim = (clone: string, agent: string, options: Effects): void => {
  if (agent !== "claude") return;
  const path = join(clone, "CLAUDE.md");
  const body = "# Claude agent\n\nThe workflow is in AGENTS.md. Read and follow it.\n\n@AGENTS.md\n";
  if (existsSync(path) && readFileSync(path, "utf8") === body) {
    options.log(`CLAUDE.md already current in ${clone}\n`);
    return;
  }
  options.changes.push(`write ${path}`);
  if (options.dryRun) {
    options.log(`would write ${path}\n`);
    return;
  }
  writeFileSync(path, body, "utf8");
  options.log(`wrote ${path}\n`);
};

export const clearClaudeAgentsShim = (clone: string, agent: string, options: Effects): void => {
  if (agent !== "claude") return;
  const path = join(clone, "CLAUDE.md");
  if (!existsSync(path)) return;
  options.changes.push(`remove ${path}`);
  if (options.dryRun) {
    options.log(`would remove ${path}\n`);
    return;
  }
  rmSync(path);
  options.log(`removed ${path}\n`);
};

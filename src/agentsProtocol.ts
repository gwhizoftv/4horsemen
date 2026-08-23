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

export const ensureAgentsMdSkipWorktree = (clone: string): void => {
  if (!agentsMdTracked(clone)) return;
  gitOrThrow(clone, "update-index", "--skip-worktree", "--", "AGENTS.md");
};

export const cloneAgentsProtocolState = (
  clone: string
): { tracked: boolean; overlayPresent: boolean; skipWorktree: boolean } => {
  const tracked = agentsMdTracked(clone);
  const path = join(clone, "AGENTS.md");
  const overlayPresent =
    existsSync(path) && readFileSync(path, "utf8").includes(AGENTS_PROTOCOL_MARKERS.begin);
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

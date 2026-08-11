import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const MANAGED_GITIGNORE_BEGIN = "# BEGIN coordination (managed by coord install --write-product)";
export const MANAGED_GITIGNORE_END = "# END coordination";

export const agentExcludeDefaults = (agentId: string): string[] => {
  const shared = ["tags", "directory_tree.md", `/start-${agentId}.sh`];
  switch (agentId) {
    case "claude":
      return [...shared, ".claude/", "CLAUDE.md"];
    case "codex":
      return [...shared, ".codex/", "AGENTS.override.md"];
    case "cursor":
      return [...shared, ".cursor/", "AGENTS.override.md"];
    case "antigravity":
      return [...shared, ".antigravity/", ".agents/"];
    default:
      return [...shared, `.${agentId}/`];
  }
};

export const ensureCloneExclude = (
  cloneRoot: string,
  agentId: string,
  options: { dryRun?: boolean } = {}
): { path: string; added: string[] } => {
  const path = join(cloneRoot, ".git/info/exclude");
  const lines = agentExcludeDefaults(agentId);
  if (options.dryRun === true) return { path, added: lines };
  mkdirSync(dirname(path), { recursive: true });
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const present = new Set(existing.split(/\r?\n/).filter((line) => line.length > 0));
  const added: string[] = [];
  let next = existing;
  for (const line of lines) {
    if (present.has(line)) continue;
    if (added.length === 0) {
      if (next.length > 0 && !next.endsWith("\n")) next += "\n";
      next += `\n# coordination agent-local files (${agentId})\n`;
    }
    next += `${line}\n`;
    added.push(line);
  }
  if (added.length > 0) writeFileSync(path, next);
  return { path, added };
};

export const clearCloneExcludeManaged = (
  cloneRoot: string,
  agentId: string,
  options: { dryRun?: boolean } = {}
): string[] => {
  const path = join(cloneRoot, ".git/info/exclude");
  if (!existsSync(path)) return [];
  const lines = agentExcludeDefaults(agentId);
  if (options.dryRun === true) return lines;
  const existing = readFileSync(path, "utf8").split(/\r?\n/);
  const drop = new Set(lines);
  const kept = existing.filter((line) => !drop.has(line));
  writeFileSync(path, kept.join("\n").replace(/\n+$/, "\n"));
  return lines;
};

export const managedGitignoreBlock = (): string =>
  readFileSync(join(packageRoot, "templates/product/gitignore.coordination.block"), "utf8").trimEnd() + "\n";

export const writeManagedProductGitignore = (
  productRoot: string,
  options: { dryRun?: boolean } = {}
): { path: string; wrote: boolean } => {
  const path = join(productRoot, ".gitignore");
  const block = managedGitignoreBlock();
  if (options.dryRun === true) return { path, wrote: true };
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (existing.includes(MANAGED_GITIGNORE_BEGIN)) return { path, wrote: false };
  const next = existing.length === 0 ? block : `${existing.replace(/\n+$/, "\n")}\n${block}`;
  writeFileSync(path, next);
  return { path, wrote: true };
};

export const removeManagedProductGitignore = (
  productRoot: string,
  options: { dryRun?: boolean } = {}
): boolean => {
  const path = join(productRoot, ".gitignore");
  if (!existsSync(path)) return false;
  const existing = readFileSync(path, "utf8");
  if (!existing.includes(MANAGED_GITIGNORE_BEGIN)) return false;
  if (options.dryRun === true) return true;
  const pattern = new RegExp(
    `${MANAGED_GITIGNORE_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${MANAGED_GITIGNORE_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`,
    "g"
  );
  writeFileSync(path, existing.replace(pattern, ""));
  return true;
};

export const writeOptionalAgentsMd = (
  productRoot: string,
  projectName: string,
  sharedBranch: string,
  options: { dryRun?: boolean; force?: boolean } = {}
): { path: string; wrote: boolean } => {
  const path = join(productRoot, "AGENTS.md");
  const template = readFileSync(join(packageRoot, "templates/product/AGENTS.md"), "utf8")
    .replaceAll("{{PROJECT_NAME}}", projectName)
    .replaceAll("{{SHARED_BRANCH}}", sharedBranch);
  if (options.dryRun === true) return { path, wrote: true };
  if (existsSync(path) && options.force !== true) return { path, wrote: false };
  writeFileSync(path, template);
  return { path, wrote: true };
};

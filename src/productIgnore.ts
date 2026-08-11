import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Ignore rules coordination manages.
 *
 * By default they go into an agent clone's `.git/info/exclude`, which is
 * untracked by construction: onboarding a product leaves its tracked tree
 * byte-identical, and a human clone of the same remote never sees them.
 * `--write-product` writes the same block into the product's `.gitignore`
 * instead, for owners who want the convention visible in the repository.
 *
 * Both writers are additive and delimited. Uninstall removes the delimited
 * block and nothing else, so unrelated ignore lines an operator added by hand
 * survive a coordination uninstall.
 */

export const MANAGED_BLOCK_BEGIN = "# >>> coordination managed block — coord install >>>";
export const MANAGED_BLOCK_END = "# <<< coordination managed block — coord install <<<";

/**
 * Per-clone ignore rules. Launchers, tool directories, and generated indexes
 * are agent-local: they exist only because coordination put them there, so a
 * clone must not offer them for commit.
 */
export const DEFAULT_CLONE_IGNORES: readonly string[] = [
  "/start-*.sh",
  "tags",
  "directory_tree.md",
  ".claude/",
  ".codex/",
  ".cursor/",
  ".antigravity/",
  ".gemini/",
  ".agents/"
];

export const renderManagedBlock = (lines: readonly string[]): string =>
  [MANAGED_BLOCK_BEGIN, "# Managed by coordination. Edits inside are overwritten; edit outside.", ...lines, MANAGED_BLOCK_END].join(
    "\n"
  );

const splitAroundBlock = (content: string): { before: string; after: string; found: boolean } => {
  const beginIndex = content.indexOf(MANAGED_BLOCK_BEGIN);
  if (beginIndex === -1) return { before: content, after: "", found: false };
  const endIndex = content.indexOf(MANAGED_BLOCK_END, beginIndex);
  if (endIndex === -1) {
    // An unterminated marker means someone edited or truncated the block. Treat
    // everything from the marker on as ours rather than appending a second one.
    return { before: content.slice(0, beginIndex), after: "", found: true };
  }
  return {
    before: content.slice(0, beginIndex),
    after: content.slice(endIndex + MANAGED_BLOCK_END.length),
    found: true
  };
};

const normalize = (content: string): string => {
  const trimmed = content.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  if (trimmed === "" || trimmed.endsWith("\n")) return trimmed;
  return `${trimmed}\n`;
};

export type ManagedBlockResult = { changed: boolean; content: string };

/** Insert or refresh the managed block, leaving every other line untouched. */
export const applyManagedBlock = (existing: string, lines: readonly string[]): ManagedBlockResult => {
  const { before, after } = splitAroundBlock(existing);
  const head = before === "" ? "" : `${before.replace(/\s+$/, "")}\n\n`;
  const tail = after.replace(/^\s+/, "");
  const content = normalize(`${head}${renderManagedBlock(lines)}\n${tail === "" ? "" : `\n${tail}`}`);
  return { changed: content !== existing, content };
};

/** Remove the managed block, leaving every other line untouched. */
export const removeManagedBlock = (existing: string): ManagedBlockResult => {
  const { before, after, found } = splitAroundBlock(existing);
  if (!found) return { changed: false, content: existing };
  const content = normalize(`${before.replace(/\s+$/, "")}\n${after.replace(/^\s+/, "")}`);
  return { changed: content !== existing, content };
};

const readIfPresent = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

export type IgnoreFileOutcome = { path: string; changed: boolean; wrote: boolean };

export const writeManagedIgnoreFile = (
  path: string,
  lines: readonly string[],
  options: { dryRun: boolean }
): IgnoreFileOutcome => {
  const result = applyManagedBlock(readIfPresent(path), lines);
  if (!result.changed) return { path, changed: false, wrote: false };
  if (options.dryRun) return { path, changed: true, wrote: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, result.content, "utf8");
  return { path, changed: true, wrote: true };
};

export const clearManagedIgnoreFile = (path: string, options: { dryRun: boolean }): IgnoreFileOutcome => {
  if (!existsSync(path)) return { path, changed: false, wrote: false };
  const result = removeManagedBlock(readFileSync(path, "utf8"));
  if (!result.changed) return { path, changed: false, wrote: false };
  if (options.dryRun) return { path, changed: true, wrote: false };
  writeFileSync(path, result.content, "utf8");
  return { path, changed: true, wrote: true };
};

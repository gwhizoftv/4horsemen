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

export class ManagedBlockError extends Error {
  override readonly name = "ManagedBlockError";
}

export const renderManagedBlock = (lines: readonly string[]): string =>
  [MANAGED_BLOCK_BEGIN, "# Managed by coordination. Edits inside are overwritten; edit outside.", ...lines, MANAGED_BLOCK_END].join(
    "\n"
  );

type BlockLocation = { found: false } | { found: true; before: string; after: string };

/**
 * Locate the managed region and nothing else.
 *
 * A begin marker with no end marker is an error rather than a licence to treat
 * the rest of the file as ours. Assuming ownership there silently deleted every
 * line below a marker whose terminator a human had removed.
 */
const locateBlock = (content: string, path: string): BlockLocation => {
  const beginIndex = content.indexOf(MANAGED_BLOCK_BEGIN);
  if (beginIndex === -1) return { found: false };
  const endIndex = content.indexOf(MANAGED_BLOCK_END, beginIndex);
  if (endIndex === -1) {
    throw new ManagedBlockError(
      `${path} has a coordination begin marker with no matching end marker, so the managed region cannot be identified.\n` +
        `  Refusing to guess where it ends; the lines below it are not coordination's to remove.\n` +
        `  Fix: restore the '${MANAGED_BLOCK_END}' line, or delete the begin marker and its block by hand.`
    );
  }
  return {
    found: true,
    before: content.slice(0, beginIndex),
    after: content.slice(endIndex + MANAGED_BLOCK_END.length)
  };
};

export type ManagedBlockResult = { changed: boolean; content: string };

/**
 * Insert or refresh the managed block. Every byte outside the region — blank
 * lines, grouping, trailing whitespace — is preserved exactly, so that
 * install/uninstall is an identity on a file coordination does not own.
 */
export const applyManagedBlock = (existing: string, lines: readonly string[], path = "<ignore file>"): ManagedBlockResult => {
  const block = renderManagedBlock(lines);
  const located = locateBlock(existing, path);
  if (located.found) {
    const content = `${located.before}${block}${located.after}`;
    return { changed: content !== existing, content };
  }
  // One blank line of separation, and only when the file does not already end
  // with a newline of its own to build on.
  const separator = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  const content = `${existing}${separator}${block}\n`;
  return { changed: true, content };
};

/** Remove the managed block and the one separator `applyManagedBlock` added. */
export const removeManagedBlock = (existing: string, path = "<ignore file>"): ManagedBlockResult => {
  const located = locateBlock(existing, path);
  if (!located.found) return { changed: false, content: existing };
  const before = located.before.endsWith("\n") ? located.before.slice(0, -1) : located.before;
  const after = located.after.startsWith("\n") ? located.after.slice(1) : located.after;
  const content = `${before}${after}`;
  return { changed: content !== existing, content };
};

const readIfPresent = (path: string): string => (existsSync(path) ? readFileSync(path, "utf8") : "");

export type IgnoreFileOutcome = { path: string; changed: boolean; wrote: boolean };

export const writeManagedIgnoreFile = (
  path: string,
  lines: readonly string[],
  options: { dryRun: boolean }
): IgnoreFileOutcome => {
  const result = applyManagedBlock(readIfPresent(path), lines, path);
  if (!result.changed) return { path, changed: false, wrote: false };
  if (options.dryRun) return { path, changed: true, wrote: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, result.content, "utf8");
  return { path, changed: true, wrote: true };
};

export const clearManagedIgnoreFile = (path: string, options: { dryRun: boolean }): IgnoreFileOutcome => {
  if (!existsSync(path)) return { path, changed: false, wrote: false };
  const result = removeManagedBlock(readFileSync(path, "utf8"), path);
  if (!result.changed) return { path, changed: false, wrote: false };
  if (options.dryRun) return { path, changed: true, wrote: false };
  writeFileSync(path, result.content, "utf8");
  return { path, changed: true, wrote: true };
};

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

/** HTML-comment delimiters so the protocol block is not a markdown heading. */
export const AGENTS_PROTOCOL_BEGIN = "<!-- coordination protocol — coord install -->";
export const AGENTS_PROTOCOL_END = "<!-- /coordination protocol -->";

export type BlockMarkers = { begin: string; end: string };

export const IGNORE_BLOCK_MARKERS: BlockMarkers = { begin: MANAGED_BLOCK_BEGIN, end: MANAGED_BLOCK_END };
export const AGENTS_PROTOCOL_MARKERS: BlockMarkers = { begin: AGENTS_PROTOCOL_BEGIN, end: AGENTS_PROTOCOL_END };

/**
 * Per-clone ignore rules. Launchers, tool directories, and generated indexes
 * are agent-local: they exist only because coordination put them there, so a
 * clone must not offer them for commit.
 */
export const DEFAULT_CLONE_IGNORES: readonly string[] = [
  ".coord/",
  "/start-*.sh",
  "tags",
  "directory_tree.md",
  "/AGENTS.md",
  "CLAUDE.md",
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
const locateBlock = (content: string, path: string, markers: BlockMarkers = IGNORE_BLOCK_MARKERS): BlockLocation => {
  const beginIndex = content.indexOf(markers.begin);
  if (beginIndex === -1) return { found: false };
  const endIndex = content.indexOf(markers.end, beginIndex);
  if (endIndex === -1) {
    throw new ManagedBlockError(
      `${path} has a coordination begin marker with no matching end marker, so the managed region cannot be identified.\n` +
        `  Refusing to guess where it ends; the lines below it are not coordination's to remove.\n` +
        `  Fix: restore the '${markers.end}' line, or delete the begin marker and its block by hand.`
    );
  }
  return {
    found: true,
    before: content.slice(0, beginIndex),
    after: content.slice(endIndex + markers.end.length)
  };
};

export type ManagedBlockResult = { changed: boolean; content: string };

/**
 * Insert or refresh a delimited block. Every byte outside the region is
 * preserved exactly.
 */
export const applyDelimitedBlock = (
  existing: string,
  block: string,
  path: string,
  markers: BlockMarkers
): ManagedBlockResult => {
  const located = locateBlock(existing, path, markers);
  if (located.found) {
    const content = `${located.before}${block}${located.after}`;
    return { changed: content !== existing, content };
  }
  const separator = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  const content = `${existing}${separator}${block}\n`;
  return { changed: true, content };
};

/**
 * Insert or refresh the managed block. Every byte outside the region — blank
 * lines, grouping, trailing whitespace — is preserved exactly, so that
 * install/uninstall is an identity on a file coordination does not own.
 */
export const applyManagedBlock = (
  existing: string,
  lines: readonly string[],
  path = "<ignore file>",
  markers: BlockMarkers = IGNORE_BLOCK_MARKERS
): ManagedBlockResult => {
  const block =
    markers.begin === MANAGED_BLOCK_BEGIN && markers.end === MANAGED_BLOCK_END
      ? renderManagedBlock(lines)
      : [markers.begin, ...lines, markers.end].join("\n");
  return applyDelimitedBlock(existing, block, path, markers);
};

/** Remove the managed block and the one separator `applyManagedBlock` added. */
export const removeManagedBlock = (
  existing: string,
  path = "<ignore file>",
  markers: BlockMarkers = IGNORE_BLOCK_MARKERS
): ManagedBlockResult => {
  const located = locateBlock(existing, path, markers);
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

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { git } from "./gitExec.js";
import { sha256, sha256OfFile } from "./hash.js";
import type { BareMirror } from "./mirror.js";
import { assertNoSymlink, containedPath, inputPacketPath, inputWorktreePath, type IssueRuntimePaths } from "./paths.js";
import { gitShaSchema } from "./protocol.js";
import type { BoundInput } from "./steps.js";
import type { MaterializedInputEntry, MaterializedInputs, MaterializedWorktree } from "./steps.js";

export const MATERIALIZED_MARKDOWN_KINDS = new Set(["plan", "review", "selected-plan"]);
export const MATERIALIZED_PIN_KINDS = new Set(["implementation", "revision", "prior-revision", "consensus"]);

export type MaterializeMirror = Pick<BareMirror, "readBlob" | "materializeWorktree" | "removeWorktree">;

const packetHashPattern = /^[0-9a-f]{64}$/;

const canonicalMarkdownInputs = (inputs: readonly BoundInput[]): readonly BoundInput[] =>
  [...inputs.filter((input) => MATERIALIZED_MARKDOWN_KINDS.has(input.kind))].sort((left, right) =>
    `${left.kind}\0${left.agent}\0${left.commitSha}\0${left.path}`.localeCompare(
      `${right.kind}\0${right.agent}\0${right.commitSha}\0${right.path}`
    )
  );

export const computeMarkdownInputSetHash = (inputs: readonly BoundInput[]): string | null => {
  const markdown = canonicalMarkdownInputs(inputs);
  if (markdown.length === 0) return null;
  return sha256(
    markdown.map((input) => `${input.kind}\0${input.agent}\0${input.commitSha}\0${input.path}`).join("\n")
  );
};

const artifactDirName = (input: BoundInput): string => `${input.kind}-${input.agent}-${input.commitSha.slice(0, 8)}`;

const atomicWriteReadOnly = (coordRoot: string, target: string, content: string): void => {
  const safe = containedPath(coordRoot, relative(coordRoot, target));
  assertNoSymlink(coordRoot, dirname(safe));
  mkdirSync(dirname(safe), { recursive: true, mode: 0o700 });
  const temporary = containedPath(dirname(safe), `.${sha256(safe).slice(0, 16)}.tmp`);
  const handle = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(handle, content, "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, safe);
  chmodSync(safe, 0o444);
};

const lockDirectory = (coordRoot: string, target: string): void => {
  const safe = containedPath(coordRoot, relative(coordRoot, target));
  if (existsSync(safe)) chmodSync(safe, 0o555);
};

const readManifest = (
  manifestPath: string
): { inputSetHash: string; entries: MaterializedInputEntry[] } => {
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    inputSetHash?: string;
    entries?: MaterializedInputEntry[];
  };
  if (typeof parsed.inputSetHash !== "string" || !packetHashPattern.test(parsed.inputSetHash)) {
    throw new Error(`Invalid materialized manifest at ${manifestPath}.`);
  }
  if (!Array.isArray(parsed.entries)) throw new Error(`Invalid materialized manifest at ${manifestPath}.`);
  return { inputSetHash: parsed.inputSetHash, entries: parsed.entries };
};

const materializeMarkdownPacket = async (
  mirror: Pick<BareMirror, "readBlob">,
  paths: IssueRuntimePaths,
  inputs: readonly BoundInput[]
): Promise<{ inputSetHash: string | null; manifestPath: string | null; entries: MaterializedInputEntry[] }> => {
  const markdown = canonicalMarkdownInputs(inputs);
  if (markdown.length === 0) return { inputSetHash: null, manifestPath: null, entries: [] };

  const inputSetHash = computeMarkdownInputSetHash(inputs);
  if (inputSetHash === null) return { inputSetHash: null, manifestPath: null, entries: [] };

  const packetRoot = inputPacketPath(paths, inputSetHash);
  const manifestPath = join(packetRoot, "manifest.json");
  assertNoSymlink(paths.coordRoot, packetRoot);

  if (existsSync(manifestPath)) {
    const existing = readManifest(manifestPath);
    if (existing.inputSetHash !== inputSetHash) {
      throw new Error(`Materialized packet ${packetRoot} hash mismatch.`);
    }
    for (const entry of existing.entries) {
      if (!existsSync(entry.localPath) || sha256OfFile(entry.localPath) !== entry.sha256) {
        throw new Error(`Materialized packet ${packetRoot} is corrupt.`);
      }
    }
    lockDirectory(paths.coordRoot, packetRoot);
    return { inputSetHash, manifestPath, entries: existing.entries };
  }

  mkdirSync(packetRoot, { recursive: true, mode: 0o700 });
  const entries: MaterializedInputEntry[] = [];

  for (const input of markdown) {
    const blob = await mirror.readBlob(input.commitSha, input.path);
    if (blob === null) {
      throw new Error(`Missing mirror blob for ${input.kind} ${input.agent} at ${input.commitSha}:${input.path}.`);
    }
    const relativeRoot = join(artifactDirName(input), input.path);
    const localPath = containedPath(packetRoot, relativeRoot);
    atomicWriteReadOnly(paths.coordRoot, localPath, blob);
    entries.push({
      kind: input.kind,
      agent: input.agent,
      commitSha: input.commitSha,
      path: input.path,
      sha256: sha256(blob),
      localPath
    });
  }

  const manifestBody = `${JSON.stringify({ inputSetHash, entries }, null, 2)}\n`;
  atomicWriteReadOnly(paths.coordRoot, manifestPath, manifestBody);
  lockDirectory(paths.coordRoot, packetRoot);
  return { inputSetHash, manifestPath, entries };
};

const verifyWorktreeHead = (worktreePath: string, commitSha: string): boolean => {
  gitShaSchema.parse(commitSha);
  const result = git(worktreePath, "rev-parse", "HEAD");
  return result.exitCode === 0 && result.stdout.trim() === commitSha;
};

const materializePinWorktrees = async (
  mirror: MaterializeMirror,
  paths: IssueRuntimePaths,
  inputs: readonly BoundInput[]
): Promise<MaterializedWorktree[]> => {
  const pinned = inputs.filter((input) => MATERIALIZED_PIN_KINDS.has(input.kind));
  const worktrees: MaterializedWorktree[] = [];
  const seen = new Set<string>();

  for (const input of pinned) {
    gitShaSchema.parse(input.commitSha);
    const key = `${input.agent}\0${input.commitSha}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const localPath = inputWorktreePath(paths, input.agent, input.commitSha);
    assertNoSymlink(paths.coordRoot, localPath);

    if (existsSync(localPath)) {
      if (!verifyWorktreeHead(localPath, input.commitSha)) {
        throw new Error(`Worktree ${localPath} does not match pin ${input.commitSha}.`);
      }
      worktrees.push({ agent: input.agent, commitSha: input.commitSha, localPath });
      continue;
    }

    mkdirSync(dirname(localPath), { recursive: true, mode: 0o700 });
    await mirror.materializeWorktree(localPath, input.commitSha);
    if (!verifyWorktreeHead(localPath, input.commitSha)) {
      throw new Error(`Worktree materialization failed for ${input.commitSha} at ${localPath}.`);
    }
    worktrees.push({ agent: input.agent, commitSha: input.commitSha, localPath });
  }

  return worktrees;
};

export const materializeBoundInputs = async (input: {
  mirror: MaterializeMirror;
  paths: IssueRuntimePaths;
  inputs: readonly BoundInput[];
}): Promise<MaterializedInputs> => {
  const markdown = await materializeMarkdownPacket(input.mirror, input.paths, input.inputs);
  const worktrees = await materializePinWorktrees(input.mirror, input.paths, input.inputs);
  const readPaths = [
    ...(markdown.manifestPath === null ? [] : [markdown.manifestPath]),
    ...markdown.entries.map((entry) => entry.localPath),
    ...worktrees.map((worktree) => worktree.localPath)
  ];
  return {
    inputSetHash: markdown.inputSetHash,
    manifestPath: markdown.manifestPath,
    entries: markdown.entries,
    worktrees,
    readPaths
  };
};

export const worktreeKeepKey = (agent: string, commitSha: string): string => `${agent}\0${commitSha}`;

/** Restore write permission so issue teardown can remove read-only materialization trees. */
export const unlockDirectoryTree = (root: string): void => {
  if (!existsSync(root)) return;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    try {
      chmodSync(current, 0o700);
    } catch {
      // Best effort: a concurrent teardown may already be removing this tree.
    }
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of entries) {
      const child = join(current, name);
      try {
        if (statSync(child).isDirectory()) pending.push(child);
        else chmodSync(child, 0o600);
      } catch {
        // ignore unreadable entries
      }
    }
  }
};

export const pruneSupersededWorktrees = async (input: {
  mirror: Pick<BareMirror, "removeWorktree">;
  paths: IssueRuntimePaths;
  keep: ReadonlySet<string>;
}): Promise<void> => {
  if (!existsSync(input.paths.worktreesRoot)) return;
  for (const name of readdirSync(input.paths.worktreesRoot)) {
    const localPath = join(input.paths.worktreesRoot, name);
    const marker = name.match(/^([a-z][a-z0-9-]{0,63})-([0-9a-f]{8})$/);
    if (marker === null) continue;
    const head = git(localPath, "rev-parse", "HEAD");
    if (head.exitCode !== 0) continue;
    const key = worktreeKeepKey(marker[1] as string, head.stdout.trim());
    if (input.keep.has(key)) continue;
    await input.mirror.removeWorktree(localPath);
    rmSync(localPath, { recursive: true, force: true });
  }
};

export const removeIssueMaterialization = async (input: {
  mirror: Pick<BareMirror, "removeWorktree">;
  paths: IssueRuntimePaths;
}): Promise<void> => {
  unlockDirectoryTree(input.paths.inputsRoot);
  unlockDirectoryTree(input.paths.worktreesRoot);
  if (existsSync(input.paths.worktreesRoot)) {
    for (const name of readdirSync(input.paths.worktreesRoot)) {
      const localPath = join(input.paths.worktreesRoot, name);
      try {
        await input.mirror.removeWorktree(localPath);
      } catch {
        // Best effort: the runtime tree may already be partially removed.
      }
    }
  }
  try {
    git(input.paths.mirror, "worktree", "prune");
  } catch {
    // Tests and dry mirrors may not have git available at the mirror path.
  }
};

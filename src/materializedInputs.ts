import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";
import { sha256 } from "./hash.js";
import type { BareMirror } from "./mirror.js";
import {
  assertNoSymlink,
  containedPath,
  inputPacketPath,
  inputWorktreePath,
  isPathInside,
  type IssueRuntimePaths
} from "./paths.js";
import type {
  BoundInput,
  MaterializedInputEntry,
  MaterializedInputs,
  MaterializedWorktree
} from "./steps.js";

export const MATERIALIZED_MARKDOWN_KINDS = new Set(["plan", "review", "selected-plan"]);
export const MATERIALIZED_PIN_KINDS = new Set(["implementation", "revision", "prior-revision", "consensus"]);

type MaterializationMirror = Pick<BareMirror, "readBlob" | "materializeWorktree" | "removeWorktree">;

type InputManifest = {
  inputSetHash: string;
  entries: MaterializedInputEntry[];
};

const shaPattern = /^[0-9a-f]{40}$/;
const agentPattern = /^[a-z][a-z0-9-]{0,63}$/;

const markdownInputs = (inputs: readonly BoundInput[]): BoundInput[] =>
  inputs
    .filter((input) => MATERIALIZED_MARKDOWN_KINDS.has(input.kind))
    .sort((left, right) => inputIdentity(left).localeCompare(inputIdentity(right)));

const pinInputs = (inputs: readonly BoundInput[]): BoundInput[] =>
  inputs
    .filter((input) => MATERIALIZED_PIN_KINDS.has(input.kind))
    .sort((left, right) => inputIdentity(left).localeCompare(inputIdentity(right)));

const inputIdentity = (input: BoundInput): string =>
  `${input.kind}\0${input.agent}\0${input.commitSha}\0${input.path}`;

export const computeInputSetHash = (inputs: readonly BoundInput[]): string =>
  sha256(markdownInputs(inputs).map(inputIdentity).join("\n"));

const makeTreeReadOnly = (root: string): void => {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    chmodSync(root, stat.mode & 0o111 ? 0o500 : 0o400);
    return;
  }
  for (const entry of readdirSync(root)) makeTreeReadOnly(join(root, entry));
  // Keep directories owner-writable so normal recursive teardown can unlink
  // their read-only children. File modes prevent in-place edits; packet hashes
  // are revalidated before reuse.
  chmodSync(root, 0o700);
};

const makeTreeWritable = (root: string): void => {
  if (!existsSync(root)) return;
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    chmodSync(root, stat.mode & 0o111 ? 0o700 : 0o600);
    return;
  }
  chmodSync(root, 0o700);
  for (const entry of readdirSync(root)) makeTreeWritable(join(root, entry));
};

const parseManifest = (
  path: string,
  packet: string,
  inputSetHash: string,
  expectedInputs: readonly BoundInput[]
): InputManifest => {
  const value = JSON.parse(readFileSync(path, "utf8")) as Partial<InputManifest>;
  if (value.inputSetHash !== inputSetHash || !Array.isArray(value.entries)) {
    throw new Error(`Materialized input manifest ${path} does not match ${inputSetHash}.`);
  }
  for (const entry of value.entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.kind !== "string" ||
      typeof entry.agent !== "string" ||
      typeof entry.commitSha !== "string" ||
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string" ||
      typeof entry.localPath !== "string" ||
      !isPathInside(packet, entry.localPath) ||
      !existsSync(entry.localPath) ||
      sha256(readFileSync(entry.localPath)) !== entry.sha256
    ) {
      throw new Error(`Materialized input manifest ${path} contains a missing, modified, or invalid entry.`);
    }
  }
  const actualIdentities = value.entries.map(inputIdentity).sort();
  const expectedIdentities = expectedInputs.map(inputIdentity).sort();
  if (JSON.stringify(actualIdentities) !== JSON.stringify(expectedIdentities)) {
    throw new Error(`Materialized input manifest ${path} does not contain the bound input set.`);
  }
  return value as InputManifest;
};

const materializeMarkdown = async (
  mirror: Pick<MaterializationMirror, "readBlob">,
  paths: IssueRuntimePaths,
  inputs: readonly BoundInput[]
): Promise<{ inputSetHash: string | null; manifestPath: string | null; entries: MaterializedInputEntry[] }> => {
  const selected = markdownInputs(inputs);
  if (selected.length === 0) return { inputSetHash: null, manifestPath: null, entries: [] };

  const inputSetHash = computeInputSetHash(selected);
  const packet = inputPacketPath(paths, inputSetHash);
  const manifestPath = containedPath(packet, "manifest.json");
  if (existsSync(manifestPath)) {
    return { inputSetHash, manifestPath, entries: parseManifest(manifestPath, packet, inputSetHash, selected).entries };
  }

  if (existsSync(packet)) {
    makeTreeWritable(packet);
    rmSync(packet, { recursive: true, force: true });
  }
  const staging = mkdtempSync(join(paths.issueInputsRoot, ".packet-"));
  const entries: MaterializedInputEntry[] = [];
  try {
    for (const input of selected) {
      if (!agentPattern.test(input.agent) || !shaPattern.test(input.commitSha)) {
        throw new Error(`Invalid bound input identity for ${input.agent} at ${input.commitSha}.`);
      }
      const content = await mirror.readBlob(input.commitSha, input.path);
      if (content === null) {
        throw new Error(`Bound input ${input.commitSha}:${input.path} is missing from the coordinator mirror.`);
      }
      const relativeRoot = `${input.kind}-${input.agent}-${input.commitSha.slice(0, 8)}`;
      const stagedPath = containedPath(staging, relativeRoot, input.path);
      const localPath = containedPath(packet, relativeRoot, input.path);
      mkdirSync(dirname(stagedPath), { recursive: true, mode: 0o700 });
      writeFileSync(stagedPath, content, { encoding: "utf8", mode: 0o600 });
      entries.push({ ...input, sha256: sha256(content), localPath });
    }
    writeFileSync(containedPath(staging, "manifest.json"), `${JSON.stringify({ inputSetHash, entries }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    makeTreeReadOnly(staging);
    renameSync(staging, packet);
  } catch (error) {
    makeTreeWritable(staging);
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { inputSetHash, manifestPath, entries };
};

const materializeWorktrees = async (
  mirror: Pick<MaterializationMirror, "materializeWorktree">,
  paths: IssueRuntimePaths,
  inputs: readonly BoundInput[]
): Promise<MaterializedWorktree[]> => {
  const worktrees: MaterializedWorktree[] = [];
  for (const input of pinInputs(inputs)) {
    const localPath = inputWorktreePath(paths, input.agent, input.commitSha);
    assertNoSymlink(paths.coordRoot, localPath);
    if (!existsSync(localPath)) {
      await mirror.materializeWorktree(localPath, input.commitSha);
      makeTreeReadOnly(localPath);
    }
    worktrees.push({ kind: input.kind, agent: input.agent, commitSha: input.commitSha, localPath });
  }
  return worktrees;
};

export const materializeBoundInputs = async (input: {
  mirror: MaterializationMirror;
  paths: IssueRuntimePaths;
  inputs: readonly BoundInput[];
}): Promise<MaterializedInputs> => {
  const packet = await materializeMarkdown(input.mirror, input.paths, input.inputs);
  const worktrees = await materializeWorktrees(input.mirror, input.paths, input.inputs);
  return { ...packet, worktrees };
};

export const pruneSupersededWorktrees = async (input: {
  mirror: Pick<MaterializationMirror, "removeWorktree">;
  paths: IssueRuntimePaths;
  keep: readonly BoundInput[];
}): Promise<void> => {
  if (!existsSync(input.paths.issueWorktreesRoot)) return;
  const keep = new Set(pinInputs(input.keep).map((entry) => inputWorktreePath(input.paths, entry.agent, entry.commitSha)));
  for (const entry of readdirSync(input.paths.issueWorktreesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = containedPath(input.paths.issueWorktreesRoot, entry.name);
    if (keep.has(target)) continue;
    makeTreeWritable(target);
    await input.mirror.removeWorktree(target);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      await input.mirror.removeWorktree(target);
    }
  }
};

/** Restore owner write bits immediately before the issue runtime is removed. */
export const makeMaterializedRootsWritable = (paths: IssueRuntimePaths): void => {
  makeTreeWritable(paths.issueInputsRoot);
  makeTreeWritable(paths.issueWorktreesRoot);
};

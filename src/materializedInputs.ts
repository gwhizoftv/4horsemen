import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256 } from "./hash.js";
import { containedPath, inputPacketPath, inputWorktreePath, type IssueRuntimePaths } from "./paths.js";
import type { BareMirror } from "./mirror.js";
import type { BoundInput, MaterializedInputEntry, MaterializedInputs, MaterializedWorktree } from "./steps.js";

export const MATERIALIZED_MARKDOWN_KINDS = ["plan", "review", "selected-plan"] as const;
export type MaterializedMarkdownKind = (typeof MATERIALIZED_MARKDOWN_KINDS)[number];

export const MATERIALIZED_PIN_KINDS = ["implementation", "revision", "prior-revision", "consensus"] as const;
export type MaterializedPinKind = (typeof MATERIALIZED_PIN_KINDS)[number];

const isMarkdownKind = (kind: string): kind is MaterializedMarkdownKind =>
  (MATERIALIZED_MARKDOWN_KINDS as readonly string[]).includes(kind);

const isPinKind = (kind: string): kind is MaterializedPinKind =>
  (MATERIALIZED_PIN_KINDS as readonly string[]).includes(kind);

export const computeInputSetHash = (inputs: readonly BoundInput[]): string => {
  const lines = inputs
    .filter((input) => isMarkdownKind(input.kind))
    .map((input) => `${input.kind}\0${input.agent}\0${input.commitSha}\0${input.path}`)
    .sort();
  return sha256(lines.join("\n"));
};

export type MaterializeBoundInputsOptions = {
  mirror: Pick<BareMirror, "readBlob" | "materializeWorktree">;
  paths: IssueRuntimePaths;
  inputs: readonly BoundInput[];
};

export const materializeBoundInputs = async ({
  mirror,
  paths,
  inputs
}: MaterializeBoundInputsOptions): Promise<MaterializedInputs> => {
  const markdownInputs = inputs.filter((input) => isMarkdownKind(input.kind));
  const pinInputs = inputs.filter((input) => isPinKind(input.kind));

  let inputSetHash: string | null = null;
  const entries: MaterializedInputEntry[] = [];

  if (markdownInputs.length > 0) {
    inputSetHash = computeInputSetHash(markdownInputs);
    const packetDir = inputPacketPath(paths, inputSetHash);
    const manifestPath = join(packetDir, "manifest.json");

    if (existsSync(manifestPath)) {
      try {
        const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          entries?: MaterializedInputEntry[];
        };
        if (Array.isArray(parsed.entries)) {
          entries.push(...parsed.entries);
        }
      } catch {
        // If manifest read fails, re-materialize into temporary directory
      }
    }

    if (entries.length === 0) {
      const staging = containedPath(paths.issueInputsRoot, `.${inputSetHash}.${randomUUID()}.tmp`);
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      try {
        for (const input of markdownInputs) {
          const content = await mirror.readBlob(input.commitSha, input.path);
          if (content === null) continue;
          const folderName = `${input.kind}-${input.agent}-${input.commitSha.slice(0, 8)}`;
          const stagedFilePath = join(staging, folderName, input.path);
          mkdirSync(dirname(stagedFilePath), { recursive: true, mode: 0o700 });
          writeFileSync(stagedFilePath, content, { mode: 0o400 });
          const localPath = join(packetDir, folderName, input.path);
          entries.push({
            kind: input.kind,
            agent: input.agent,
            commitSha: input.commitSha,
            path: input.path,
            sha256: sha256(content),
            localPath
          });
        }
        if (entries.length > 0) {
          writeFileSync(join(staging, "manifest.json"), `${JSON.stringify({ inputSetHash, entries }, null, 2)}\n`, {
            mode: 0o400
          });
          renameSync(staging, packetDir);
        } else {
          rmSync(staging, { recursive: true, force: true });
        }
      } catch (error) {
        rmSync(staging, { recursive: true, force: true });
        throw error;
      }
    }
  }

  const worktrees: MaterializedWorktree[] = [];
  const seenWorktrees = new Set<string>();

  for (const input of pinInputs) {
    const key = `${input.agent}-${input.commitSha}`;
    if (seenWorktrees.has(key)) continue;
    seenWorktrees.add(key);

    const target = inputWorktreePath(paths, input.agent, input.commitSha);
    if (!existsSync(target)) {
      await mirror.materializeWorktree(target, input.commitSha);
    }
    worktrees.push({
      agent: input.agent,
      commitSha: input.commitSha,
      localPath: target
    });
  }

  return { inputSetHash, entries, worktrees };
};

export type PruneSupersededWorktreesOptions = {
  mirror: Pick<BareMirror, "removeWorktree">;
  paths: IssueRuntimePaths;
  keep: readonly BoundInput[];
};

export const pruneSupersededWorktrees = async ({
  mirror,
  paths,
  keep
}: PruneSupersededWorktreesOptions): Promise<string[]> => {
  if (!existsSync(paths.issueWorktreesRoot)) return [];
  const keepPaths = new Set(
    keep.filter((input) => isPinKind(input.kind)).map((input) => inputWorktreePath(paths, input.agent, input.commitSha))
  );
  const removed: string[] = [];
  for (const name of readdirSync(paths.issueWorktreesRoot)) {
    if (name.startsWith(".")) continue;
    const target = containedPath(paths.issueWorktreesRoot, name);
    if (!keepPaths.has(target)) {
      await mirror.removeWorktree(target);
      removed.push(target);
    }
  }
  return removed;
};

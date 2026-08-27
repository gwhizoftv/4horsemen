import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { sha256 } from "./hash.js";
import type { BareMirror } from "./mirror.js";
import {
  assertNoSymlink,
  containedPath,
  inputPacketPath,
  inputWorktreePath,
  type IssueRuntimePaths
} from "./paths.js";
import type { BoundInput, MaterializedInputEntry, MaterializedInputs, MaterializedWorktree } from "./steps.js";

/**
 * Bound inputs whose `commitSha`/`path` names a coordination document. These are
 * small, and are exported as files.
 */
export const MATERIALIZED_MARKDOWN_KINDS: ReadonlySet<string> = new Set(["plan", "review", "selected-plan"]);

/**
 * Bound inputs whose `commitSha` is a product pin. These are exported as
 * complete detached worktrees: comparing or revising an implementation needs
 * imports, tests, and configuration that a list of changed paths does not carry.
 */
export const MATERIALIZED_PIN_KINDS: ReadonlySet<string> = new Set([
  "implementation",
  "revision",
  "prior-revision",
  "consensus"
]);

/** The subset of the mirror this module needs; a test can supply a stub. */
export type MaterializationMirror = Pick<BareMirror, "readBlob" | "materializeWorktree" | "removeWorktree">;

const canonical = (input: BoundInput): string =>
  [input.kind, input.agent, input.commitSha, input.path].join(" ");

/**
 * Identity of a packet: the set of coordination documents actually inside it.
 *
 * Deliberately not `computeInputSetHash` from `src/evidence.ts`, which hashes
 * every bound input including product pins. A comparison action binds only pins,
 * so keying a document packet by that value would name a directory holding
 * nothing, whose hash still changed for reasons the directory does not contain.
 */
export const computeInputSetHash = (inputs: readonly BoundInput[]): string =>
  sha256(
    inputs
      .filter((input) => MATERIALIZED_MARKDOWN_KINDS.has(input.kind))
      .map(canonical)
      .sort()
      .join("\n")
  );

/** Directory label for one document inside a packet. */
const entryDirectory = (input: BoundInput): string =>
  `${input.kind}-${input.agent}-${input.commitSha.slice(0, 8)}`;

/**
 * Files are written `0o400`; directories stay `0o700`.
 *
 * The file mode is what stops a harness rewriting materialized content in place.
 * Making the *directory* read-only would additionally stop the coordinator
 * deleting it later: `rmSync` then fails with ENOTEMPTY and `git worktree
 * remove` with a permission error, which turns issue teardown into a hard
 * failure. What keeps these trees safe to grant is that they hold nothing but
 * copies of artifacts already bound into the reading agent's own action.
 */
const writeReadOnlyFile = (path: string, contents: string): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o400 });
};

/**
 * Export everything the current action binds into the issue runtime.
 *
 * Documents go to `inputs/<hash>/`, content-addressed so re-preparing the same
 * action reuses the packet rather than rewriting bytes an agent may be reading.
 * Product pins go to `worktrees/<agent>-<sha8>/`, one per distinct pin, so four
 * agents comparing the same four pins cost four worktrees rather than sixteen.
 *
 * An input that cannot be produced is omitted and named in `omitted`, never
 * fatal — the same rule `resolveChangeScope` follows, and for the same reason:
 * this is convenience state, the pins in the action remain the authority, and
 * failing preparation would stall every agent on the step over a read none of
 * them needed. The wrapper keeps `git show <sha>:<path>` available precisely so
 * an omitted input still has a route. The invariant that matters is the one this
 * preserves: every path the action lists exists on disk.
 */
type PacketManifest = { entries: MaterializedInputEntry[]; omitted: string[] };

/**
 * Read a finished packet's own record of itself.
 *
 * Returns null for anything unreadable or shaped wrong, so a damaged packet is
 * simply rebuilt rather than trusted.
 */
const readPacketManifest = (manifestPath: string): PacketManifest | null => {
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      entries?: unknown;
      omitted?: unknown;
    };
    if (!Array.isArray(parsed.entries)) return null;
    const entries = parsed.entries as MaterializedInputEntry[];
    if (entries.some((entry) => typeof entry?.localPath !== "string" || !existsSync(entry.localPath))) {
      return null;
    }
    const omitted = Array.isArray(parsed.omitted) ? (parsed.omitted as string[]) : [];
    return { entries, omitted };
  } catch {
    return null;
  }
};

export const materializeBoundInputs = async (input: {
  mirror: MaterializationMirror;
  paths: IssueRuntimePaths;
  inputs: readonly BoundInput[];
}): Promise<MaterializedInputs> => {
  const omitted: string[] = [];
  const documents = input.inputs.filter((bound) => MATERIALIZED_MARKDOWN_KINDS.has(bound.kind));

  let inputSetHash: string | null = null;
  let packetDir: string | null = null;
  let manifestPath: string | null = null;
  let entries: MaterializedInputEntry[] = [];

  if (documents.length > 0) {
    // Hashed from the bound set alone, so the packet a given action needs is
    // named before anything is read. That is what lets an existing packet be
    // recognised without touching the mirror at all.
    inputSetHash = computeInputSetHash(documents);
    packetDir = inputPacketPath(input.paths, inputSetHash);
    manifestPath = containedPath(packetDir, "manifest.json");

    const reused = readPacketManifest(manifestPath);
    if (reused !== null) {
      // The packet is immutable and content-addressed, so its manifest is a
      // complete record of it. Re-reading each blob to rebuild the same entries
      // would put one `git show` per bound document on every single action
      // preparation — the exact per-read cost this whole change exists to
      // remove, moved from the agents onto the coordinator.
      entries = reused.entries;
      omitted.push(...reused.omitted);
    } else {
      const staging = containedPath(input.paths.issueInputsRoot, `.${randomUUID()}.tmp`);
      assertNoSymlink(input.paths.coordRoot, packetDir);
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      try {
        for (const bound of documents) {
          const blob = await input.mirror.readBlob(bound.commitSha, bound.path);
          if (blob === null) {
            omitted.push(`${bound.kind} from ${bound.agent}: ${bound.commitSha}:${bound.path} is unreadable`);
            continue;
          }
          const relative = join(entryDirectory(bound), bound.path);
          writeReadOnlyFile(containedPath(staging, relative), blob);
          entries.push({ ...bound, sha256: sha256(blob), localPath: containedPath(packetDir, relative) });
        }
        writeReadOnlyFile(
          containedPath(staging, "manifest.json"),
          `${JSON.stringify({ inputSetHash, entries, omitted }, null, 2)}\n`
        );
        mkdirSync(dirname(packetDir), { recursive: true, mode: 0o700 });
        renameSync(staging, packetDir);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
  }

  const worktrees: MaterializedWorktree[] = [];
  const seen = new Set<string>();
  for (const bound of input.inputs) {
    if (!MATERIALIZED_PIN_KINDS.has(bound.kind)) continue;
    if (seen.has(bound.commitSha)) continue;
    seen.add(bound.commitSha);
    const localPath = inputWorktreePath(input.paths, bound.agent, bound.commitSha);
    if (!existsSync(localPath)) {
      assertNoSymlink(input.paths.coordRoot, localPath);
      mkdirSync(dirname(localPath), { recursive: true, mode: 0o700 });
      try {
        await input.mirror.materializeWorktree(localPath, bound.commitSha);
      } catch (error) {
        rmSync(localPath, { recursive: true, force: true });
        omitted.push(
          `${bound.kind} worktree from ${bound.agent} at ${bound.commitSha}: ${(error as Error).message}`
        );
        continue;
      }
    }
    worktrees.push({ kind: bound.kind, agent: bound.agent, commitSha: bound.commitSha, localPath });
  }

  return { inputSetHash, packetDir, manifestPath, entries, worktrees, omitted };
};

/** Directory labels the given inputs require; anything else is superseded. */
export const worktreeLabelsFor = (paths: IssueRuntimePaths, inputs: readonly BoundInput[]): Set<string> =>
  new Set(
    inputs
      .filter((bound) => MATERIALIZED_PIN_KINDS.has(bound.kind))
      .map((bound) => basename(inputWorktreePath(paths, bound.agent, bound.commitSha)))
  );

/**
 * Drop worktrees no longer bound by any current action.
 *
 * Unregistering through the mirror comes first and deleting second: pruning a
 * registration whose directory still exists collects nothing, so the reverse
 * order leaves exactly the dangling entries this is meant to prevent.
 */
export const pruneSupersededWorktrees = async (input: {
  mirror: Pick<BareMirror, "removeWorktree">;
  paths: IssueRuntimePaths;
  keep: ReadonlySet<string>;
}): Promise<string[]> => {
  if (!existsSync(input.paths.issueWorktreesRoot)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(input.paths.issueWorktreesRoot)) {
    if (input.keep.has(name)) continue;
    const target = containedPath(input.paths.issueWorktreesRoot, name);
    await input.mirror.removeWorktree(target);
    rmSync(target, { recursive: true, force: true });
    removed.push(target);
  }
  return removed;
};

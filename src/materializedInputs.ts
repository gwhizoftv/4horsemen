import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { git } from "./gitExec.js";
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
export const MATERIALIZED_MARKDOWN_KINDS: ReadonlySet<string> = new Set([
  "plan",
  "review",
  "selected-plan",
  "amendment-request",
  "amendment-ballot"
]);

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
const readPacketManifest = (
  manifestPath: string,
  inputSetHash: string,
  expected: readonly BoundInput[]
): PacketManifest | null => {
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      inputSetHash?: unknown;
      entries?: unknown;
      omitted?: unknown;
    };
    // Identity first: a packet that does not claim to be this input set is not
    // this input set, whatever its directory is called.
    if (parsed.inputSetHash !== inputSetHash) return null;
    if (!Array.isArray(parsed.entries)) return null;
    const entries = parsed.entries as MaterializedInputEntry[];
    const wanted = new Set(expected.map((bound) => `${bound.kind}\0${bound.agent}\0${bound.commitSha}\0${bound.path}`));
    if (entries.length !== wanted.size) return null;
    for (const entry of entries) {
      if (typeof entry?.localPath !== "string" || typeof entry.sha256 !== "string") return null;
      if (!wanted.has(`${entry.kind}\0${entry.agent}\0${entry.commitSha}\0${entry.path}`)) return null;
      if (!existsSync(entry.localPath)) return null;
      // The digest, not merely the path. Checking only that a file is present
      // lets a packet whose bytes were replaced be handed to every agent on the
      // step as verified peer input, under a pin that still looks correct.
      if (sha256(readFileSync(entry.localPath, "utf8")) !== entry.sha256) return null;
    }
    const omitted = Array.isArray(parsed.omitted) ? (parsed.omitted as string[]) : [];
    return { entries, omitted };
  } catch {
    return null;
  }
};

/**
 * The commit a materialized worktree actually holds, or null if it cannot be
 * read. Uses the scrubbed synchronous runner, so an ambient `GIT_DIR` cannot
 * redirect the answer at the one place it would matter most.
 */
const worktreeHead = (localPath: string): string | null => {
  const result = git(localPath, "rev-parse", "HEAD");
  if (result.exitCode !== 0) return null;
  const head = result.stdout.trim();
  return /^[0-9a-f]{40}$/.test(head) ? head : null;
};

/**
 * Make every file under a materialized tree read-only, leaving directories
 * writable.
 *
 * Directory modes are deliberately untouched: a read-only directory stops the
 * coordinator unlinking its own children, which turns `git worktree remove` and
 * issue teardown into hard failures. File modes stop an agent editing a peer's
 * materialized copy in place, which is the realistic accident. It is a speed
 * bump rather than a guarantee — the granted parent stays writable — so it is
 * not relied on for anything.
 */
const makeFilesReadOnly = (root: string): void => {
  let stat;
  try {
    stat = lstatSync(root);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    try {
      chmodSync(root, stat.mode & 0o111 ? 0o500 : 0o400);
    } catch {
      // A file we cannot chmod is not worth failing preparation over.
    }
    return;
  }
  for (const entry of readdirSync(root)) makeFilesReadOnly(join(root, entry));
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

    const reused = readPacketManifest(manifestPath, inputSetHash, documents);
    if (reused === null && existsSync(packetDir)) {
      // Present but not trustworthy: identity, coverage, or a digest did not
      // hold. Rebuild rather than serve it, and say so — a packet that changed
      // under a content address is worth an operator seeing.
      omitted.push(`packet ${packetDir} failed validation and was rebuilt`);
      rmSync(packetDir, { recursive: true, force: true });
    }
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
    if (existsSync(localPath) && worktreeHead(localPath) !== bound.commitSha) {
      // `<agent>-<sha8>` is not a unique function of the pin: two pins for one
      // agent sharing eight hex characters resolve here. Reusing on the path
      // alone would let an action cite one commit while pointing every reader
      // at another's tree — wrong code, correct-looking SHA, no symptom.
      await input.mirror.removeWorktree(localPath);
      rmSync(localPath, { recursive: true, force: true });
    }
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
      makeFilesReadOnly(localPath);
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

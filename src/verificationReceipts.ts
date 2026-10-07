import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { isCoordinationEvidencePath } from "./changeClassification.js";
import { sha256 } from "./hash.js";
import { hermeticGitEnv } from "./mirror.js";
import { assertNoSymlink, containedPath } from "./paths.js";
import { atomicWriteJson } from "./state.js";

/**
 * Coordinator verification receipts: successful results of one declared
 * command for one equivalent input set. They live under the coordinator root,
 * never in a clone, are written only by the coordinator runner, and are
 * re-validated on every read. A receipt is never inferred from a hook record,
 * an agent signal, a missing process, or a failed or interrupted run.
 */

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const receiptKeyMaterialSchema = z.object({
  v: z.literal(1),
  origin: z.string().min(1),
  inputsMode: z.enum(["tree", "tree-excluding-evidence"]),
  inputIdentity: z.string().min(1),
  /** Declared argv: the executed one embeds a random worktree path. */
  argv: z.array(z.string()).min(1),
  policyDigest: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  node: z.string().min(1),
  probes: z.array(z.object({ argv: z.array(z.string()).min(1), stdout: z.string() }).strict()),
  /** Digests, not values: receipts must not copy secrets out of the environment. */
  env: z.array(z.object({ name: z.string().min(1), value: hex64.nullable() }).strict()),
  /** Declared untracked inputs (for example installed dependencies) as found when the command ran. */
  dependencies: hex64
}).strict();
export type ReceiptKeyMaterial = z.infer<typeof receiptKeyMaterialSchema>;

export const receiptSchema = z.object({
  formatVersion: z.literal(1),
  key: hex64,
  material: receiptKeyMaterialSchema,
  name: z.string().min(1),
  exitCode: z.literal(0),
  durationMs: z.number().int().nonnegative(),
  issue: z.number().int().positive(),
  issueSessionId: z.string().min(1),
  productPin: z.string().regex(/^[0-9a-f]{40}$/),
  logPath: z.string().min(1),
  completedAt: z.iso.datetime({ offset: true })
}).strict();
export type Receipt = z.infer<typeof receiptSchema>;

/** Fixed key order, so equal material always hashes to the same key. */
export const receiptKey = (material: ReceiptKeyMaterial): string => sha256(JSON.stringify({
  v: material.v, origin: material.origin, inputsMode: material.inputsMode, inputIdentity: material.inputIdentity,
  argv: material.argv, policyDigest: material.policyDigest, platform: material.platform, arch: material.arch,
  node: material.node, probes: material.probes.map((probe) => ({ argv: probe.argv, stdout: probe.stdout })),
  env: material.env.map((entry) => ({ name: entry.name, value: entry.value })),
  dependencies: material.dependencies
}));

export const envDigests = (names: readonly string[], env: NodeJS.ProcessEnv = process.env): ReceiptKeyMaterial["env"] =>
  names.map((name) => ({ name, value: env[name] === undefined ? null : sha256(env[name]) }));

/**
 * Digest of declared untracked inputs in a worktree, such as installed
 * dependencies: names, modes, file bytes and symlink targets, recursively.
 * The worktree's own path is normalized out of file bytes and link targets,
 * because tools such as package-manager shims embed it and each verification
 * runs in a fresh worktree. Symlinks are recorded, not followed, and must
 * resolve inside the declared paths, whose contents are hashed in place; an
 * escaping link, a special file or an unreadable entry throws, which makes the
 * command uncached rather than keyed on something unverified.
 */
export const dependencyIdentity = (worktree: string, paths: readonly string[]): string => {
  const root = realpathSync(worktree);
  const roots = [...new Set([root, worktree])].map((path) => Buffer.from(path)).sort((a, b) => b.length - a.length);
  const declared = [...paths].sort();
  const covered = declared.map((path) => containedPath(root, path));
  const hash = createHash("sha256");
  const field = (value: string | Buffer) => hash.update(`${Buffer.byteLength(value)}:`).update(value);
  const normalized = (bytes: Buffer): Buffer => {
    let out = bytes;
    for (const prefix of roots) {
      const parts: Buffer[] = [];
      let from = 0;
      for (let at = out.indexOf(prefix); at >= 0; at = out.indexOf(prefix, from)) {
        parts.push(out.subarray(from, at), Buffer.from("\0worktree\0"));
        from = at + prefix.length;
      }
      if (from > 0) out = Buffer.concat([...parts, out.subarray(from)]);
    }
    return out;
  };
  const walk = (path: string): void => {
    const stat = lstatSync(path);
    field(String(stat.mode));
    if (stat.isSymbolicLink()) {
      const real = realpathSync(path);
      if (!covered.some((base) => real === base || real.startsWith(`${base}/`))) {
        throw new Error(`dependency input ${path} links outside the declared dependency paths`);
      }
      field(normalized(Buffer.from(readlinkSync(path))));
      return;
    }
    if (stat.isFile()) { field(normalized(readFileSync(path))); return; }
    if (!stat.isDirectory()) throw new Error(`dependency input ${path} is not a file or directory`);
    for (const name of readdirSync(path).sort()) { field(name); walk(join(path, name)); }
  };
  for (const [index, name] of declared.entries()) {
    field(name);
    const path = covered[index]!;
    if (!existsSync(path)) field("missing");
    else walk(path);
  }
  return hash.digest("hex");
};

const mirrorGit = (mirrorPath: string, args: readonly string[]) =>
  spawnSync("git", args, { cwd: mirrorPath, encoding: "buffer", env: hermeticGitEnv(), maxBuffer: 256 * 1024 * 1024 });

/** `tree` is the pin's tree id. `tree-excluding-evidence` digests the raw
 * `ls-tree` records except coordination evidence; a path that does not decode
 * is kept, so an undecodable name can only make inputs differ. */
export const computeInputIdentity = (mirrorPath: string, pin: string, mode: "tree" | "tree-excluding-evidence"): string => {
  if (!/^[0-9a-f]{40}$/.test(pin)) throw new Error(`Invalid pin ${pin}.`);
  if (mode === "tree") {
    const tree = mirrorGit(mirrorPath, ["rev-parse", "--verify", `${pin}^{tree}`]);
    if (tree.status !== 0) throw new Error(`Cannot resolve the tree of ${pin}.`);
    return `tree:${tree.stdout.toString("utf8").trim()}`;
  }
  const listing = mirrorGit(mirrorPath, ["ls-tree", "-r", "-z", "--full-tree", pin]);
  if (listing.status !== 0) throw new Error(`Cannot list the tree of ${pin}.`);
  const kept: Buffer[] = [];
  let start = 0;
  const bytes = listing.stdout;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 0) continue;
    const record = bytes.subarray(start, index);
    start = index + 1;
    const tab = record.indexOf(9);
    const pathBytes = tab < 0 ? record : record.subarray(tab + 1);
    const path = pathBytes.toString("utf8");
    if (Buffer.from(path).equals(pathBytes) && isCoordinationEvidencePath(path)) continue;
    kept.push(record, Buffer.from([0]));
  }
  return `tree-excluding-evidence:${sha256(Buffer.concat(kept))}`;
};

const verificationRoot = (coordRoot: string, ...parts: string[]) => containedPath(coordRoot, "verification", ...parts);
export const receiptPath = (coordRoot: string, key: string) => verificationRoot(coordRoot, "receipts", `${hex64.parse(key)}.json`);
export const runningLockPath = (coordRoot: string, key: string) => verificationRoot(coordRoot, "running", `${hex64.parse(key)}.lock`);
export const slotLockPath = (coordRoot: string, slot: number) => verificationRoot(coordRoot, "slots", `slot-${slot}.lock`);

export type ReceiptRead = { status: "hit"; receipt: Receipt } | { status: "miss"; reason: string };

/** Any unreadable, malformed, mismatched or failed record is a miss, never a pass. */
export const readReceipt = (coordRoot: string, key: string): ReceiptRead => {
  const path = receiptPath(coordRoot, key);
  if (!existsSync(path)) return { status: "miss", reason: "no receipt" };
  try {
    assertNoSymlink(coordRoot, path);
    const receipt = receiptSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (receipt.key !== key || receiptKey(receipt.material) !== key) return { status: "miss", reason: "receipt key material does not match" };
    return { status: "hit", receipt };
  } catch (error) {
    return { status: "miss", reason: `unreadable receipt: ${error instanceof Error ? error.message : String(error)}` };
  }
};

export const writeReceipt = (coordRoot: string, receipt: Receipt): void => {
  const parsed = receiptSchema.parse(receipt);
  if (receiptKey(parsed.material) !== parsed.key) throw new Error("Receipt key does not match its material.");
  atomicWriteJson(coordRoot, receiptPath(coordRoot, parsed.key), parsed);
};

const lockOwnerSchema = z.object({
  pid: z.number().int().positive(),
  hostname: z.string(),
  token: z.string().min(1),
  startedAt: z.string()
}).strict();

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

/** A lock is reclaimable only when its owner is proven gone: same host and a
 * dead pid, or an unparseable record. Age alone never reclaims a live owner,
 * and a foreign host's owner cannot be proven dead from here. */
const lockIsStale = (path: string): boolean => {
  let owner: z.infer<typeof lockOwnerSchema>;
  try { owner = lockOwnerSchema.parse(JSON.parse(readFileSync(path, "utf8"))); }
  catch { return true; }
  return owner.hostname === hostname() && !processAlive(owner.pid);
};

/** Returns an ownership token, or null while another live owner holds the lock. */
export const tryAcquireLock = (coordRoot: string, path: string): string | null => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertNoSymlink(coordRoot, dirname(path));
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = randomUUID();
    // Publish a complete record with link(2): a reader never sees a partial
    // lock it could mistake for an unparseable, reclaimable one.
    const temporary = containedPath(dirname(path), `.${token}.tmp`);
    const handle = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(handle, JSON.stringify({ pid: process.pid, hostname: hostname(), token, startedAt: new Date().toISOString() }));
    } finally { closeSync(handle); }
    try {
      linkSync(temporary, path);
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!lockIsStale(path)) return null;
      try { unlinkSync(path); } catch { /* Another reclaimer won; retry once. */ }
    } finally { unlinkSync(temporary); }
  }
  return null;
};

/** Release only a lock this owner still holds. */
export const releaseLock = (path: string, token: string): void => {
  try {
    const owner = lockOwnerSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (owner.token === token) unlinkSync(path);
  } catch { /* Already gone or replaced: nothing of ours to release. */ }
};

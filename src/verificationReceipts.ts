import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { z } from "zod";
import { isCoordinationEvidencePath } from "./changeClassification.js";
import { git } from "./gitExec.js";
import { sha256 } from "./hash.js";
import { hermeticGitEnv } from "./mirror.js";
import { assertNoSymlink, containedPath, isPathInside } from "./paths.js";
import { acquireExclusiveLock, atomicWriteJson } from "./state.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const receiptMaterialSchema = z.object({
  v: z.literal(1), origin: z.string(), inputsMode: z.enum(["commit", "tree", "tree-excluding-evidence"]),
  inputIdentity: z.string(), argv: z.array(z.string()), policyDigest: digest,
  platform: z.string(), arch: z.string(), node: z.string(),
  probes: z.array(z.object({ argv: z.array(z.string()), digest }).strict()),
  env: z.array(z.object({ name: z.string(), digest: digest.nullable() }).strict()),
  dependencyIdentity: digest, preparationIdentity: digest
}).strict();
export type ReceiptMaterial = z.infer<typeof receiptMaterialSchema>;
const receiptSchema = z.object({
  key: digest, material: receiptMaterialSchema, exitCode: z.literal(0),
  logPath: z.string(), durationMs: z.number().nonnegative(), completedAt: z.iso.datetime({ offset: true })
}).strict();
export type VerificationReceipt = z.infer<typeof receiptSchema>;

export const receiptKey = (material: ReceiptMaterial): string => sha256(JSON.stringify(receiptMaterialSchema.parse(material)));

export const computeInputIdentity = (root: string, pin: string, mode: ReceiptMaterial["inputsMode"]): string => {
  if (!/^[0-9a-f]{40}$/.test(pin)) throw new Error("Verification requires an immutable commit SHA");
  const tree = git(root, "rev-parse", `${pin}^{tree}`);
  if (tree.exitCode !== 0) throw new Error("Cannot resolve verification tree");
  if (mode !== "tree-excluding-evidence") return `${mode}:${mode === "commit" ? `${pin}:` : ""}${tree.stdout.trim()}`;
  const result = spawnSync("git", ["ls-tree", "-r", "-z", "--full-tree", pin], { cwd: root, env: hermeticGitEnv() });
  if (result.status !== 0) throw new Error("Cannot read verification tree");
  const hash = createHash("sha256");
  let from = 0;
  for (let to = 0; to < result.stdout.length; to++) {
    if (result.stdout[to] !== 0) continue;
    const row = result.stdout.subarray(from, to), path = row.subarray(row.indexOf(9) + 1);
    const name = path.toString("utf8");
    if (!Buffer.from(name).equals(path) || !isCoordinationEvidencePath(name)) hash.update(row).update("\0");
    from = to + 1;
  }
  return `projected-tree:${hash.digest("hex")}`;
};

export const trackedInputsClean = (worktree: string, pin: string): boolean => {
  const head = git(worktree, "rev-parse", "HEAD");
  const changes = git(worktree, "status", "--porcelain", "--untracked-files=no");
  return head.exitCode === 0 && head.stdout.trim() === pin && changes.exitCode === 0 && changes.stdout === "";
};

/** Hash explicitly declared untracked dependencies/generated inputs. Escaping
 * symlinks, cycles, unreadable files and special files disable reuse. */
export const dependencyIdentity = (worktree: string, paths: readonly string[]): string => {
  const root = realpathSync(worktree), hash = createHash("sha256");
  const field = (value: string | Buffer) => hash.update(`${Buffer.byteLength(value)}:`).update(value);
  const walk = (path: string, ancestors: Set<string>): void => {
    const real = realpathSync(path);
    if (!isPathInside(root, real) || relative(root, real).split(/[\\/]/).includes(".git")) throw new Error("dependency outside check inputs");
    if (ancestors.has(real)) throw new Error("cyclic dependency input");
    const stat = lstatSync(path);
    field(String(stat.mode));
    if (stat.isSymbolicLink()) { field(readlinkSync(path)); walk(real, ancestors); }
    else if (stat.isFile()) field(readFileSync(path));
    else if (stat.isDirectory()) {
      const next = new Set(ancestors).add(real);
      for (const name of readdirSync(path).sort()) { field(name); walk(resolve(path, name), next); }
    } else throw new Error("unsupported dependency input");
  };
  for (const name of [...paths].sort()) {
    field(name);
    const path = containedPath(root, name);
    if (!existsSync(path)) field("missing"); else walk(path, new Set());
  }
  return hash.digest("hex");
};

const ownerPath = (root: string, ...parts: string[]): string => {
  const path = containedPath(root, "verification", ...parts);
  assertNoSymlink(root, path);
  return path;
};

export const readReceipt = (root: string, key: string): VerificationReceipt | null => {
  try {
    digest.parse(key);
    const receipt = receiptSchema.parse(JSON.parse(readFileSync(ownerPath(root, "receipts", `${key}.json`), "utf8")));
    if (receipt.key !== key || receiptKey(receipt.material) !== key || !isPathInside(root, receipt.logPath)) return null;
    assertNoSymlink(root, receipt.logPath);
    if (!lstatSync(receipt.logPath).isFile()) return null;
    return receipt;
  } catch { return null; }
};

export const writeReceipt = (root: string, receipt: VerificationReceipt): void => {
  const parsed = receiptSchema.parse(receipt);
  if (receiptKey(parsed.material) !== parsed.key) throw new Error("Invalid verification receipt identity");
  atomicWriteJson(root, ownerPath(root, "receipts", `${parsed.key}.json`), parsed);
};

/** A short state-style guard serializes claim and compare-owner release. Age
 * never reclaims a live owner. A dead coordinator may have left a live child:
 * require explicit owner recovery rather than racing that orphaned suite. */
export const tryVerificationLock = (root: string, name: string, limit?: number): (() => void) | null => {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid verification lock name");
  const path = ownerPath(root, "running", `${name}.lock`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const guardPath = `${path}.guard`;
  const guarded = <T>(fn: () => T): T => {
    assertNoSymlink(root, guardPath);
    const fd = acquireExclusiveLock(guardPath);
    try { return fn(); } finally { closeSync(fd); unlinkSync(guardPath); }
  };
  const token = randomUUID();
  const claimed = guarded(() => {
    if (existsSync(path)) {
      const owner = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; hostname?: string };
      if (owner.hostname === hostname() && Number.isInteger(owner.pid) && owner.pid! > 0) {
        try { process.kill(owner.pid!, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") throw new Error(`Interrupted verification lock ${path}: confirm orphaned checks stopped before owner recovery`);
        }
      }
      return false;
    }
    const fd = openSync(path, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ token, pid: process.pid, hostname: hostname(), limit })); }
    finally { closeSync(fd); }
    return true;
  });
  if (!claimed) return null;
  return () => guarded(() => {
    assertNoSymlink(root, path);
    if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).token === token) unlinkSync(path);
  });
};

/** Serialize admissions only, not execution. The strictest live declaration
 * wins if overlapping issue snapshots configured different workspace limits. */
export const tryExpensiveSlot = (root: string, limit: number): (() => void) | null => {
  const registry = tryVerificationLock(root, "slot-registry");
  if (registry === null) return null;
  try {
    const directory = ownerPath(root, "running");
    const names = readdirSync(directory).filter((name) => /^slot-[a-f0-9-]+\.lock$/.test(name));
    let bound = limit;
    for (const name of names) {
      const path = ownerPath(root, "running", name);
      // A releasing worker can disappear between listing and reading. Waiting
      // one more poll is safer than admitting against an incomplete snapshot.
      if (!existsSync(path)) return null;
      const owner = JSON.parse(readFileSync(path, "utf8")) as { limit?: number };
      if (!Number.isInteger(owner.limit) || owner.limit! < 1) throw new Error(`Invalid expensive slot ${path}`);
      // Reuse the ordinary lock's dead-owner diagnosis; it never reclaims a
      // potentially orphaned child and must not acquire an existing slot.
      const unexpected = tryVerificationLock(root, name.slice(0, -5));
      if (unexpected !== null) { unexpected(); return null; }
      bound = Math.min(bound, owner.limit!);
    }
    return names.length < bound ? tryVerificationLock(root, `slot-${randomUUID()}`, limit) : null;
  } finally { registry(); }
};

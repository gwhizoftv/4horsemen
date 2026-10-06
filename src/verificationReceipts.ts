import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { z } from "zod";
import { isCoordinationEvidencePath } from "./changeClassification.js";
import { git } from "./gitExec.js";
import { sha256 } from "./hash.js";
import { containedPath } from "./paths.js";
import { atomicWriteJson, type CheckCache } from "./state.js";

/**
 * Receipt keying and storage for coordinator-owned verification.
 *
 * This is a separate concern from the run loop on purpose: a receipt is only
 * ever written for an exit-0 run in a coordinator-materialized worktree, and it
 * is only ever read from under the coordinator root. Hooks never read or write
 * receipts, and no clone state or agent signal is ever treated as a result.
 */

export type CacheInputsMode = CheckCache["inputs"];

/**
 * The identity of what a command actually read.
 *
 * `tree` is the exact tree id of the pin. `tree-excluding-evidence` digests the
 * raw `ls-tree` records with coordination evidence removed, so an evidence-only
 * commit on top of identical product bytes keeps the same identity. Anything
 * that cannot be computed exactly returns null, which makes the command run.
 */
export const computeInputIdentity = (mirrorPath: string, pin: string, mode: CacheInputsMode): string | null => {
  try {
    if (mode === "tree") {
      const tree = git(mirrorPath, "--git-dir", mirrorPath, "rev-parse", `${pin}^{tree}`);
      const id = tree.stdout.trim();
      return tree.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(id) ? `tree:${id}` : null;
    }
    const listed = git(mirrorPath, "--git-dir", mirrorPath, "ls-tree", "-r", "-z", "--full-tree", pin);
    if (listed.exitCode !== 0) return null;
    // A record Git emitted that did not survive the utf8 decode would make two
    // different trees digest alike, so refuse to cache instead of guessing.
    if (listed.stdout.includes("\uFFFD")) return null;
    const kept = listed.stdout
      .split("\0")
      .filter((record) => record !== "")
      .filter((record) => {
        const tab = record.indexOf("\t");
        return tab < 0 || !isCoordinationEvidencePath(record.slice(tab + 1));
      });
    return `tree-excluding-evidence:${sha256(kept.join("\0"))}`;
  } catch {
    return null;
  }
};

const probeSchema = z.object({ argv: z.array(z.string().min(1)).min(1), stdout: z.string() }).strict();
const envSchema = z.object({ name: z.string().min(1), value: z.string().nullable() }).strict();

export const receiptKeyMaterialSchema = z
  .object({
    v: z.literal(1),
    origin: z.string().min(1),
    inputsMode: z.enum(["tree", "tree-excluding-evidence"]),
    inputIdentity: z.string().min(1),
    /** The *declared* argv: the executed one embeds a random worktree path. */
    argv: z.array(z.string()).min(1),
    policyDigest: z.string().min(1),
    platform: z.string().min(1),
    arch: z.string().min(1),
    node: z.string().min(1),
    probes: z.array(probeSchema),
    env: z.array(envSchema)
  })
  .strict();

export type ReceiptKeyMaterial = z.infer<typeof receiptKeyMaterialSchema>;

/** Fixed key order, so a receipt's file name can be recomputed from its bytes. */
const canonicalMaterial = (material: ReceiptKeyMaterial): string =>
  JSON.stringify({
    v: material.v,
    origin: material.origin,
    inputsMode: material.inputsMode,
    inputIdentity: material.inputIdentity,
    argv: [...material.argv],
    policyDigest: material.policyDigest,
    platform: material.platform,
    arch: material.arch,
    node: material.node,
    probes: material.probes.map((probe) => ({ argv: [...probe.argv], stdout: probe.stdout })),
    env: material.env.map((entry) => ({ name: entry.name, value: entry.value }))
  });

export const receiptKey = (material: ReceiptKeyMaterial): string => sha256(canonicalMaterial(material));

export const receiptSchema = z
  .object({
    v: z.literal(1),
    key: z.string().regex(/^[0-9a-f]{64}$/),
    receiptId: z.string().min(1),
    name: z.string().min(1),
    exitCode: z.number().int(),
    durationMs: z.number().int().nonnegative(),
    completedAt: z.string().min(1),
    material: receiptKeyMaterialSchema
  })
  .strict();

export type VerificationReceipt = z.infer<typeof receiptSchema>;

export const receiptPath = (coordRoot: string, key: string): string => {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`Invalid receipt key ${key}.`);
  return containedPath(coordRoot, "verification", "receipts", `${key}.json`);
};

export type ReceiptRead = { ok: true; receipt: VerificationReceipt } | { ok: false; reason: string };

/**
 * Read one receipt, recomputing its key from the stored material.
 *
 * Every failure is a miss with a reason and never a pass: a corrupt file, a
 * schema violation, a file name that does not match its own key material, or a
 * non-zero exit all mean the command has to run.
 */
export const readReceipt = (coordRoot: string, key: string): ReceiptRead => {
  let path: string;
  try {
    path = receiptPath(coordRoot, key);
  } catch (error) {
    return { ok: false, reason: `unusable receipt key: ${String(error)}` };
  }
  if (!existsSync(path)) return { ok: false, reason: "no receipt" };
  let parsed: VerificationReceipt;
  try {
    parsed = receiptSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ok: false, reason: "unreadable or malformed receipt" };
  }
  if (parsed.key !== key) return { ok: false, reason: "receipt key does not match its file name" };
  if (receiptKey(parsed.material) !== key) return { ok: false, reason: "receipt key material does not hash to its key" };
  if (parsed.exitCode !== 0) return { ok: false, reason: "receipt records a failure" };
  return { ok: true, receipt: parsed };
};

export const writeReceipt = (coordRoot: string, receipt: VerificationReceipt): void => {
  atomicWriteJson(coordRoot, receiptPath(coordRoot, receipt.key), receiptSchema.parse(receipt));
};

const lockOwnerSchema = z
  .object({ pid: z.number().int().positive(), hostname: z.string().min(1), startedAt: z.string().min(1) })
  .strict();

export type Lock = { path: string; handle: number };

const LOCK_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * A lock is stale only when this host can prove it: the owner names this
 * hostname and its pid is gone, or it is older than six hours. A lock held by
 * another host is left alone, and an unreadable owner record is never raced.
 */
const isStale = (path: string): boolean => {
  let owner: z.infer<typeof lockOwnerSchema>;
  try {
    owner = lockOwnerSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return false;
  }
  const age = Date.now() - Date.parse(owner.startedAt);
  if (Number.isFinite(age) && age > LOCK_MAX_AGE_MS) return true;
  if (owner.hostname !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
};

/** Null means a live owner holds it; the caller waits rather than running. */
export const acquireLock = (path: string): Lock | null => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const handle = openSync(path, "wx", 0o600);
      try {
        writeFileSync(handle, `${JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() })}\n`, "utf8");
        fsyncSync(handle);
      } catch (error) {
        closeSync(handle);
        throw error;
      }
      return { path, handle };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (!isStale(path)) return null;
      try {
        unlinkSync(path);
      } catch {
        return null;
      }
    }
  }
  return null;
};

export const releaseLock = (lock: Lock): void => {
  try {
    closeSync(lock.handle);
  } catch {
    // Already closed by an earlier release in the same finally chain.
  }
  try {
    if (existsSync(lock.path)) unlinkSync(lock.path);
  } catch {
    // A stale-sweep by another process may have removed it first.
  }
};

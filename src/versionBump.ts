import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** Parse a dotted triple (`1.2.3`). Returns null when the string is not that shape. */
export const parseDotVersion = (raw: string): [number, number, number] | null => {
  const matched = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (matched === null) return null;
  return [Number(matched[1]), Number(matched[2]), Number(matched[3])];
};

/** True when `a` is strictly greater than `b` in major/minor/patch order. */
export const isStrictlyGreater = (a: readonly [number, number, number], b: readonly [number, number, number]): boolean => {
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] as number;
    const right = b[i] as number;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
};

export type VersionBumpCheck = {
  enforce: boolean;
  headRef: string;
  baseRef: string;
  headVersion: string;
  baseVersion: string;
  ok: boolean;
  detail: string;
};

const git = (args: readonly string[], cwd: string): { ok: boolean; stdout: string; stderr: string } => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim()
  };
};

const readPackageVersion = (cwd: string): string => {
  const parsed = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version === "") {
    throw new Error("package.json is missing a version string");
  }
  return parsed.version;
};

const readBasePackageVersion = (cwd: string, baseRef: string): string => {
  const show = git(["show", `${baseRef}:package.json`], cwd);
  if (!show.ok) {
    throw new Error(`cannot read ${baseRef}:package.json (${show.stderr || "git show failed"})`);
  }
  const parsed = JSON.parse(show.stdout) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version === "") {
    throw new Error(`${baseRef}:package.json is missing a version string`);
  }
  return parsed.version;
};

/**
 * Pre-1.0 ship gate: on a non-base branch, package.json version must be strictly
 * greater than the version on `baseRef` (default `origin/main`) before merging
 * to main.
 */
export const checkVersionBump = (
  cwd: string,
  options: { baseRef?: string; headRef?: string } = {}
): VersionBumpCheck => {
  const baseRef = options.baseRef ?? "origin/main";
  const head =
    options.headRef ??
    (() => {
      const symbolic = git(["symbolic-ref", "--short", "-q", "HEAD"], cwd);
      if (symbolic.ok && symbolic.stdout !== "") return symbolic.stdout;
      const short = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
      return short.ok ? short.stdout : "HEAD";
    })();

  const headVersion = readPackageVersion(cwd);
  const baseVersion = readBasePackageVersion(cwd, baseRef);
  const baseBranch = baseRef.includes("/") ? (baseRef.split("/").at(-1) ?? baseRef) : baseRef;
  const onBase = head === baseBranch || head === baseRef || head === "main";

  if (onBase) {
    return {
      enforce: false,
      headRef: head,
      baseRef,
      headVersion,
      baseVersion,
      ok: true,
      detail: `on ${head}; version bump not required`
    };
  }

  const headParts = parseDotVersion(headVersion);
  const baseParts = parseDotVersion(baseVersion);
  if (headParts === null || baseParts === null) {
    return {
      enforce: true,
      headRef: head,
      baseRef,
      headVersion,
      baseVersion,
      ok: false,
      detail: `versions must be dotted triples (head=${headVersion}, base=${baseVersion})`
    };
  }

  const ok = isStrictlyGreater(headParts, baseParts);
  return {
    enforce: true,
    headRef: head,
    baseRef,
    headVersion,
    baseVersion,
    ok,
    detail: ok
      ? `${headVersion} > ${baseVersion} (${baseRef})`
      : `package.json version ${headVersion} must be strictly greater than ${baseRef} (${baseVersion}); bump 0.0.N before merging to main`
  };
};

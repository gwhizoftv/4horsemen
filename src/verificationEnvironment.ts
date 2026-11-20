import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export class ProductToolchainError extends Error {
  override readonly name = "ProductToolchainError";
}

export type ResolvedProductEnvironment = {
  env: NodeJS.ProcessEnv;
  nodePath: string | null;
  nodeVersion: string | null;
  source: "nvmrc" | "node-version" | "engines" | "inherited";
  runtimeIdentity: string;
};

type Semver = { major: number; minor: number; patch: number; raw: string };

const isExecutableFile = (path: string): boolean => {
  try {
    const stats = statSync(path);
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

const isRegularFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

export const executableResolves = (
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env
): boolean => {
  if (command.includes("/")) return isExecutableFile(resolve(cwd, command));
  const entries = (env.PATH ?? "").split(delimiter).filter((entry) => entry !== "");
  return entries.some((entry) => isExecutableFile(join(entry, command)));
};

export const prependPath = (currentPath: string | undefined, directory: string): string => {
  const entries = (currentPath ?? "").split(delimiter).filter((entry) => entry !== "");
  const rest = entries.filter((entry) => entry !== directory);
  return [directory, ...rest].join(delimiter);
};

const parseSemver = (text: string): Semver | null => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  return { major, minor, patch, raw: `v${major}.${minor}.${patch}` };
};

const compareSemver = (left: Semver, right: Semver): number =>
  left.major - right.major || left.minor - right.minor || left.patch - right.patch;

const parseNumericPin = (pin: string): { major: number; minor?: number; patch?: number } | null => {
  const trimmed = pin.trim().replace(/^v/i, "");
  const match = /^(\d+)(?:\.(\d+)(?:\.(\d+))?)?$/.exec(trimmed);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    ...(match[2] === undefined ? {} : { minor: Number(match[2]) }),
    ...(match[3] === undefined ? {} : { patch: Number(match[3]) })
  };
};

const matchesPin = (version: Semver, pin: string): boolean => {
  const trimmed = pin.trim();
  if (trimmed === "node") return true;
  const parsed = parseNumericPin(trimmed);
  if (parsed === null) return false;
  if (version.major !== parsed.major) return false;
  if (parsed.minor !== undefined && version.minor !== parsed.minor) return false;
  if (parsed.patch !== undefined && version.patch !== parsed.patch) return false;
  return true;
};

const satisfiesComparator = (version: Semver, token: string): boolean | null => {
  if (token === "*" || token === "x" || token === "X") return true;
  const match = /^(>=|<=|>|<|=|\^|~)?v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?)?$/.exec(token);
  if (match === null) return null;
  const op = match[1] ?? "=";
  const isWild = (part: string | undefined): boolean => part === undefined || part === "*" || part === "x" || part === "X";
  if (isWild(match[2])) return true;
  const major = Number(match[2]);
  const minor = isWild(match[3]) ? null : Number(match[3]);
  const patch = isWild(match[4]) ? null : Number(match[4]);
  const target: Semver = { major, minor: minor ?? 0, patch: patch ?? 0, raw: "" };
  const cmp = compareSemver(version, target);
  if (op === ">=") return cmp >= 0;
  if (op === ">") {
    if (minor === null) return version.major > major;
    if (patch === null) return version.major > major || (version.major === major && version.minor > minor);
    return cmp > 0;
  }
  if (op === "<=") {
    if (minor === null) return version.major <= major;
    if (patch === null) return version.major < major || (version.major === major && version.minor <= minor);
    return cmp <= 0;
  }
  if (op === "<") return cmp < 0;
  if (op === "^") {
    if (cmp < 0) return false;
    if (major > 0) return version.major === major;
    if (minor !== null && minor > 0) return version.major === 0 && version.minor === minor;
    return version.major === 0 && version.minor === 0 && (patch === null || version.patch === patch);
  }
  if (op === "~") {
    if (cmp < 0) return false;
    if (minor === null) return version.major === major;
    return version.major === major && version.minor === minor;
  }
  if (version.major !== major) return false;
  if (minor !== null && version.minor !== minor) return false;
  if (patch !== null && version.patch !== patch) return false;
  return true;
};

const satisfiesEnginesRange = (version: Semver, range: string): boolean => {
  const branches = range.split("||").map((part) => part.trim()).filter((part) => part !== "");
  if (branches.length === 0) return true;
  let recognized = false;
  for (const branch of branches) {
    const tokens = branch.split(/\s+/).filter((part) => part !== "");
    let branchOk = true;
    for (const token of tokens) {
      const check = satisfiesComparator(version, token);
      if (check === null) {
        branchOk = false;
        break;
      }
      recognized = true;
      if (!check) {
        branchOk = false;
        break;
      }
    }
    if (branchOk && tokens.length > 0) return true;
  }
  return !recognized;
};

const canonicalPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const probeNodeVersion = (nodePath: string): Semver | null => {
  if (!isExecutableFile(nodePath)) return null;
  if (canonicalPath(nodePath) === canonicalPath(process.execPath)) {
    return parseSemver(process.version);
  }
  const result = spawnSync(nodePath, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000
  });
  if (result.status !== 0) return null;
  return parseSemver(result.stdout.trim());
};

const nvmRootFor = (env: NodeJS.ProcessEnv): string => {
  if (typeof env.NVM_DIR === "string" && env.NVM_DIR.trim() !== "") return env.NVM_DIR;
  const home = typeof env.HOME === "string" && env.HOME.trim() !== "" ? env.HOME : homedir();
  return join(home, ".nvm");
};

const firstPathNode = (env: NodeJS.ProcessEnv): { path: string; version: Semver } | null => {
  for (const entry of (env.PATH ?? "").split(delimiter).filter((item) => item !== "")) {
    const candidate = join(entry, "node");
    const version = probeNodeVersion(candidate);
    if (version !== null) return { path: canonicalPath(candidate), version };
  }
  return null;
};

const collectInstalledNodes = (env: NodeJS.ProcessEnv): Array<{ path: string; version: Semver }> => {
  const candidates: string[] = [];
  const nvmVersions = join(nvmRootFor(env), "versions", "node");
  if (existsSync(nvmVersions)) {
    try {
      for (const entry of readdirSync(nvmVersions, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith("v")) {
          candidates.push(join(nvmVersions, entry.name, "bin", "node"));
        }
      }
    } catch { /* Ignore unreadable nvm directory. */ }
  }
  for (const entry of (env.PATH ?? "").split(delimiter).filter((item) => item !== "")) {
    candidates.push(join(entry, "node"));
  }
  if (typeof env.COORD_NODE === "string" && isAbsolute(env.COORD_NODE)) {
    candidates.push(env.COORD_NODE);
  }
  if (basename(process.execPath) === "node") {
    candidates.push(process.execPath);
  }
  const seen = new Set<string>();
  const found: Array<{ path: string; version: Semver }> = [];
  for (const candidate of candidates) {
    if (!isExecutableFile(candidate)) continue;
    const real = canonicalPath(candidate);
    if (seen.has(real)) continue;
    seen.add(real);
    const version = probeNodeVersion(real);
    if (version !== null) found.push({ path: real, version });
  }
  return found.sort((left, right) => compareSemver(right.version, left.version));
};

const resolveViaNvm = (
  cwd: string,
  env: NodeJS.ProcessEnv,
  pin: string
): { path: string; version: Semver } | null => {
  const nvmDir = nvmRootFor(env);
  const nvmScript = join(nvmDir, "nvm.sh");
  if (!isRegularFile(nvmScript)) return null;
  const result = spawnSync(
    "bash",
    [
      "-c",
      'set -euo pipefail\nNVM_DIR="$1"\nexport NVM_DIR\n' +
        '. "$NVM_DIR/nvm.sh" --no-use >/dev/null 2>&1 || . "$NVM_DIR/nvm.sh" >/dev/null 2>&1\n' +
        'resolved="$(nvm which "$2" 2>/dev/null || nvm which 2>/dev/null)" || exit 1\n' +
        'printf "\\0COORD_NVM_NODE=%s\\0" "$resolved"',
      "coord-nvm-which",
      nvmDir,
      pin
    ],
    { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }
  );
  if (result.status !== 0) return null;
  const match = /\0COORD_NVM_NODE=([^\0]+)\0/.exec(result.stdout);
  const rawPath = match?.[1]?.trim().split(/\r?\n/).at(-1)?.trim();
  if (!rawPath || !isAbsolute(rawPath) || basename(rawPath) !== "node") return null;
  const version = probeNodeVersion(rawPath);
  if (version === null) return null;
  if (parseNumericPin(pin) !== null && !matchesPin(version, pin)) return null;
  return { path: canonicalPath(rawPath), version };
};

const readPinFile = (cwd: string): { pin: string; source: "nvmrc" | "node-version"; file: string } | null => {
  for (const [file, source] of [[".nvmrc", "nvmrc"], [".node-version", "node-version"]] as const) {
    const path = join(cwd, file);
    if (!isRegularFile(path)) continue;
    const line = readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry !== "" && !entry.startsWith("#"));
    if (line !== undefined) return { pin: line, source, file };
  }
  return null;
};

const readEnginesNode = (cwd: string): string | null => {
  const path = join(cwd, "package.json");
  if (!isRegularFile(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { engines?: { node?: unknown } };
    return typeof parsed.engines?.node === "string" && parsed.engines.node.trim() !== ""
      ? parsed.engines.node.trim()
      : null;
  } catch {
    return null;
  }
};

const applySelectedNode = (
  baseEnv: NodeJS.ProcessEnv,
  selected: { path: string; version: Semver },
  source: "nvmrc" | "node-version" | "engines"
): ResolvedProductEnvironment => {
  const binDir = dirname(selected.path);
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    PATH: prependPath(baseEnv.PATH, binDir)
  };
  if (env.NVM_BIN !== undefined) env.NVM_BIN = binDir;
  return {
    env,
    nodePath: selected.path,
    nodeVersion: selected.version.raw,
    source,
    runtimeIdentity: `${source}:${selected.version.raw}:${selected.path}`
  };
};

/**
 * Resolve the product checkout's declared Node toolchain and propagate it at
 * the front of PATH for child processes (including nested pnpm scripts).
 * Projects without a pin or whose inherited PATH already satisfies engines.node
 * retain their inherited PATH unchanged.
 */
export const resolveProjectEnvironment = (
  cwd: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): ResolvedProductEnvironment => {
  const pin = readPinFile(cwd);
  if (pin !== null) {
    const viaNvm = pin.source === "nvmrc" ? resolveViaNvm(cwd, baseEnv, pin.pin) : null;
    if (viaNvm !== null) return applySelectedNode(baseEnv, viaNvm, pin.source);
    const matched = collectInstalledNodes(baseEnv).find((candidate) => matchesPin(candidate.version, pin.pin));
    if (matched !== undefined) return applySelectedNode(baseEnv, matched, pin.source);
    throw new ProductToolchainError(
      `Project pins Node '${pin.pin}' in ${pin.file}, but no matching installed Node was found ` +
        `(checked nvm and PATH). Install Node ${pin.pin} and retry.`
    );
  }

  const current = firstPathNode(baseEnv);
  const enginesNode = readEnginesNode(cwd);
  if (enginesNode !== null && (current === null || !satisfiesEnginesRange(current.version, enginesNode))) {
    const matched = collectInstalledNodes(baseEnv).find((candidate) =>
      satisfiesEnginesRange(candidate.version, enginesNode)
    );
    if (matched !== undefined) return applySelectedNode(baseEnv, matched, "engines");
  }

  return {
    env: { ...baseEnv },
    nodePath: current?.path ?? null,
    nodeVersion: current?.version.raw ?? null,
    source: "inherited",
    runtimeIdentity: current === null ? "inherited" : `inherited:${current.version.raw}:${current.path}`
  };
};

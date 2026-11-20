import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/**
 * The environment a product check runs in. Coordination selects its own Node
 * (scripts/lib/node-runtime.sh) without touching PATH, so a product check used
 * to inherit whichever Node came first on the owner's PATH, and every `node`
 * pnpm launched was that one. A product that pins Node in `.nvmrc` now gets
 * that Node first on PATH for the check and all of its children, exactly the
 * pin the agent launcher selects with `nvm use`. A product without a pin keeps
 * its inherited environment unchanged.
 */
export type ProductEnvironment = {
  env: NodeJS.ProcessEnv;
  /** Selected Node binary, or null when the inherited PATH is kept. */
  nodePath: string | null;
  /** Selected Node version (`vX.Y.Z`), or null when the inherited PATH is kept. */
  node: string | null;
  /** The `.nvmrc` value that selected it, or null when there is no pin. */
  pin: string | null;
};

export class ProductToolchainError extends Error {
  override readonly name = "ProductToolchainError";
}

type Version = [number, number, number];

const parseVersion = (text: string): Version | null => {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
};

const compare = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const isExecutable = (path: string): boolean => {
  try {
    const stats = statSync(path);
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

/** First meaningful `.nvmrc` line, without nvm's trailing comments. */
const readPin = (root: string): string | null => {
  const path = join(root, ".nvmrc");
  try {
    if (!lstatSync(path).isFile()) return null;
  } catch {
    return null;
  }
  const line = readFileSync(path, "utf8").split(/\r?\n/).map((entry) => entry.replace(/#.*$/, "").trim())
    .find((entry) => entry !== "");
  if (line === undefined) throw new ProductToolchainError(`${path} is empty, so the product's Node cannot be selected.`);
  return line;
};

const nvmDir = (env: NodeJS.ProcessEnv): string | null => {
  const dir = env.NVM_DIR ?? (env.HOME === undefined ? undefined : join(env.HOME, ".nvm"));
  return dir === undefined || dir === "" ? null : dir;
};

/** Installed Nodes a numeric pin can match: the running binary and nvm's versions. */
const installedNodes = (env: NodeJS.ProcessEnv): Array<{ path: string; version: Version }> => {
  const found: Array<{ path: string; version: Version }> = [];
  const running = parseVersion(process.version);
  if (running !== null) found.push({ path: process.execPath, version: running });
  const dir = nvmDir(env);
  if (dir === null) return found;
  let entries: string[] = [];
  try { entries = readdirSync(join(dir, "versions", "node")); } catch { return found; }
  for (const entry of entries) {
    const version = parseVersion(entry);
    const path = join(dir, "versions", "node", entry, "bin", "node");
    if (version !== null && isExecutable(path)) found.push({ path, version });
  }
  return found;
};

/** nvm interprets aliases (`lts/*`, `node`); the pin is passed as data. */
const nvmWhich = (root: string, pin: string, env: NodeJS.ProcessEnv): string | null => {
  const dir = nvmDir(env);
  if (dir === null) return null;
  const result = spawnSync("bash", ["-c", '. "$NVM_DIR/nvm.sh" --no-use >/dev/null 2>&1 || exit 3\nnvm which "$1"', "coord-node-pin", pin],
    { cwd: root, env: { ...env, NVM_DIR: dir }, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) return null;
  const last = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "").at(-1) ?? "";
  return isAbsolute(last) && last.endsWith("/node") && isExecutable(last) ? last : null;
};

const probeVersion = (path: string, env: NodeJS.ProcessEnv): string | null => {
  if (path === process.execPath) return process.version;
  const result = spawnSync(path, ["--version"], { env, encoding: "utf8", timeout: 10_000 });
  return result.status === 0 && parseVersion(result.stdout) !== null ? result.stdout.trim() : null;
};

/**
 * Select the product's Node for one checkout. Installed versions only: this
 * never installs or downloads anything, and an unavailable pin is reported
 * with its remedy rather than silently replaced by another Node.
 */
export const resolveProductEnvironment = (root: string, env: NodeJS.ProcessEnv = process.env): ProductEnvironment => {
  const pin = readPin(root);
  if (pin === null) return { env: { ...env }, nodePath: null, node: null, pin: null };
  let nodePath: string | null = null;
  const numeric = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(pin);
  if (numeric !== null) {
    const wanted = numeric.slice(1).map((part) => part === undefined ? null : Number(part));
    const matches = installedNodes(env)
      .filter(({ version }) => wanted.every((part, index) => part === null || version[index] === part))
      .sort((a, b) => compare(b.version, a.version));
    nodePath = matches[0]?.path ?? null;
  }
  nodePath ??= nvmWhich(root, pin, env);
  const version = nodePath === null ? null : probeVersion(nodePath, env);
  if (nodePath === null || version === null) {
    throw new ProductToolchainError(
      `The product pins Node '${pin}' in .nvmrc, but no installed Node matches it${nodePath === null ? "" : ` (${nodePath} did not report a version)`}. ` +
        `Install it (for example: nvm install ${pin}), then retry; checks never fall back to another Node.`
    );
  }
  return { env: { ...env, PATH: `${dirname(nodePath)}${delimiter}${env.PATH ?? ""}` }, nodePath, node: version, pin };
};

/** Resolve a bare executable name against an environment's PATH, as spawn would. */
export const resolvesOnPath = (command: string, env: NodeJS.ProcessEnv): boolean =>
  (env.PATH ?? "").split(delimiter).filter((entry) => entry !== "").some((entry) => isExecutable(join(entry, command)));

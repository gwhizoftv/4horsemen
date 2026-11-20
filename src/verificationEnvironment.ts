import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

export class NodePinError extends Error {
  constructor(readonly requirement: string, message: string) { super(message); }
}

/** Resolve a product pin in its own checkout. Do not mutate the coordinator's PATH. */
export const verificationEnvironment = (cwd: string, inherited: NodeJS.ProcessEnv = process.env) => {
  const env = { ...inherited };
  const pinFile = join(cwd, ".nvmrc");
  const selected = (binary: string, node: string) => ({
    env: { ...env, PATH: [dirname(binary), env.PATH].filter(Boolean).join(delimiter) }, node
  });
  if (!existsSync(pinFile)) {
    if (!existsSync(join(cwd, "package.json"))) return { env, node: process.version };
    const probe = spawnSync("node", ["--version"], { cwd, env, encoding: "utf8", timeout: 5_000 });
    if (probe.error && (probe.error as NodeJS.ErrnoException).code === "ENOENT") return selected(process.execPath, process.version);
    return { env, node: probe.status === 0 ? probe.stdout.trim() : "unavailable" };
  }
  if (!lstatSync(pinFile).isFile()) throw new NodePinError("node (regular .nvmrc required)", `Expected a regular file at ${pinFile}`);
  const pin = readFileSync(pinFile, "utf8").replace(/#.*$/gm, "").trim();
  const nvmDir = env.NVM_DIR ?? join(env.HOME ?? "", ".nvm");
  const numeric = /^v?\d+(?:\.\d+){0,2}$/.test(pin) ? `v${pin.replace(/^v/, "")}` : null;
  const matches = (node: string) => /^v\d+\.\d+\.\d+$/.test(node) &&
    (numeric === null || node === numeric || node.startsWith(`${numeric}.`));
  const version = (binary: string) => {
    const probe = spawnSync(binary, ["--version"], { cwd, env, encoding: "utf8", timeout: 5_000 });
    return probe.status === 0 ? probe.stdout.trim() : "";
  };
  if (numeric !== null) {
    if (matches(process.version)) return selected(process.execPath, process.version);
    const versions = join(nvmDir, "versions/node");
    const dirs = (env.PATH ?? "").split(delimiter).filter(isAbsolute);
    if (isAbsolute(versions) && existsSync(versions)) {
      const installed = readdirSync(versions).filter(matches).sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
      dirs.push(...installed.map(v => join(versions, v, "bin")));
    }
    for (const dir of new Set(dirs)) {
      const binary = join(dir, "node");
      const node = version(binary);
      if (matches(node)) return selected(binary, node);
    }
  }
  // Let nvm interpret aliases without installing anything.
  const script = join(nvmDir, "nvm.sh");
  if (isAbsolute(script) && existsSync(script)) {
    const which = spawnSync("bash", ["-c", '. "$1" --no-use && nvm which', "coord-nvm", script],
      { cwd, env, encoding: "utf8", timeout: 5_000 });
    const binary = which.stdout?.trim().split("\n").at(-1) ?? "";
    if (which.status === 0 && isAbsolute(binary)) {
      const node = version(binary);
      if (matches(node)) return selected(binary, node);
    }
  }
  throw new NodePinError(`node (${pin} required by .nvmrc)`, `Project requires Node ${pin} from ${pinFile}; install that version before running checks.`);
};

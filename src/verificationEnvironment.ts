import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/** Resolve a product pin in its own checkout. Do not mutate the coordinator's PATH. */
export const verificationEnvironment = (cwd: string, inherited: NodeJS.ProcessEnv = process.env) => {
  const env = { ...inherited };
  const pinFile = join(cwd, ".nvmrc");
  const selected = (binary: string, node: string) => ({
    env: { ...env, PATH: [dirname(binary), env.PATH].filter(Boolean).join(delimiter) }, node
  });
  if (!existsSync(pinFile)) {
    if (!existsSync(join(cwd, "package.json"))) return { env, node: process.version };
    const probe = spawnSync("node", ["--version"], { cwd, env, encoding: "utf8" });
    if (probe.error && (probe.error as NodeJS.ErrnoException).code === "ENOENT") return selected(process.execPath, process.version);
    return { env, node: probe.status === 0 ? probe.stdout.trim() : "unavailable" };
  }
  if (!lstatSync(pinFile).isFile()) throw new Error(`Expected a regular file at ${pinFile}`);
  const pin = readFileSync(pinFile, "utf8").trim();
  const nvmDir = env.NVM_DIR ?? join(env.HOME ?? "", ".nvm");
  const exact = /^v?\d+\.\d+\.\d+$/.test(pin) ? `v${pin.replace(/^v/, "")}` : null;
  const version = (binary: string) => {
    const probe = spawnSync(binary, ["--version"], { cwd, env, encoding: "utf8" });
    return probe.status === 0 ? probe.stdout.trim() : "";
  };
  if (exact !== null) {
    if (process.version === exact) return selected(process.execPath, exact);
    const dirs = [...(env.PATH ?? "").split(delimiter), join(nvmDir, "versions/node", exact, "bin")];
    for (const dir of dirs.filter(isAbsolute)) {
      const binary = join(dir, "node");
      if (version(binary) === exact) return selected(binary, exact);
    }
  }
  // Let nvm interpret aliases and partial pins without installing anything.
  const script = join(nvmDir, "nvm.sh");
  if (isAbsolute(script) && existsSync(script)) {
    const which = spawnSync("bash", ["-c", '. "$1" --no-use && nvm which', "coord-nvm", script],
      { cwd, env, encoding: "utf8" });
    const binary = which.stdout?.trim().split("\n").at(-1) ?? "";
    if (which.status === 0 && isAbsolute(binary)) {
      const node = version(binary);
      if (/^v\d+\.\d+\.\d+$/.test(node) && (exact === null || node === exact)) return selected(binary, node);
    }
  }
  throw new Error(`Project requires Node ${pin} from ${pinFile}; install that version before running checks.`);
};

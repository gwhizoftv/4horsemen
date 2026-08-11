#!/usr/bin/env node
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const blocked = (message) => {
  process.stderr.write(`HOOK BLOCKED: ${message}\n`);
  process.stderr.write("  Fix the workspace policy or rerun coord install; hooks never infer a product toolchain.\n");
  return 1;
};

const git = (args, options = {}) => {
  const result = spawnSync("git", args, { cwd: process.cwd(), encoding: "utf8", ...options });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const localConfig = (key) => {
  const result = git(["config", "--local", "--get", key]);
  return result.status === 0 ? result.stdout.trim() : "";
};

const loadIdentity = () => {
  const id = localConfig("consensus.agentId");
  const label = localConfig("consensus.agentLabel");
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error("local consensus.agentId is missing or malformed.");
  if (!/^[A-Za-z][A-Za-z0-9 ._-]*$/.test(label)) throw new Error("local consensus.agentLabel is missing or malformed.");
  return {
    id,
    label,
    shared: localConfig("consensus.sharedBranch") || "main",
    remote: localConfig("consensus.remoteName") || "origin"
  };
};

const loadPolicy = (phase) => {
  let path = localConfig("coord.workspaceConfig");
  if (path === "") {
    const checkout = git(["rev-parse", "--show-toplevel"]);
    const coordinationRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const developmentConfig = join(coordinationRoot, "config.example.json");
    if (checkout.status === 0 && resolve(checkout.stdout.trim()) === coordinationRoot && existsSync(developmentConfig)) {
      // The coordination package develops its own canonical hooks directly.
      // Product agent clones never satisfy this path-identity check: their
      // bodies execute from the separate install root or a vendor directory.
      path = developmentConfig;
    } else {
      throw new Error("local coord.workspaceConfig is missing.");
    }
  }
  let config;
  try {
    config = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`workspace config ${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (config === null || typeof config !== "object" || config.verify === null || typeof config.verify !== "object") {
    throw new Error('workspace config has no verify declaration; add explicit "precommit" and "prepush" arrays (empty arrays opt out).');
  }
  const commands = config.verify[phase];
  if (!Array.isArray(commands)) throw new Error(`workspace config verify.${phase} must be an array (use [] to opt out explicitly).`);
  for (const [index, command] of commands.entries()) {
    if (
      command === null ||
      typeof command !== "object" ||
      typeof command.name !== "string" ||
      command.name === "" ||
      !Array.isArray(command.argv) ||
      command.argv.length === 0 ||
      command.argv.some((part) => typeof part !== "string" || part === "")
    ) {
      throw new Error(`workspace config verify.${phase}[${index}] must contain a name and non-empty argv.`);
    }
  }
  const prefixes = Array.isArray(config.workflowCriticalPrefixes) && config.workflowCriticalPrefixes.every((value) => typeof value === "string")
    ? config.workflowCriticalPrefixes
    : [];
  const files = Array.isArray(config.workflowCriticalFiles) && config.workflowCriticalFiles.every((value) => typeof value === "string")
    ? config.workflowCriticalFiles
    : [];
  return { commands, prefixes, files };
};

const validateOwnedBranch = (branch, identity, operation) => {
  if (branch === identity.shared || /^issue-[0-9]+\/final$/.test(branch)) {
    throw new Error(`${operation} '${branch}' is forbidden; shared and final branches are owner-only.`);
  }
  const issue = /^issue-[0-9]+\/([a-z0-9-]+)$/.exec(branch);
  if (issue !== null) {
    if (issue[1] !== identity.id) throw new Error(`${operation} '${branch}' is forbidden because it belongs to '${issue[1]}'.`);
    return;
  }
  if (!branch.startsWith(`${identity.id}/`)) {
    throw new Error(`${operation} '${branch}' is forbidden; use issue-<n>/${identity.id} or ${identity.id}/<name>.`);
  }
};

const runCommands = (commands, identity, phase) => {
  for (const command of commands) {
    process.stdout.write(`${identity.label} hook: running ${command.name}: ${command.argv.join(" ")}\n`);
    const result = spawnSync(command.argv[0], command.argv.slice(1), { cwd: process.cwd(), env: process.env, stdio: "inherit", shell: false });
    if (result.error !== undefined) throw new Error(`${phase} command '${command.name}' could not start: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`${phase} command '${command.name}' failed with exit ${result.status ?? "unknown"}.`);
  }
};

const coordinationOnly = (paths) =>
  paths.length > 0 && paths.every((path) => /^(?:\.plans|\.signals|\.code-reviews)\//.test(path));

const precommit = (identity, policy) => {
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.status !== 0) throw new Error("commits from a detached HEAD are forbidden in an agent clone.");
  validateOwnedBranch(branch.stdout.trim(), identity, "committing on");
  const staged = git(["diff", "--cached", "--name-only", "-z"]);
  if (staged.status !== 0) throw new Error(`staged paths could not be inspected: ${staged.stderr.trim()}`);
  const paths = staged.stdout.split("\0").filter(Boolean);
  if (coordinationOnly(paths)) {
    process.stdout.write(`${identity.label} hook: declared precommit verification skipped for coordination-only evidence.\n`);
    return;
  }
  runCommands(policy.commands, identity, "precommit");
};

const isCritical = (path, policy) =>
  (policy.prefixes.length === 0 && policy.files.length === 0) ||
  policy.prefixes.some((prefix) => path.startsWith(prefix)) ||
  policy.files.includes(path);

const prepush = (identity, policy) => {
  const input = readFileSync(0, "utf8").trim();
  if (input === "") return;
  const refs = input.split(/\r?\n/).map((line) => line.trim().split(/\s+/));
  let mustVerify = refs.length > 1;
  const zero = "0".repeat(40);
  for (const fields of refs) {
    if (fields.length !== 4) throw new Error("pre-push received a malformed ref update.");
    const [, localSha, remoteRef, remoteSha] = fields;
    const branch = remoteRef.startsWith("refs/heads/") ? remoteRef.slice("refs/heads/".length) : remoteRef;
    validateOwnedBranch(branch, identity, "pushing");
    if (localSha === zero) throw new Error(`deleting remote branch '${branch}' is forbidden.`);
    if (remoteSha !== zero) {
      const ancestor = git(["merge-base", "--is-ancestor", remoteSha, localSha]);
      if (ancestor.status !== 0) throw new Error(`history rewrite of '${branch}' is forbidden.`);
    }
    if (refs.length > 1) continue;
    let base = remoteSha;
    if (remoteSha === zero) {
      const mergeBase = git(["merge-base", localSha, `refs/remotes/${identity.remote}/${identity.shared}`]);
      if (mergeBase.status !== 0 || mergeBase.stdout.trim() === "") {
        mustVerify = true;
        continue;
      }
      base = mergeBase.stdout.trim();
    }
    const changed = git(["diff", "--name-only", "-z", base, localSha]);
    if (changed.status !== 0) {
      mustVerify = true;
      continue;
    }
    mustVerify = changed.stdout.split("\0").filter(Boolean).some((path) => isCritical(path, policy));
  }
  if (!mustVerify) {
    process.stdout.write(`${identity.label} hook: declared prepush verification skipped; no workflow-critical paths changed.\n`);
    return;
  }
  runCommands(policy.commands, identity, "prepush");
};

export const executableOnPath = (command, env = process.env) => {
  const candidates = command.includes("/")
    ? [isAbsolute(command) ? command : resolve(process.cwd(), command)]
    : (env.PATH ?? "").split(delimiter).map((entry) => resolve(entry || ".", command));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
};

export const main = () => {
  const phase = process.argv[2];
  if (phase !== "precommit" && phase !== "prepush") return blocked(`unknown verification phase '${phase ?? ""}'.`);
  try {
    const identity = loadIdentity();
    const policy = loadPolicy(phase);
    if (phase === "precommit") precommit(identity, policy);
    else prepush(identity, policy);
    return 0;
  } catch (error) {
    return blocked(error instanceof Error ? error.message : String(error));
  }
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}

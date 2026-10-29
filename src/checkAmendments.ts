import { existsSync } from "node:fs";
import { git } from "./gitExec.js";
import { sha256 } from "./hash.js";
import type { CheckProposal } from "./protocol.js";
import { atomicWriteJson, readConfig, type AdoptedCheck, type CheckCommand, type CoordinatorConfig, type StartState } from "./state.js";
import { withWorkspaceConfigLock } from "./setupWorkspace.js";
import { workspaceLocationFromConfig } from "./workspace.js";

/** Append ordered sequences, preserving prerequisites and rejecting replacement by name. */
export const addCheckCommands = (base: readonly CheckCommand[], proposals: readonly CheckProposal[]): CheckCommand[] => {
  const result = [...base], seen = new Set<string>();
  for (const proposal of proposals) {
    const key = JSON.stringify(proposal.commands);
    if (seen.has(key) || key === JSON.stringify(base)) continue;
    seen.add(key);
    for (const command of proposal.commands) {
      if (result.some((entry) => entry.name === command.name)) {
        throw new Error(`Check proposals may only add checks; '${command.name}' is already required. Use a distinct name for the new sequence.`);
      }
      result.push(command);
    }
  }
  return result;
};

export const effectiveCheckDigest = (start: Pick<StartState, "verification" | "documentation" | "verificationDigest">,
  commands: readonly CheckCommand[], additions: readonly AdoptedCheck[] = []): string => additions.length === 0 && start.verificationDigest ? start.verificationDigest : sha256(JSON.stringify({
  verification: start.verification ?? null, documentation: start.documentation ?? null, commands,
  additions: additions.map((addition) => addition.id)
}));

const entryBlob = (root: string, pin: string, path: string): string | null => {
  const result = git(root, "ls-tree", "-z", pin, "--", path);
  if (result.exitCode !== 0) throw new Error(`Cannot inspect check entry point ${path} at ${pin}: ${result.stderr}`);
  const match = /^(100644|100755) blob ([a-f0-9]{40})\t/.exec(result.stdout);
  return match?.[2] ?? null;
};

export const recordCheckAddition = (root: string, issue: number, proposal: CheckProposal): AdoptedCheck => {
  const blobs: Record<string, string> = {};
  for (const path of proposal.entryPointPaths) {
    const blob = entryBlob(root, proposal.implementationCommitSha, path);
    if (blob === null) throw new Error(`Check entry point must be an ordinary tracked file: ${path}`);
    blobs[path] = blob;
  }
  return { id: sha256(JSON.stringify({ issue, proposal })), issue, proposal, blobs, activationPins: [] };
};

const isAncestor = (root: string, base: string, pin: string): boolean => {
  const result = git(root, "merge-base", "--is-ancestor", base, pin);
  // An unmerged pin may not have been fetched into a new clone: content remains a usable proof.
  return result.exitCode === 0;
};

export const activateCheckAdditions = (root: string, baseline: string, config: CoordinatorConfig): {
  checks: CheckCommand[]; active: AdoptedCheck[]; pending: string[]
} => {
  const active: AdoptedCheck[] = [], pending: string[] = [];
  for (const addition of config.adoptedChecks ?? []) {
    const current = Object.fromEntries(addition.proposal.entryPointPaths.map((path) => [path, entryBlob(root, baseline, path)]));
    const ancestor = [addition.proposal.implementationCommitSha, ...addition.activationPins].some((pin) => isAncestor(root, pin, baseline));
    const present = Object.values(current).every((blob) => blob !== null);
    const same = present && Object.entries(addition.blobs).every(([path, blob]) => current[path] === blob);
    if (ancestor && !present) throw new Error(`Required check entry point was removed (${addition.proposal.description}). Run coord onboard to change saved settings.`);
    if (present && (ancestor || same)) active.push({ ...addition, activationPins: [...new Set([...addition.activationPins, baseline])] });
    else pending.push(`${addition.proposal.description}: starting code does not yet prove the new entry point; keep pending or change settings with coord onboard.`);
  }
  return { checks: addCheckCommands(config.checks, active.map((addition) => addition.proposal)), active, pending };
};

/** Short, serialized merge: never overwrite another owner change with a stale config. */
export const persistCheckAdditions = (configPath: string, additions: readonly AdoptedCheck[]): void => {
  if (!additions.length) return;
  withWorkspaceConfigLock(configPath, () => {
    if (!existsSync(configPath)) throw new Error(`Cannot save accepted checks: workspace config missing at ${configPath}`);
    const latest = readConfig(configPath), merged = [...(latest.adoptedChecks ?? [])];
    for (const addition of additions) {
      const index = merged.findIndex((entry) => entry.id === addition.id);
      if (index < 0) merged.push(addition);
      else merged[index] = { ...merged[index]!, activationPins: [...new Set([...merged[index]!.activationPins, ...addition.activationPins])] };
    }
    // Name conflicts are errors, including across concurrently accepted additions.
    addCheckCommands(latest.checks, merged.map((entry) => entry.proposal));
    atomicWriteJson(workspaceLocationFromConfig(configPath).coordRoot, configPath, { ...latest, adoptedChecks: merged });
  });
};

import { closeSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./gitExec.js";
import { sha256 } from "./hash.js";
import {
  acquireExclusiveLock,
  atomicWriteJson,
  readConfig,
  type AdoptedCheck,
  type CheckCommand
} from "./state.js";
import type { CheckProposal } from "./protocol.js";

/**
 * Shared additive-check policy (#261): merging a reviewed proposal into the
 * frozen issue checks, binding results to the effective policy, checking
 * baseline eligibility, and persisting adoptions. The CLI, the run loop,
 * and diagnostics all use these rules rather than reconstructing them.
 */

/** Frozen commands first, proposal additions appended; order is preserved. */
export const effectiveChecks = (
  frozen: readonly CheckCommand[], proposal: CheckProposal
): CheckCommand[] => [
  ...frozen.map((command) => ({ ...command, argv: [...command.argv] })),
  ...proposal.commands.map((command) => ({ name: command.name, argv: [...command.argv] }))
];

/** Why a proposal cannot be added, or null when it is purely additive. */
export const proposalConflict = (
  frozen: readonly CheckCommand[], proposal: CheckProposal
): string | null => {
  for (const command of proposal.commands) {
    const existing = frozen.find((entry) => entry.name === command.name);
    if (existing !== undefined) {
      return `check proposals may only add checks; replacing or removing existing check ${command.name} is not done through this path`;
    }
    if (frozen.some((entry) => JSON.stringify(entry.argv) === JSON.stringify(command.argv))) {
      return `check proposal command ${command.name} duplicates an existing check command`;
    }
  }
  return null;
};

/** Digest binding verification results and receipts to the effective policy. */
export const policyDigestFor = (
  checks: readonly CheckCommand[], amendmentIds: readonly string[]
): string => sha256(JSON.stringify({
  v: 1,
  checks: checks.map((command) => ({ name: command.name, argv: [...command.argv] })),
  amendments: [...amendmentIds].sort()
}));

/** True when the path exists as a blob at the given commit in this repository. */
export const entryPointExistsAt = (repoRoot: string, sha: string, path: string): boolean => {
  const result = git(repoRoot, "cat-file", "-e", `${sha}:${path}`);
  return result.exitCode === 0;
};

/** Adopted records whose entry points all exist at a new issue's baseline. */
export const eligibleAdoptedChecks = (
  adopted: readonly AdoptedCheck[], repoRoot: string, baselineSha: string
): { active: AdoptedCheck[]; pending: AdoptedCheck[] } => {
  const active: AdoptedCheck[] = [];
  const pending: AdoptedCheck[] = [];
  for (const record of adopted) {
    const ready = record.entryPointPaths.every((path) => entryPointExistsAt(repoRoot, baselineSha, path));
    (ready ? active : pending).push(record);
  }
  return { active, pending };
};

/**
 * Persist one adoption into the workspace config. Serialized under the
 * config lock with a re-read inside it, so a concurrent onboarding write
 * cannot silently drop the addition; identical adoptions dedupe.
 */
export const persistAdoptedCheck = (coordRoot: string, configPath: string, record: AdoptedCheck): boolean => {
  const lockPath = join(dirname(configPath), ".config-adopt.lock");
  const lock = acquireExclusiveLock(lockPath);
  try {
    const config = readConfig(configPath);
    const adopted = config.adoptedChecks ?? [];
    const duplicate = adopted.some((entry) =>
      JSON.stringify(entry.commands) === JSON.stringify(record.commands) &&
      JSON.stringify([...entry.entryPointPaths].sort()) === JSON.stringify([...record.entryPointPaths].sort()));
    if (duplicate) return false;
    atomicWriteJson(coordRoot, configPath, { ...config, adoptedChecks: [...adopted, record] });
    return true;
  } finally {
    closeSync(lock);
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }
};

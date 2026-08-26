import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import {
  acceptedResponseArchivePath,
  agentResponsePath,
  assertNoSymlink,
  containedPath,
  type IssueRuntimePaths
} from "./paths.js";
import {
  consensusBallotResponseSchema,
  parseJsonWithSchema,
  planComparisonBallotResponseSchema,
  RESPONSE_MAX_BYTES
} from "./protocol.js";
import { sha256 } from "./hash.js";
import type { ResponseObservation, WorkflowStepId } from "./steps.js";

export { RESPONSE_MAX_BYTES } from "./protocol.js";

const rejected = (agent: string, actionId: string, outstanding: string[]): ResponseObservation => ({
  agent,
  actionId,
  status: "rejected",
  outstanding
});

export const clearAgentResponse = (path: string): void => {
  if (existsSync(path)) unlinkSync(path);
};

export const evaluateBallotResponse = (input: {
  paths: IssueRuntimePaths;
  agent: string;
  actionId: string;
  stepId: WorkflowStepId;
  eligibleChoices: readonly string[];
}): ResponseObservation => {
  const path = agentResponsePath(input.paths, input.agent, input.actionId);
  assertNoSymlink(input.paths.coordRoot, path);
  if (!existsSync(path)) return rejected(input.agent, input.actionId, ["response file is missing"]);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return rejected(input.agent, input.actionId, ["response path must be a regular file, not a symlink or special file"]);
  }
  if (stat.size > RESPONSE_MAX_BYTES) {
    return rejected(input.agent, input.actionId, [`response exceeds the ${RESPONSE_MAX_BYTES}-byte limit`]);
  }
  const bytes = readFileSync(path);
  const after = lstatSync(path);
  if (
    after.isSymbolicLink() ||
    !after.isFile() ||
    after.dev !== stat.dev ||
    after.ino !== stat.ino ||
    after.size !== stat.size
  ) {
    return rejected(input.agent, input.actionId, ["response file changed while it was being read"]);
  }
  if (bytes.byteLength > RESPONSE_MAX_BYTES) {
    return rejected(input.agent, input.actionId, [`response exceeds the ${RESPONSE_MAX_BYTES}-byte limit`]);
  }
  const raw = bytes.toString("utf8");
  if (input.stepId === "R3.plan-ballot" || input.stepId === "R5.compare-ballot") {
    const parsed = parseJsonWithSchema(raw, planComparisonBallotResponseSchema);
    if (!parsed.ok) return rejected(input.agent, input.actionId, [`invalid ballot response: ${parsed.error}`]);
    const outstanding: string[] = [];
    if (parsed.value.actionId !== input.actionId) outstanding.push("response actionId does not match the current action");
    if (!input.eligibleChoices.includes(parsed.value.choice)) {
      outstanding.push(`response choice ${parsed.value.choice} is not currently eligible`);
    }
    if (outstanding.length > 0) return rejected(input.agent, input.actionId, outstanding);
    return {
      agent: input.agent,
      actionId: input.actionId,
      status: "satisfied",
      outstanding: [],
      responseSha256: sha256(bytes),
      choice: parsed.value.choice,
      rationale: parsed.value.rationale,
      bytes
    };
  }
  if (input.stepId !== "R6.ballot") {
    return rejected(input.agent, input.actionId, ["current action is not a response ballot"]);
  }
  const parsed = parseJsonWithSchema(raw, consensusBallotResponseSchema);
  if (!parsed.ok) return rejected(input.agent, input.actionId, [`invalid consensus response: ${parsed.error}`]);
  if (parsed.value.actionId !== input.actionId) {
    return rejected(input.agent, input.actionId, ["response actionId does not match the current action"]);
  }
  return {
    agent: input.agent,
    actionId: input.actionId,
    status: "satisfied",
    outstanding: [],
    responseSha256: sha256(bytes),
    disposition: parsed.value.disposition,
    rationale: parsed.value.rationale,
    bytes
  };
};

/**
 * Persist exact accepted bytes without ever replacing another accepted action.
 * A byte-identical file left by an interrupted prior acceptance is idempotent;
 * different bytes at the immutable archive path fail closed.
 */
export const archiveAcceptedResponse = (
  paths: IssueRuntimePaths,
  agent: string,
  actionId: string,
  bytes: Uint8Array
): string => {
  const archive = acceptedResponseArchivePath(paths, agent, actionId);
  const directory = dirname(archive);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlink(paths.coordRoot, directory);
  if (existsSync(archive)) {
    const existing = readFileSync(archive);
    if (!existing.equals(Buffer.from(bytes))) throw new Error(`Accepted response archive conflict at ${archive}.`);
    return archive;
  }
  const temporary = containedPath(directory, `.${randomUUID()}.tmp`);
  const handle = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(handle, bytes);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  try {
    linkSync(temporary, archive);
  } catch (error) {
    if (!existsSync(archive) || !readFileSync(archive).equals(Buffer.from(bytes))) throw error;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  const directoryHandle = openSync(directory, "r");
  try {
    fsyncSync(directoryHandle);
  } finally {
    closeSync(directoryHandle);
  }
  return archive;
};

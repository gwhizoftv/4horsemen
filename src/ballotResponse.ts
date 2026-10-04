import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import { sha256 } from "./hash.js";
import { assertNoSymlink, containedPath, type IssueRuntimePaths } from "./paths.js";
import {
  actionIdSchema,
  amendmentBallotResponseSchema,
  consensusBallotResponseSchema,
  planComparisonBallotResponseSchema,
  type ConsensusBallotResponse,
  type PlanComparisonBallotResponse
} from "./protocol.js";
import { isBallotStep, type WorkflowStepId } from "./steps.js";

export const RESPONSE_MAX_BYTES = 8192;

export type BallotResponseValue = PlanComparisonBallotResponse | ConsensusBallotResponse;

export type ResponseReadResult =
  | { status: "missing" }
  | { status: "oversized" }
  | { status: "not-a-file" }
  | { status: "symlink" }
  | { status: "read"; bytes: Buffer };

export type ResponseParseResult =
  | { ok: true; value: BallotResponseValue }
  | { ok: false; outstanding: readonly string[] };

export const readAgentResponse = (path: string, root: string): ResponseReadResult => {
  if (!existsSync(path)) return { status: "missing" };
  try {
    assertNoSymlink(root, path);
  } catch {
    return { status: "symlink" };
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return { status: "symlink" };
  if (!stat.isFile()) return { status: "not-a-file" };
  if (stat.size > RESPONSE_MAX_BYTES) return { status: "oversized" };
  const bytes = readFileSync(path);
  if (bytes.byteLength > RESPONSE_MAX_BYTES) return { status: "oversized" };
  return { status: "read", bytes };
};

export const parseBallotResponse = (
  raw: string,
  stepId: WorkflowStepId,
  expectedActionId: string,
  eligibleChoices: readonly string[]
): ResponseParseResult => {
  if (!isBallotStep(stepId)) {
    return { ok: false, outstanding: [`step ${stepId} does not accept a ballot response`] };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      ok: false,
      outstanding: [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
  const schema =
    stepId === "R4.amend-ballot" ? amendmentBallotResponseSchema :
      stepId === "R6.ballot" ? consensusBallotResponseSchema : planComparisonBallotResponseSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, outstanding: [parsed.error.issues.map((issue) => issue.message).join("; ")] };
  }
  const outstanding: string[] = [];
  if (parsed.data.actionId !== expectedActionId) {
    outstanding.push(`response actionId must be ${expectedActionId}`);
  }
  if (stepId !== "R6.ballot" && stepId !== "R4.amend-ballot") {
    const choice = (parsed.data as PlanComparisonBallotResponse).choice;
    if (!eligibleChoices.includes(choice)) {
      outstanding.push(`choice ${choice} is not eligible`);
    }
  }
  if (outstanding.length > 0) return { ok: false, outstanding };
  return { ok: true, value: parsed.data };
};

export const responseDigest = (bytes: Buffer | string): string => sha256(bytes);

export const archiveAcceptedResponse = (
  paths: IssueRuntimePaths,
  agent: string,
  actionId: string,
  bytes: Buffer
): string => {
  actionIdSchema.parse(actionId);
  const archiveDir = containedPath(paths.issueRoot, "accepted-responses", agent);
  assertNoSymlink(paths.issueRoot, dirname(archiveDir));
  mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
  assertNoSymlink(paths.issueRoot, archiveDir);
  const archivePath = containedPath(archiveDir, `${actionId}.json`);
  if (existsSync(archivePath)) {
    const existing = readFileSync(archivePath);
    if (Buffer.compare(existing, bytes) !== 0) {
      throw new Error(`accepted-response archive for ${agent}/${actionId} already exists with different bytes`);
    }
    return archivePath;
  }
  const temporary = containedPath(archiveDir, `.${randomUUID()}.tmp`);
  const handle = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(handle, bytes);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, archivePath);
  return archivePath;
};

export const clearAgentResponse = (path: string): void => {
  if (existsSync(path)) unlinkSync(path);
};

export const writeAgentResponse = (path: string, root: string, value: BallotResponseValue): void => {
  assertNoSymlink(root, dirname(path));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = containedPath(dirname(path), `.${randomUUID()}.tmp`);
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const handle = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(handle, body);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, path);
};

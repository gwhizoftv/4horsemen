import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { sha256 } from "./hash.js";
import { assertNoSymlink, containedPath, PathSafetyError } from "./paths.js";
import {
  consensusResponseSchema,
  parseJsonWithSchema,
  planComparisonResponseSchema,
  type BallotResponse
} from "./protocol.js";
import { isBallotStep, type InternalOrder, type ResponseObservation, type WorkflowStepId } from "./steps.js";

/**
 * Whole-file ceiling, enforced before any parse.
 *
 * A valid response is a few hundred bytes. The cap exists because the reader
 * runs before the schema does: without it a multi-gigabyte file at a path an
 * agent controls would be read into memory by the coordinator's own tick, which
 * is a denial of service against every other agent on the issue, not just the
 * one that wrote it.
 */
export const RESPONSE_MAX_BYTES = 8192;

export type ResponseReadResult =
  | { status: "missing" }
  | { status: "rejected"; message: string }
  | { status: "read"; bytes: Buffer };

/**
 * Read one working response with every check that must precede a parse.
 *
 * Order matters: symlink, file type, and size are all checked before the bytes
 * are interpreted, because each of them is a way to make the *act of reading*
 * do something other than read a small JSON file.
 */
export const readAgentResponse = (root: string, path: string): ResponseReadResult => {
  try {
    assertNoSymlink(root, path);
  } catch (error) {
    if (error instanceof PathSafetyError) return { status: "rejected", message: error.message };
    throw error;
  }
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { status: "missing" };
    throw error;
  }
  if (stats.isSymbolicLink()) {
    return { status: "rejected", message: "the response path is a symlink" };
  }
  if (!stats.isFile()) {
    return { status: "rejected", message: "the response path is not a regular file" };
  }
  if (stats.size > RESPONSE_MAX_BYTES) {
    return {
      status: "rejected",
      message: `the response is ${stats.size} bytes; the maximum is ${RESPONSE_MAX_BYTES}`
    };
  }
  return { status: "read", bytes: readFileSync(path) };
};

/** SHA-256 over the exact accepted bytes. Never supplied by an agent. */
export const responseDigest = (bytes: Buffer): string => sha256(bytes);

export const parseBallotResponse = (
  stepId: WorkflowStepId,
  raw: string
): { ok: true; value: BallotResponse } | { ok: false; error: string } => {
  const parsed =
    stepId === "R6.ballot"
      ? parseJsonWithSchema(raw, consensusResponseSchema)
      : parseJsonWithSchema(raw, planComparisonResponseSchema);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, error: parsed.error };
};

/**
 * Turn the bytes at a response path into an observation.
 *
 * Every binding is taken from `order`, which the coordinator built from its own
 * state; nothing here reads identity, round, issue, or eligibility out of the
 * response. The only things the response is allowed to contribute are the
 * action id it claims to answer — which must equal the current one — and the
 * judgment itself.
 */
export const evaluateResponse = (input: {
  root: string;
  order: InternalOrder;
  markerActionId: string;
}): ResponseObservation => {
  const { order, markerActionId } = input;
  const rejected = (message: string): ResponseObservation => ({
    agent: order.agent,
    actionId: order.actionId,
    status: "rejected",
    outstanding: [message]
  });

  if (!isBallotStep(order.stepId)) return rejected("this action is not answered with a response");
  if (markerActionId !== order.actionId) {
    return rejected(`the completion marker names ${markerActionId}, which is not the current action`);
  }
  const responsePath = order.responsePath;
  if (responsePath === null) return rejected("this action has no response path");

  const read = readAgentResponse(input.root, responsePath);
  if (read.status === "missing") {
    return rejected(`no response was found at ${responsePath}`);
  }
  if (read.status === "rejected") return rejected(read.message);

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
  } catch {
    return rejected("the response is not valid UTF-8");
  }

  const parsed = parseBallotResponse(order.stepId, text);
  if (!parsed.ok) return rejected(`invalid response: ${parsed.error}`);
  const value = parsed.value;

  // The response repeats its own action id so a file left behind by an earlier
  // action cannot be adopted by a later one that happens to share a path. The
  // path is already action-scoped; this is the second, independent binding.
  if (value.actionId !== order.actionId) {
    return rejected("the response actionId does not match the current action");
  }

  const responseSha256 = responseDigest(read.bytes);
  if ("choice" in value) {
    if (!order.eligibleChoices.includes(value.choice)) {
      return rejected(
        `${value.choice} is not one of the eligible choices for this action: ${order.eligibleChoices.join(", ")}`
      );
    }
    return {
      agent: order.agent,
      actionId: order.actionId,
      status: "satisfied",
      outstanding: [],
      responseSha256,
      rationale: value.rationale,
      choice: value.choice
    };
  }
  return {
    agent: order.agent,
    actionId: order.actionId,
    status: "satisfied",
    outstanding: [],
    responseSha256,
    rationale: value.rationale,
    disposition: value.disposition
  };
};

export type ArchiveResult = { status: "written" | "already-identical" } | { status: "conflict"; message: string };

/**
 * Archive the exact accepted bytes, exactly once.
 *
 * Created exclusively (`wx`) so an archive can never be silently rewritten: the
 * archive is the record of what was accepted, and a vote that could be edited
 * after the fact is not evidence. A crash between archiving and persisting
 * state is the one case where the file already exists legitimately, so
 * byte-identical content is treated as success and anything else as a conflict.
 */
export const archiveAcceptedResponse = (root: string, path: string, bytes: Buffer): ArchiveResult => {
  assertNoSymlink(root, dirname(path));
  if (existsSync(path)) {
    return readFileSync(path).equals(bytes)
      ? { status: "already-identical" }
      : { status: "conflict", message: `an accepted response is already archived at ${path} with different bytes` };
  }
  const temporary = containedPath(dirname(path), `.${randomUUID()}.tmp`);
  const handle = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(handle, bytes);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  return { status: "written" };
};

export const clearAgentResponse = (path: string): void => {
  if (existsSync(path)) unlinkSync(path);
};

/** Atomic write used by the `coord respond` helper; never by acceptance. */
export const writeAgentResponse = (path: string, value: unknown): void => {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > RESPONSE_MAX_BYTES) {
    throw new Error(`The response is larger than the ${RESPONSE_MAX_BYTES}-byte maximum.`);
  }
  const temporary = containedPath(dirname(path), `.${randomUUID()}.tmp`);
  const handle = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(handle, serialized, "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, path);
};

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RESPONSE_MAX_BYTES,
  archiveAcceptedResponse,
  clearAgentResponse,
  evaluateResponse,
  parseBallotResponse,
  readAgentResponse,
  responseDigest,
  writeAgentResponse
} from "../src/ballotResponse.js";
import { sha256 } from "../src/hash.js";
import type { InternalOrder } from "../src/steps.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const root = (): string => {
  const created = mkdtempSync(join(tmpdir(), "coord-response-"));
  roots.push(created);
  return created;
};

const ACTION_ID = "179da8c7-ae22-47eb-b6eb-211ceea6b732";
const OTHER_ACTION_ID = "b2337d85-6617-4e9f-8ace-901453764aa4";

const order = (base: string, overrides: Partial<InternalOrder> = {}): InternalOrder => ({
  actionId: ACTION_ID,
  issue: 1,
  agent: "codex",
  stepId: "R3.plan-ballot",
  evidenceId: "plan-ballot-accepted",
  submissionMode: "response",
  requiredPath: ".plans/issue-1/ballot-codex.json",
  responsePath: join(base, "responses", `${ACTION_ID}.json`),
  completePath: join(base, "complete"),
  branch: "issue-1/codex",
  round: null,
  issueSessionId: `issue-1:${"a".repeat(40)}`,
  baselineSha: "a".repeat(40),
  automationDigest: "b".repeat(64),
  task: "Ballot",
  inputs: [],
  approvedPaths: [],
  activeRoster: ["claude", "codex"],
  eligibleChoices: ["claude", "codex"],
  ...overrides
});

const writeResponse = (base: string, value: unknown, actionId = ACTION_ID): string => {
  const path = join(base, "responses", `${actionId}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
};

describe("private ballot responses", () => {
  it("accepts a well-formed plan choice and hashes the exact bytes itself", () => {
    const base = root();
    const value = { actionId: ACTION_ID, choice: "claude", rationale: "clearest test strategy" };
    const path = writeResponse(base, value);
    const observation = evaluateResponse({ root: base, order: order(base), markerActionId: ACTION_ID });

    expect(observation.status).toBe("satisfied");
    expect(observation.choice).toBe("claude");
    expect(observation.rationale).toBe("clearest test strategy");
    // The digest is over the exact file bytes, not over a re-serialization: the
    // archive has to be provably the thing that was hashed.
    expect(observation.responseSha256).toBe(sha256(`${JSON.stringify(value)}\n`));
    void path;
  });

  it("accepts a consensus disposition and refuses one that is not in the enum", () => {
    const base = root();
    const consensusOrder = order(base, { stepId: "R6.ballot", evidenceId: "consensus-ballot-accepted", round: 1 });

    writeResponse(base, { actionId: ACTION_ID, disposition: "revise", rationale: "two blocking findings" });
    expect(evaluateResponse({ root: base, order: consensusOrder, markerActionId: ACTION_ID })).toMatchObject({
      status: "satisfied",
      disposition: "revise"
    });

    writeResponse(base, { actionId: ACTION_ID, disposition: "maybe", rationale: "unsure" });
    expect(evaluateResponse({ root: base, order: consensusOrder, markerActionId: ACTION_ID }).status).toBe(
      "rejected"
    );
  });

  it("refuses every coordinator-owned field an agent might try to supply", () => {
    const base = root();
    // Each of these is a binding the coordinator fills from trusted state. If a
    // response could carry one, an agent could vote on behalf of another agent,
    // in another issue, or against citations it chose itself.
    for (const extra of [
      { agent: "claude" },
      { issue: 2 },
      { issueSessionId: "issue-2:x" },
      { round: 3 },
      { inputSetHash: "c".repeat(64) },
      { responseSha256: "d".repeat(64) },
      { protocolVersion: 1 },
      { plans: [] }
    ]) {
      writeResponse(base, { actionId: ACTION_ID, choice: "claude", rationale: "ok", ...extra });
      expect(
        evaluateResponse({ root: base, order: order(base), markerActionId: ACTION_ID }).status,
        Object.keys(extra)[0]
      ).toBe("rejected");
    }
  });

  it("refuses an ineligible choice, a blank rationale, and an oversized rationale", () => {
    const base = root();

    writeResponse(base, { actionId: ACTION_ID, choice: "someone-else", rationale: "ok" });
    expect(evaluateResponse({ root: base, order: order(base), markerActionId: ACTION_ID }).outstanding[0]).toContain(
      "not one of the eligible choices"
    );

    writeResponse(base, { actionId: ACTION_ID, choice: "claude", rationale: "   " });
    expect(evaluateResponse({ root: base, order: order(base), markerActionId: ACTION_ID }).status).toBe("rejected");

    writeResponse(base, { actionId: ACTION_ID, choice: "claude", rationale: "x".repeat(1001) });
    expect(evaluateResponse({ root: base, order: order(base), markerActionId: ACTION_ID }).status).toBe("rejected");
  });

  it("refuses a stale marker and a response that answers a different action", () => {
    const base = root();

    // The marker names an action that is not the current one.
    writeResponse(base, { actionId: ACTION_ID, choice: "claude", rationale: "ok" });
    expect(
      evaluateResponse({ root: base, order: order(base), markerActionId: OTHER_ACTION_ID }).outstanding[0]
    ).toContain("not the current action");

    // The path is action-scoped, but the body claims a different action: both
    // bindings must agree, so a file moved or reused cannot be adopted.
    writeResponse(base, { actionId: OTHER_ACTION_ID, choice: "claude", rationale: "ok" });
    expect(evaluateResponse({ root: base, order: order(base), markerActionId: ACTION_ID }).outstanding[0]).toContain(
      "does not match the current action"
    );
  });

  it("refuses a missing, oversized, symlinked, or non-regular response before parsing", () => {
    const base = root();
    mkdirSync(join(base, "responses"), { recursive: true });

    expect(evaluateResponse({ root: base, order: order(base), markerActionId: ACTION_ID }).outstanding[0]).toContain(
      "no response was found"
    );

    writeFileSync(join(base, "responses", `${ACTION_ID}.json`), "x".repeat(RESPONSE_MAX_BYTES + 1));
    expect(readAgentResponse(base, join(base, "responses", `${ACTION_ID}.json`))).toMatchObject({
      status: "rejected"
    });

    // A directory at the response path: `readFileSync` on it would throw out of
    // the tick rather than reject one agent's answer.
    const dirBase = root();
    mkdirSync(join(dirBase, "responses", `${ACTION_ID}.json`), { recursive: true });
    expect(readAgentResponse(dirBase, join(dirBase, "responses", `${ACTION_ID}.json`))).toMatchObject({
      status: "rejected",
      message: "the response path is not a regular file"
    });

    // A symlink would let a write inside the granted directory be read from
    // anywhere the coordinator can reach.
    const linkBase = root();
    const outside = join(linkBase, "outside.json");
    writeFileSync(outside, "{}");
    mkdirSync(join(linkBase, "responses"), { recursive: true });
    symlinkSync(outside, join(linkBase, "responses", `${ACTION_ID}.json`));
    expect(readAgentResponse(linkBase, join(linkBase, "responses", `${ACTION_ID}.json`)).status).toBe("rejected");
  });

  it("refuses bytes that are not valid UTF-8 JSON", () => {
    const base = root();
    mkdirSync(join(base, "responses"), { recursive: true });
    writeFileSync(join(base, "responses", `${ACTION_ID}.json`), Buffer.from([0xff, 0xfe, 0x00]));
    expect(evaluateResponse({ root: base, order: order(base), markerActionId: ACTION_ID }).outstanding[0]).toContain(
      "not valid UTF-8"
    );
  });

  it("archives exactly once and treats a byte-identical replay as success", () => {
    const base = root();
    const archive = join(base, "accepted", `${ACTION_ID}.json`);
    mkdirSync(dirname(archive), { recursive: true });
    const bytes = Buffer.from('{"actionId":"x"}\n');

    expect(archiveAcceptedResponse(base, archive, bytes)).toEqual({ status: "written" });
    // A crash between archiving and persisting state re-runs acceptance; the
    // same bytes must not be an error.
    expect(archiveAcceptedResponse(base, archive, bytes)).toEqual({ status: "already-identical" });
    // Different bytes for the same action mean a vote is being rewritten after
    // the fact, which the archive exists to make impossible.
    expect(archiveAcceptedResponse(base, archive, Buffer.from("{}\n")).status).toBe("conflict");
  });

  it("round-trips the helper write and the digest the coordinator computes", () => {
    const base = root();
    mkdirSync(join(base, "responses"), { recursive: true });
    const path = join(base, "responses", `${ACTION_ID}.json`);
    writeAgentResponse(path, { actionId: ACTION_ID, choice: "claude", rationale: "clear" });

    const read = readAgentResponse(base, path);
    expect(read.status).toBe("read");
    if (read.status !== "read") throw new Error("unreachable");
    expect(responseDigest(read.bytes)).toMatch(/^[0-9a-f]{64}$/);
    expect(parseBallotResponse("R3.plan-ballot", read.bytes.toString("utf8"))).toMatchObject({ ok: true });

    clearAgentResponse(path);
    expect(readAgentResponse(base, path).status).toBe("missing");
  });

  it("refuses a helper write larger than the reader would accept", () => {
    const base = root();
    mkdirSync(join(base, "responses"), { recursive: true });
    expect(() =>
      writeAgentResponse(join(base, "responses", `${ACTION_ID}.json`), {
        actionId: ACTION_ID,
        choice: "claude",
        rationale: "x".repeat(RESPONSE_MAX_BYTES)
      })
    ).toThrow(/maximum/);
  });
});

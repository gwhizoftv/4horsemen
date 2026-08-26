import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateBallotResponse, RESPONSE_MAX_BYTES } from "../src/ballotResponse.js";
import { agentResponsePath, createIssueRuntime, issueRuntimePaths } from "../src/paths.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "coord-response-"));
  roots.push(root);
  const paths = issueRuntimePaths(join(root, "runtime"), 1, join(root, "mailbox"));
  createIssueRuntime(paths, ["codex"]);
  return paths;
};

describe("private ballot responses", () => {
  it("accepts an action-bound choice and hashes exact bytes", () => {
    const paths = fixture();
    const actionId = "b2337d85-6617-4e9f-8ace-901453764aa4";
    const path = agentResponsePath(paths, "codex", actionId);
    mkdirSync(join(paths.issueRoot, "agents", "codex", "responses"), { recursive: true });
    const bytes = Buffer.from(JSON.stringify({ actionId, choice: "codex", rationale: "bounded choice" }));
    writeFileSync(path, bytes);
    const result = evaluateBallotResponse({
      paths,
      agent: "codex",
      actionId,
      stepId: "R3.plan-ballot",
      eligibleChoices: ["codex"]
    });
    expect(result.status).toBe("satisfied");
    expect(result.responseSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.bytes).toEqual(bytes);
  });

  it("rejects oversized files before parsing", () => {
    const paths = fixture();
    const actionId = "b2337d85-6617-4e9f-8ace-901453764aa4";
    const path = agentResponsePath(paths, "codex", actionId);
    mkdirSync(join(paths.issueRoot, "agents", "codex", "responses"), { recursive: true });
    writeFileSync(path, Buffer.alloc(RESPONSE_MAX_BYTES + 1, 65));
    expect(evaluateBallotResponse({ paths, agent: "codex", actionId, stepId: "R6.ballot", eligibleChoices: [] })).toMatchObject({
      status: "rejected"
    });
  });
});

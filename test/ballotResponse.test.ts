import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveAcceptedResponse,
  clearAgentResponse,
  parseBallotResponse,
  readAgentResponse,
  RESPONSE_MAX_BYTES,
  responseDigest,
  writeAgentResponse
} from "../src/ballotResponse.js";
import { createIssueRuntime, issueRuntimePaths, agentResponsePath } from "../src/paths.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "coord-ballot-response-"));
  roots.push(root);
  const coordRoot = join(root, "coord");
  mkdirSync(coordRoot, { recursive: true });
  const paths = issueRuntimePaths(coordRoot, 1, join(root, "completes"));
  createIssueRuntime(paths, ["codex", "claude"]);
  return paths;
};

const actionId = "b2337d85-6617-4e9f-8ace-901453764aa4";

describe("ballotResponse", () => {
  it("binds amendment judgments to the current action and rejects non-judgment fields", () => {
    const body = { actionId, disposition: "approve", rationale: "Necessary for the selected behavior." };
    for (const disposition of ["approve", "revise"]) {
      expect(parseBallotResponse(JSON.stringify({ ...body, disposition }), "R4.amend-ballot", actionId, []).ok).toBe(true);
    }
    for (const patch of [{ actionId: "10000000-0000-4000-8000-000000000001" },
      { disposition: "escalate" }, { rationale: " " }, { scopeHash: "a".repeat(64) }]) {
      expect(parseBallotResponse(JSON.stringify({ ...body, ...patch }), "R4.amend-ballot", actionId, []).ok).toBe(false);
    }
  });
  it("parses strict plan and comparison responses", () => {
    const ok = parseBallotResponse(
      JSON.stringify({ actionId, choice: "claude", rationale: "Prefer the complete plan." }),
      "R3.plan-ballot",
      actionId,
      ["claude", "codex"]
    );
    expect(ok).toEqual({
      ok: true,
      value: { actionId, choice: "claude", rationale: "Prefer the complete plan." }
    });
    const ineligible = parseBallotResponse(
      JSON.stringify({ actionId, choice: "cursor", rationale: "nope" }),
      "R5.compare-ballot",
      actionId,
      ["claude", "codex"]
    );
    expect(ineligible.ok).toBe(false);
  });

  it("parses consensus dispositions and rejects illegal values", () => {
    expect(
      parseBallotResponse(
        JSON.stringify({ actionId, disposition: "approve", rationale: "Looks good." }),
        "R6.ballot",
        actionId,
        []
      )
    ).toMatchObject({ ok: true });
    expect(
      parseBallotResponse(
        JSON.stringify({ actionId, disposition: "maybe", rationale: "nope" }),
        "R6.ballot",
        actionId,
        []
      ).ok
    ).toBe(false);
  });

  it("rejects action-id mismatch, envelope fields, and oversized payloads", () => {
    const mismatch = parseBallotResponse(
      JSON.stringify({
        actionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        choice: "claude",
        rationale: "stale"
      }),
      "R3.plan-ballot",
      actionId,
      ["claude"]
    );
    expect(mismatch.ok).toBe(false);
    expect(
      parseBallotResponse(
        JSON.stringify({
          actionId,
          choice: "claude",
          rationale: "x",
          agent: "codex",
          protocolVersion: 1
        }),
        "R3.plan-ballot",
        actionId,
        ["claude"]
      ).ok
    ).toBe(false);
    expect(
      parseBallotResponse("{", "R3.plan-ballot", actionId, ["claude"]).ok
    ).toBe(false);
  });

  it("reads confined response files and rejects symlinks, directories, and oversized bytes", () => {
    const paths = fixture();
    const path = agentResponsePath(paths, "codex", actionId);
    writeAgentResponse(path, paths.issueRoot, {
      actionId,
      choice: "claude",
      rationale: "ok"
    });
    const read = readAgentResponse(path, paths.issueRoot);
    expect(read.status).toBe("read");
    if (read.status === "read") {
      expect(responseDigest(read.bytes)).toHaveLength(64);
      const archive = archiveAcceptedResponse(paths, "codex", actionId, read.bytes);
      expect(readFileSync(archive)).toEqual(read.bytes);
      expect(archiveAcceptedResponse(paths, "codex", actionId, read.bytes)).toBe(archive);
    }

    clearAgentResponse(path);
    expect(readAgentResponse(path, paths.issueRoot).status).toBe("missing");

    mkdirSync(path, { recursive: true });
    expect(readAgentResponse(path, paths.issueRoot).status).toBe("not-a-file");
    rmSync(path, { recursive: true, force: true });

    writeFileSync(path, "x".repeat(RESPONSE_MAX_BYTES + 1));
    expect(readAgentResponse(path, paths.issueRoot).status).toBe("oversized");
    clearAgentResponse(path);

    const target = join(paths.issueRoot, "outside.json");
    writeFileSync(target, "{}\n");
    symlinkSync(target, path);
    expect(readAgentResponse(path, paths.issueRoot).status).toBe("symlink");
  });

  it("refuses to overwrite an archive with different bytes", () => {
    const paths = fixture();
    const first = Buffer.from('{"actionId":"b2337d85-6617-4e9f-8ace-901453764aa4","choice":"claude","rationale":"a"}\n');
    const second = Buffer.from('{"actionId":"b2337d85-6617-4e9f-8ace-901453764aa4","choice":"codex","rationale":"b"}\n');
    archiveAcceptedResponse(paths, "codex", actionId, first);
    expect(() => archiveAcceptedResponse(paths, "codex", actionId, second)).toThrow(/different bytes/);
  });
});

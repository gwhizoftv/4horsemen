import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTick, executeDrop, executePause, executeResume } from "../src/runLoop.js";
import { writeStart, writeCursors, readCursors, ensureIssueStructure, type StartConfig, type Cursors } from "../src/state.js";
import { initMirror } from "../src/mirror.js";
import { completePath } from "../src/paths.js";

describe("runLoop", () => {
  let tmp: string;
  let coordRoot: string;
  let originPath: string;
  const issue = 1;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "runloop-test-"));
    coordRoot = join(tmp, "coord");
    mkdirSync(coordRoot);
    originPath = join(tmp, "origin.git");

    execSync(`git init --bare ${originPath}`, { stdio: "ignore" });

    const work = join(tmp, "work");
    execSync(`git clone ${originPath} ${work}`, { stdio: "ignore" });
    execSync("git checkout -b issue-1/alice", { cwd: work, stdio: "ignore" });
    writeFileSync(join(work, "README.md"), "init");
    execSync("git add -A && git commit -m init", { cwd: work, stdio: "ignore" });
    execSync("git push origin issue-1/alice", { cwd: work, stdio: "ignore" });

    initMirror(coordRoot, originPath);
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function setupState() {
    ensureIssueStructure(coordRoot, issue, ["alice"]);
    const start: StartConfig = {
      formatVersion: 1, issue, issueSessionId: `issue-1:${"a".repeat(40)}`,
      baselineSha: "a".repeat(40), profile: "solo", roster: ["alice"],
      baseBranch: "main", maxRevisionRounds: 3, prPolicy: "owner-only",
      automationDigest: "d", automationDigestScheme: "v3",
      trustedSourceCommit: "b".repeat(40), createdAt: "2026-01-01T00:00:00Z",
    };
    writeStart(coordRoot, issue, start);
    const cursors: Cursors = {
      issueCursor: { gateId: "gate-1-join", round: null },
      agents: {
        alice: {
          stepId: "R1.join", actionId: "issue-1:alice:R1.join:1",
          status: "ordered", attempt: 1, delivery: "pull",
          submissionSha: null, outstanding: [], updatedAt: "2026-01-01T00:00:00Z",
        },
      },
      droppedAgents: [], paused: false,
    };
    writeCursors(coordRoot, issue, cursors);
  }

  it("runTick with no completions returns empty decisions", async () => {
    setupState();
    const decisions = await runTick({ coordRoot, issue });
    expect(decisions).toEqual([]);
  });

  it("runTick with invalid SHA in complete preserves file (no crash)", async () => {
    setupState();
    writeFileSync(completePath(coordRoot, issue, "alice"), "not-a-sha\n");
    const decisions = await runTick({ coordRoot, issue });
    expect(decisions).toEqual([]);
  });

  describe("executeDrop", () => {
    it("refuses to drop the final active agent", () => {
      setupState();
      const result = executeDrop(coordRoot, issue, "alice");
      expect(result.ok).toBe(false);
    });

    it("refuses to drop non-existent agent", () => {
      setupState();
      const result = executeDrop(coordRoot, issue, "bob");
      expect(result.ok).toBe(false);
    });
  });

  describe("pause/resume", () => {
    it("executePause sets paused flag", () => {
      setupState();
      executePause(coordRoot, issue);
      const c = readCursors(coordRoot, issue);
      expect(c.paused).toBe(true);
    });

    it("executeResume clears paused flag", () => {
      setupState();
      executePause(coordRoot, issue);
      executeResume(coordRoot, issue);
      const c = readCursors(coordRoot, issue);
      expect(c.paused).toBe(false);
    });
  });
});

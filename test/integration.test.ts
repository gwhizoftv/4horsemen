import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTick, executeDrop } from "../src/runLoop.js";
import { writeStart, writeCursors, readCursors, ensureIssueStructure, readJournal, type StartConfig, type AgentCursor } from "../src/state.js";
import { initMirror } from "../src/mirror.js";
import { completePath } from "../src/paths.js";

describe("integration: four-agent workflow", () => {
  let tmp: string;
  let coordRoot: string;
  let originPath: string;
  let workDir: string;
  const issue = 1;
  const agents = ["alice", "bob", "carol", "dave"];
  const SESSION_ID = `issue-1:${"a".repeat(40)}`;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "integration-"));
    coordRoot = join(tmp, "coord");
    mkdirSync(coordRoot);
    originPath = join(tmp, "origin.git");
    workDir = join(tmp, "work");

    // Create bare origin
    execSync(`git init --bare "${originPath}"`, { stdio: "ignore" });

    // Create working clone with initial commit on main
    execSync(`git clone "${originPath}" "${workDir}"`, { stdio: "ignore" });
    execSync("git checkout -b main", { cwd: workDir, stdio: "ignore" });
    writeFileSync(join(workDir, "README.md"), "init");
    execSync("git add -A && git commit -m init", { cwd: workDir, stdio: "ignore" });
    execSync("git push origin main", { cwd: workDir, stdio: "ignore" });

    // Create agent branches with join artifacts
    for (const agent of agents) {
      execSync(`git checkout -b issue-1/${agent} main`, { cwd: workDir, stdio: "ignore" });
      const signalDir = join(workDir, ".signals", "issue-1");
      mkdirSync(signalDir, { recursive: true });
      const joinData = JSON.stringify({
        type: "join",
        issueSessionId: SESSION_ID,
        agent,
        baselineSha: "a".repeat(40),
        automationDigest: "digest",
        automationDigestScheme: "v3",
        createdAt: "2026-01-01T00:00:00Z",
      });
      writeFileSync(join(signalDir, `joined-${agent}.json`), joinData);
      execSync("git add -A", { cwd: workDir, stdio: "ignore" });
      execSync(`git commit -m "join ${agent}"`, { cwd: workDir, stdio: "ignore" });
      execSync(`git push origin issue-1/${agent}`, { cwd: workDir, stdio: "ignore" });
    }

    // Init mirror
    initMirror(coordRoot, originPath);
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function setupState(): void {
    ensureIssueStructure(coordRoot, issue, agents);
    const start: StartConfig = {
      formatVersion: 1, issue, issueSessionId: SESSION_ID,
      baselineSha: "a".repeat(40), profile: "consensus", roster: agents,
      baseBranch: "main", maxRevisionRounds: 3, prPolicy: "owner-only",
      automationDigest: "digest", automationDigestScheme: "v3",
      trustedSourceCommit: "b".repeat(40), createdAt: "2026-01-01T00:00:00Z",
    };
    writeStart(coordRoot, issue, start);
    const agentCursors: Record<string, AgentCursor> = {};
    for (const agent of agents) {
      agentCursors[agent] = {
        stepId: "R1.join", actionId: `issue-1:${agent}:R1.join:1`,
        status: "ordered", attempt: 1, delivery: "pull",
        submissionSha: null, outstanding: [], updatedAt: "2026-01-01T00:00:00Z",
      };
    }
    writeCursors(coordRoot, issue, {
      issueCursor: { gateId: "gate-1-join", round: null },
      agents: agentCursors,
      droppedAgents: [], paused: false,
    });
  }

  it("starts with all agents at gate-1-join", () => {
    setupState();
    const c = readCursors(coordRoot, issue);
    expect(c.issueCursor.gateId).toBe("gate-1-join");
    expect(Object.keys(c.agents)).toHaveLength(4);
  });

  it("runTick with no completions produces no decisions", async () => {
    setupState();
    const decisions = await runTick({ coordRoot, issue });
    expect(decisions).toEqual([]);
  });

  it("processes a valid join submission", async () => {
    setupState();
    const sha = execSync("git rev-parse issue-1/alice", { cwd: workDir, encoding: "utf8" }).trim();
    writeFileSync(completePath(coordRoot, issue, "alice"), sha);
    const decisions = await runTick({ coordRoot, issue });
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.some(d => d.type === "advance-cursor" && d.agent === "alice")).toBe(true);
  });

  it("drops an agent and continues", async () => {
    setupState();
    const result = executeDrop(coordRoot, issue, "dave");
    expect(result.ok).toBe(true);
    const c = readCursors(coordRoot, issue);
    expect(c.droppedAgents).toContain("dave");
  });

  it("ignores completion from dropped agent", async () => {
    setupState();
    executeDrop(coordRoot, issue, "dave");
    const sha = execSync("git rev-parse issue-1/dave", { cwd: workDir, encoding: "utf8" }).trim();
    writeFileSync(completePath(coordRoot, issue, "dave"), sha);
    const decisions = await runTick({ coordRoot, issue });
    expect(decisions.every(d => d.type !== "advance-cursor" || d.agent !== "dave")).toBe(true);
  });

  it("journals events", async () => {
    setupState();
    const sha = execSync("git rev-parse issue-1/bob", { cwd: workDir, encoding: "utf8" }).trim();
    writeFileSync(completePath(coordRoot, issue, "bob"), sha);
    await runTick({ coordRoot, issue });
    const journal = readJournal(coordRoot, issue);
    expect(journal.length).toBeGreaterThan(0);
  });
});

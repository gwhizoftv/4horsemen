import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAction } from "../src/action.js";
import { BareMirror } from "../src/mirror.js";
import { agentRuntimePaths, createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import { CoordinatorRunLoop, githubRepositoryFromOrigin } from "../src/runLoop.js";
import { initializeOperationalState, readCursorsState, readJournal } from "../src/state.js";
import { TmuxController } from "../src/tmux.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "coord-loop-"));
  roots.push(root);
  const paths = issueRuntimePaths(root, 1);
  createIssueRuntime(paths, ["claude", "codex"]);
  initializeOperationalState(paths, {
    issue: 1,
    issueSessionId: `issue-1:${"a".repeat(40)}`,
    baselineSha: "a".repeat(40),
    profile: "consensus",
    originalRoster: ["claude", "codex"],
    branchTemplate: "issue-{issue}/{agent}",
    baseBranch: "main",
    maxRevisionRounds: 3,
    prPolicy: "owner-only",
    automationDigest: "b".repeat(64),
    trustedSourceCommit: "c".repeat(40),
    origin: "/origin.git",
    coordRoot: root,
    configPath: join(root, "config.json"),
    agents: [
      { id: "claude", root: "/clones/claude", launcher: "start-claude.sh", delivery: "pull" },
      { id: "codex", root: "/clones/codex", launcher: "start-codex.sh", delivery: "pull" }
    ],
    checks: [{ name: "check", argv: ["node", "-e", "process.exit(0)"] }],
    pollIntervalMs: 100
  });
  return { root, paths };
};

describe("effectful run loop", () => {
  it("derives an explicit GitHub PR target from supported origin forms", () => {
    expect(githubRepositoryFromOrigin("https://github.com/example/project.git")).toBe("example/project");
    expect(githubRepositoryFromOrigin("git@github.com:example/project.git")).toBe("example/project");
    expect(githubRepositoryFromOrigin("/tmp/origin.git")).toBeNull();
  });

  it("prepares opaque actions for simultaneous agents", async () => {
    const { paths } = fixture();
    const loop = new CoordinatorRunLoop(paths, { tmux: null });
    const cursors = await loop.runTick();
    expect(cursors.agents.claude?.status).toBe("ordered");
    expect(cursors.agents.codex?.status).toBe("ordered");
    const action = readAction(agentRuntimePaths(paths, "codex").action);
    expect(action.requiredPath).toBe(".signals/issue-1/joined-codex.json");
    expect(action.body).not.toContain("gate-1-join");
  });

  it("clears malformed completion and reissues the same action with a concrete correction", async () => {
    const { paths } = fixture();
    const loop = new CoordinatorRunLoop(paths, { tmux: null });
    await loop.runTick();
    const runtime = agentRuntimePaths(paths, "codex");
    const actionId = readCursorsState(paths).agents.codex?.actionId;
    writeFileSync(runtime.complete, "not-a-sha\n");
    await loop.runTick();
    expect(readCursorsState(paths).agents.codex).toMatchObject({ actionId, status: "ordered", attempt: 2 });
    expect(readAction(runtime.action).body).toContain("complete must contain a 40-character lowercase Git SHA");
    expect(readJournal(paths).at(-1)?.type).toBe("verify-result");
  });

  it("preserves completion and emits no artifact verdict on transient fetch failure", async () => {
    const { paths } = fixture();
    const mirror = new BareMirror(paths.mirror, "/origin.git", async () => ({
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: "fatal: network timeout"
    }));
    const loop = new CoordinatorRunLoop(paths, { tmux: null, mirror });
    await loop.runTick();
    const runtime = agentRuntimePaths(paths, "codex");
    writeFileSync(runtime.complete, `${"d".repeat(40)}\n`);
    await loop.runTick();
    expect(readFileSync(runtime.complete, "utf8")).toBe(`${"d".repeat(40)}\n`);
    expect(readCursorsState(paths).agents.codex).toMatchObject({ status: "intent" });
    expect(readJournal(paths).filter((event) => event.type === "verify-result")).toHaveLength(0);
  });

  it("recovers a complete origin tip when a harness disappears before writing completion", async () => {
    const { paths } = fixture();
    let branch = "";
    const tip = "d".repeat(40);
    const mirror = new BareMirror(paths.mirror, "/origin.git", async (args) => {
      const command = args[2];
      if (command === "fetch") {
        branch = args.at(-1)?.includes("claude") === true ? "claude" : "codex";
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
      }
      if (command === "rev-parse") return { exitCode: 0, stdout: Buffer.from(`${tip}\n`), stderr: "" };
      if (command === "merge-base") return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
      if (command === "show") {
        return {
          exitCode: 0,
          stdout: Buffer.from(
            JSON.stringify({
              protocolVersion: 1,
              artifact: "join",
              issue: 1,
              issueSessionId: `issue-1:${"a".repeat(40)}`,
              agent: branch,
              baselineSha: "a".repeat(40),
              automationDigest: "b".repeat(64)
            })
          ),
          stderr: ""
        };
      }
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
    });
    const tmux = new TmuxController(async (args) => {
      const target = args[args.indexOf("-t") + 1] ?? "";
      return target.includes("claude")
        ? { exitCode: 1, stdout: "", stderr: "gone" }
        : { exitCode: 0, stdout: "0\tcodex\t0\n", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, { mirror, tmux });
    await loop.runTick();
    const cursors = await loop.runTick();
    expect(cursors.accepted).toContainEqual(expect.objectContaining({ stepId: "R1.join", agent: "claude", submissionSha: tip }));
    expect(cursors.agents.codex?.status).toBe("ordered");
    expect(readJournal(paths).some((event) => event.details.pushedThenDied === true)).toBe(true);
  });
});

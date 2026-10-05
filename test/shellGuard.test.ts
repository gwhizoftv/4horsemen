import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LifecycleVendor } from "../src/agentEvent.js";
import { containmentCoverage, initializeAgentLifecycle, readAgentLifecycle } from "../src/agentLifecycle.js";
import { createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import { resolveRealGit } from "../src/setupWorkspace.js";
import {
  findGitInvocations,
  runContainmentProbe,
  runShellGuard,
  SHELL_GUARD_ALLOW,
  shellGuardDenyResponse
} from "../src/shellGuard.js";
import { initializeOperationalState, readJournal } from "../src/state.js";
import { repoRoot } from "./support/workspaceFixture.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ISSUE = 86;

/** A clone with the real generated shim, a workspace config, and an issue runtime that includes its agent. */
const fixture = (agent = "claude") => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coord-shell-guard-")));
  roots.push(root);
  const clone = join(root, "clone");
  const other = join(root, "other");
  for (const dir of [clone, other]) {
    mkdirSync(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
  }
  execFileSync("bash", ["-c", '. "$1"; write_git_wrapper "$2" "$3" "$4"', "_",
    join(repoRoot, "scripts", "lib", "launcher.sh"), join(clone, ".coord", "bin", "git"), resolveRealGit(), clone]);
  const configPath = join(root, "config.json");
  const configured = { id: agent, root: clone, launcher: `start-${agent}.sh`, delivery: "both" as const };
  writeFileSync(
    configPath,
    `${JSON.stringify({
      project: "fixture",
      origin: "https://github.com/example/fixture.git",
      branch: "issue-{issue}/{agent}",
      agents: [configured],
      checks: [{ name: "true", argv: ["true"] }]
    })}\n`
  );
  execFileSync("git", ["config", "--local", "coord.workspaceConfig", configPath], { cwd: clone });
  execFileSync("git", ["config", "--local", "consensus.agentId", agent], { cwd: clone });
  const paths = issueRuntimePaths(root, ISSUE);
  createIssueRuntime(paths, [agent]);
  initializeOperationalState(paths, {
    issue: ISSUE,
    issueSessionId: `issue-${ISSUE}:${"b".repeat(40)}`,
    baselineSha: "b".repeat(40),
    profile: "solo",
    originalRoster: [agent],
    branchTemplate: "issue-{issue}/{agent}",
    baseBranch: "main",
    maxRevisionRounds: 3,
    prPolicy: "coord-open-unmerged",
    automationDigest: "c".repeat(64),
    automationDigestScheme: "sha256-length-prefixed-v1",
    automationDigestSources: [{ id: "config", sha256: "c".repeat(64) }],
    trustedSourceCommit: "d".repeat(40),
    origin: "https://github.com/example/fixture.git",
    coordRoot: root,
    configPath,
    agents: [configured],
    checks: [{ name: "true", argv: ["true"] }],
    pollIntervalMs: 1000
  });
  initializeAgentLifecycle(paths, [agent]);
  const env: NodeJS.ProcessEnv = { ...process.env, COORD_ISSUE: String(ISSUE), HOME: root };
  delete env.COORD_GIT_DELEGATE;
  return { root, clone, other, paths, env, actionDir: join(root, `issue-${ISSUE}`, "agents", agent) };
};

const payload = (vendor: LifecycleVendor, command: string | string[], cwd: string, sessionId = "session-1"): unknown => {
  switch (vendor) {
    case "claude":
    case "codex":
      return { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd, session_id: sessionId };
    case "cursor":
      return { hook_event_name: "beforeShellExecution", command, cwd, conversation_id: sessionId, cursor_version: "1.7" };
    case "antigravity":
      return { toolCall: { name: "run_command", args: { CommandLine: command, Cwd: cwd } }, sessionId };
  }
};

const VENDORS = ["claude", "codex", "cursor", "antigravity"] as const;

describe("shell-tool guard policy matrix", () => {
  it("refuses the same Git reads the shim refuses, in every vendor's decision format", () => {
    const { clone, other, env } = fixture();
    const denied = [
      "git status",
      "git --no-pager diff",
      "/usr/bin/git status --porcelain",
      `cd ${clone} && git diff`,
      "bash -lc 'git status'",
      'zsh -lc "git diff --stat"',
      "env FOO=1 git status",
      "COORD_GIT_DELEGATE=1 git status",
      "echo x | git -C . diff",
      "ls\ngit status",
      "git status --porcelain; coord containment-probe --refusal-ran"
    ];
    const allowed = [
      `git -C ${other} status`,
      `cd ${other} && git status`,
      "git add -A && git commit -m x && git push",
      "git log --oneline -1",
      "git show HEAD:README.md",
      'echo "git status"',
      "cat > notes.txt <<'EOF'\ngit status\nEOF",
      "$GIT status",
      "command -v git",
      "ls -la"
    ];
    for (const vendor of VENDORS) {
      for (const command of denied) {
        const result = runShellGuard({ vendor, clone, raw: payload(vendor, command, command.startsWith("cd ") ? other : clone), env });
        expect(result.denied, `${vendor}: ${command}`).toBe(true);
        const decision = JSON.parse(result.output) as Record<string, unknown>;
        const reason =
          vendor === "cursor"
            ? decision.agent_message
            : vendor === "antigravity"
              ? decision.reason
              : (decision.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason;
        expect(result.output).toBe(shellGuardDenyResponse(vendor, reason as string));
        expect(reason).toContain("## Bound input files");
      }
      for (const command of allowed) {
        const result = runShellGuard({ vendor, clone, raw: payload(vendor, command, clone), env });
        expect(result, `${vendor}: ${command}`).toEqual({ output: SHELL_GUARD_ALLOW[vendor], denied: false });
      }
    }
  });

  it("reads Codex argv commands and leaves manual mode, a missing shim, and unreadable payloads alone", () => {
    const { clone, env } = fixture();
    expect(runShellGuard({ vendor: "codex", clone, raw: payload("codex", ["bash", "-lc", "git status"], clone), env }).denied).toBe(true);

    const manual = { ...env };
    delete manual.COORD_ISSUE;
    expect(runShellGuard({ vendor: "claude", clone, raw: payload("claude", "git status", clone), env: manual }).denied).toBe(false);
    expect(runShellGuard({ vendor: "cursor", clone, raw: { unexpected: true }, env }).output).toBe(SHELL_GUARD_ALLOW.cursor);

    rmSync(join(clone, ".coord"), { recursive: true });
    expect(runShellGuard({ vendor: "claude", clone, raw: payload("claude", "git status", clone), env }).denied).toBe(false);
  });

  it("keeps the pinned-read fallback open until the action lists every file", () => {
    const { clone, env, actionDir } = fixture();
    const pinned = `git show ${"a".repeat(40)}:README.md`;
    const decide = () => runShellGuard({ vendor: "claude", clone, raw: payload("claude", pinned, clone), env }).denied;
    expect(decide()).toBe(false);
    mkdirSync(actionDir, { recursive: true });
    writeFileSync(join(actionDir, "action.md"), "body\n\n## Bound input files\n\n- plan: \"/tmp/x\"\n");
    expect(decide()).toBe(true);
    writeFileSync(
      join(actionDir, "action.md"),
      "body\n\n## Bound input files\n\nNot every bound input could be exported; use the pin.\n\n- plan: \"/tmp/x\"\n"
    );
    expect(decide()).toBe(false);
  });

  it("finds git only where it is literally the command word", () => {
    expect(findGitInvocations("FOO=1 command git -c x=y status 2>&1 >/dev/null", "/repo")).toEqual([
      { argv: ["-c", "x=y", "status"], cwd: "/repo", env: { FOO: "1" } }
    ]);
    expect(findGitInvocations("cd sub && (git status) | cat", "/repo").map((item) => item.cwd)).toEqual(["/repo/sub"]);
    expect(findGitInvocations('cd "$DIR" && git status', "/repo").map((item) => item.cwd)).toEqual([null]);
    expect(findGitInvocations("printf '%s' \"$(git status)\"", "/repo")).toEqual([]);
  });
});

describe("containment evidence", () => {
  it("records a deny and reports hook coverage only after a same-session probe", () => {
    const { clone, paths, env } = fixture();
    const withSession = (sessionId: string) => {
      // The lifecycle stream establishes the session the probe binds to.
      const state = readAgentLifecycle(paths);
      const entry = state.agents.claude!;
      writeFileSync(paths.agentLifecycle, JSON.stringify({ ...state, agents: { claude: { ...entry, sessionId } } }));
    };
    withSession("session-1");
    runShellGuard({ vendor: "claude", clone, raw: payload("claude", "git status", clone), env, now: "2026-10-05T10:00:00.000Z" });
    expect(readJournal(paths).at(-1)).toMatchObject({
      type: "agent-lifecycle",
      agent: "claude",
      details: { kind: "containment-guard-denied", subcommand: "status", guardSessionId: "session-1" }
    });
    expect(containmentCoverage(readAgentLifecycle(paths).agents.claude!)).toEqual({ hook: "unverified", shim: "unverified" });

    const shimFirst = { ...env, PATH: `${join(clone, ".coord", "bin")}:${env.PATH ?? ""}` };
    const probe = runContainmentProbe({ clone, env: shimFirst, now: "2026-10-05T10:00:01.000Z" });
    expect(probe.coverage).toEqual({ hook: "active", shim: "active" });

    // A restart is a new session: earlier evidence proves nothing about it.
    withSession("session-2");
    expect(containmentCoverage(readAgentLifecycle(paths).agents.claude!)).toEqual({ hook: "unverified", shim: "unverified" });
  });

  it("reports a deny the harness ignored, and a shim that PATH or the environment bypasses", () => {
    const { clone, paths, env } = fixture();
    runShellGuard({ vendor: "cursor", clone, raw: payload("cursor", "git status", clone), env, now: "2026-10-05T10:00:00.000Z" });
    runContainmentProbe({ clone, env, refusalRan: true, now: "2026-10-05T10:00:01.000Z" });
    const realFirst = { ...env, PATH: `/usr/bin:/bin:${join(clone, ".coord", "bin")}` };
    expect(runContainmentProbe({ clone, env: realFirst, now: "2026-10-05T10:00:02.000Z" }).coverage).toEqual({
      hook: "inactive",
      shim: "bypassed"
    });

    const shimFirst = `${join(clone, ".coord", "bin")}:/usr/bin:/bin`;
    expect(runContainmentProbe({ clone, env: { ...env, PATH: shimFirst, COORD_GIT_DELEGATE: "1" } }).coverage?.shim).toBe("bypassed");
    const noIssue: NodeJS.ProcessEnv = { ...env, PATH: shimFirst };
    delete noIssue.COORD_ISSUE;
    expect(runContainmentProbe({ clone, env: noIssue, issue: ISSUE }).coverage?.shim).toBe("bypassed");
    expect(readAgentLifecycle(paths).agents.claude?.containment?.probe).toMatchObject({ issueEnv: false, delegateEnv: false });
  });

  it("does not let a failed evidence write turn a deny into an allow", () => {
    const { clone, paths, env } = fixture();
    chmodSync(paths.issueRoot, 0o500);
    try {
      const result = runShellGuard({ vendor: "claude", clone, raw: payload("claude", "git diff", clone), env });
      expect(result.denied).toBe(true);
      expect(result.recordError).toBeDefined();
    } finally {
      chmodSync(paths.issueRoot, 0o700);
    }
  });
});

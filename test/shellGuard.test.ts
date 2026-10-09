import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { guardShellRequest, shellGuardResponse, staticGitCalls } from "../src/shellGuard.js";
import { effectOptions, writeGitWrapper } from "../src/setupWorkspace.js";
import { git, makeProduct, repoRoot, type ProductFixture } from "./support/workspaceFixture.js";

const fixtures: ProductFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });
const fixture = () => {
  const product = makeProduct("plain"); fixtures.push(product);
  writeGitWrapper({ installRoot: repoRoot, clone: product.productRoot, options: effectOptions(() => undefined, false) });
  return product;
};
const vendors = ["claude", "codex", "cursor", "antigravity"] as const;
const payload = (vendor: typeof vendors[number], command: string | string[], cwd: string) =>
  vendor === "cursor" ? { command, cwd, conversation_id: "session", cursor_version: "test" }
    : vendor === "antigravity" ? { toolCall: { args: { CommandLine: command, Cwd: cwd } }, conversationId: "session" }
      : { tool_input: { command }, cwd, session_id: "session" };

describe("native shell guard shared policy", () => {
  it.each(vendors)("classifies literal commands through the real shim for %s", (vendor) => {
    const f = fixture(), clone = f.productRoot, other = f.workspaceRoot;
    const env = { ...process.env, COORD_ISSUE: "42", COORD_GIT_DELEGATE: "1" };
    const check = (command: string | string[], allow: boolean, environment = env) => {
      const result = guardShellRequest({ vendor, clone, raw: payload(vendor, command, clone), env: environment });
      if (allow) expect(result, JSON.stringify(command)).toEqual(shellGuardResponse(vendor));
      else expect(JSON.stringify(result), JSON.stringify(command)).toContain('"deny"');
    };
    for (const command of [
      "git status", "git --no-pager diff", "/usr/bin/git status", `cd '${clone}' && git diff`,
      "bash -lc 'git status'", 'zsh -l -c "git diff"', "env FOO=1 git status",
      "COORD_GIT_DELEGATE=1 git status", "command git status", "nohup git diff",
      "echo x | git -C . diff", "echo x; git status > output 2>&1", "(git diff)",
      `GIT_WORK_TREE='${clone}' git status`, "git status & echo done", "g'it' status",
      `(cd '${other}' && echo ok); git status`, "env -u COORD_GIT_DELEGATE git status",
      `echo ok | cd '${other}'; git status`, "2>/dev/null git status"
    ]) check(command, false);
    for (const command of [
      `git -C '${other}' status`, `cd '${other}' && git status`, "git add file", "git commit -m x",
      "git push", "git show HEAD:README.md", 'echo "git status"', "cat <<'END'\ngit status\nEND\n",
      "cat <<-END\n\tgit status\n\tEND\n", "printf done", "$GIT status", "bash script.sh",
      "echo $(git status)", "msg=$(git status)", "echo `git status`",
      'echo "$(git status)"', "echo ${unused:-$(git status)}",
      "echo $(printf '%s' ')'; git status)", "echo $(echo $(git status))",
      "echo $(printf x # )\n git status)",
      "git $ARGS", `GIT_DIR='${other}/.git' git status`, "cd '$UNKNOWN'; git status",
      `{ cd '${other}'; git status; }`
    ]) check(command, true);
    check("git status", true, { ...env, COORD_ISSUE: "" });
    check(["bash", "-lc", "git status"], false);
    check(["git", "log", "-1"], true);
    check("cat <<END\ngit status\nEND\ngit diff", false);
    check("echo $(git status); git diff", false);
    check("echo `git status`; git diff", false);
    check("echo $(printf x # )\n git status); git diff", false);
    // Allowed commands were classified, never executed (no staging/commit/push).
    expect(git(clone, "log", "--format=%s")).toBe("initial");
  });

  it("distinguishes shell-local targeting assignments from exported and command-local values", () => {
    const f = fixture(), clone = f.productRoot, other = f.workspaceRoot;
    const environment: NodeJS.ProcessEnv = { ...process.env, COORD_ISSUE: "42" };
    delete environment.GIT_DIR;
    delete environment.GIT_WORK_TREE;
    for (const key of ["GIT_WORK_TREE", "GIT_DIR"] as const) {
      const own = key === "GIT_DIR" ? join(clone, ".git") : clone;
      const away = key === "GIT_DIR" ? join(other, ".git") : other;
      const command = `${key}='${away}'; git status`;
      expect(staticGitCalls(command, clone, environment)[0]?.env[key]).toBeUndefined();
      expect(staticGitCalls(command, clone, { ...environment, [key]: own })[0]?.env[key]).toBe(away);
      expect(staticGitCalls(`${key}='${away}' git status`, clone, environment)[0]?.env[key]).toBe(away);
      expect(staticGitCalls(`${key}='${away}' env -i git status`, clone, environment)[0]?.env[key]).toBeUndefined();
      expect(staticGitCalls(`env --ignore-environment git status`, clone, { ...environment, [key]: away })[0]?.env[key]).toBeUndefined();
      const result = guardShellRequest({ vendor: "codex", clone,
        raw: payload("codex", command, clone), env: environment });
      expect(JSON.stringify(result)).toContain('"deny"');
      // A real shell agrees: an unexported assignment does not redirect Git.
      expect(execFileSync("/bin/bash", ["-c", `${key}='${away}'; git rev-parse --show-toplevel`], {
        cwd: clone, env: environment, encoding: "utf8"
      }).trim()).toBe(realpathSync(clone));
    }
  });

  it("keeps the pinned-read materialization fallback and local HEAD reads", () => {
    const f = fixture(), clone = f.productRoot;
    const config = join(f.coordRoot, "config.json");
    writeFileSync(config, "{}");
    git(clone, "config", "coord.workspaceConfig", config);
    git(clone, "config", "consensus.agentId", "codex");
    const action = join(f.coordRoot, "issue-42", "agents", "codex", "action.md");
    mkdirSync(dirname(action), { recursive: true });
    const check = (command: string) => guardShellRequest({ vendor: "codex", clone,
      raw: payload("codex", command, clone), env: { ...process.env, COORD_ISSUE: "42" } });
    const pinned = `git show ${git(clone, "rev-parse", "HEAD")}:README.md`;
    expect(check(pinned)).toEqual({});
    writeFileSync(action, "## Bound input files\n");
    expect(JSON.stringify(check(pinned))).toContain('"deny"');
    expect(check("git show HEAD:README.md")).toEqual({});
    writeFileSync(action, "## Bound input files\nNot every bound input could be exported\n");
    expect(check(pinned)).toEqual({});
    rmSync(join(clone, ".coord", "bin", "git"));
    expect(check("git status")).toEqual({});
  });

  it("allows git status when COORD_MANUAL or a stale issue binding is proven", () => {
    const f = fixture(), clone = f.productRoot;
    const config = join(f.coordRoot, "config.json");
    writeFileSync(config, "{}");
    git(clone, "config", "coord.workspaceConfig", config);
    git(clone, "config", "consensus.agentId", "codex");
    const issueRoot = join(f.coordRoot, "issue-42");
    mkdirSync(join(issueRoot, "agents", "codex"), { recursive: true });
    const cursors = join(issueRoot, "cursors.json");
    writeFileSync(cursors, JSON.stringify({ completed: false, abandoned: false }, null, 2));
    const env = { ...process.env, COORD_ISSUE: "42" };
    const check = (environment: NodeJS.ProcessEnv) =>
      guardShellRequest({ vendor: "codex", clone, raw: payload("codex", "git status", clone), env: environment });
    expect(JSON.stringify(check(env))).toContain('"deny"');
    expect(check({ ...env, COORD_MANUAL: "1" })).toEqual({});
    writeFileSync(cursors, JSON.stringify({ completed: true, abandoned: false }, null, 2));
    expect(check(env)).toEqual({});
    writeFileSync(cursors, JSON.stringify({ completed: false, abandoned: true }, null, 2));
    expect(check(env)).toEqual({});
    rmSync(issueRoot, { recursive: true, force: true });
    expect(check(env)).toEqual({});
  });

  it("bounds recursion and does not interpret dynamic words or heredoc data", () => {
    expect(staticGitCalls("echo 'git status'", "/", {})).toEqual([]);
    expect(staticGitCalls("git status".repeat(20000), "/", {})).toEqual([]);
    expect(staticGitCalls(Array(1000).fill("git").join(";"), "/", {}).length).toBeLessThanOrEqual(64);
    const f = fixture();
    expect(readFileSync(join(f.productRoot, ".coord/bin/git"), "utf8")).toContain("COORD_GIT_POLICY_CHECK");
    expect(staticGitCalls("cd /missing/coord-test; git status", f.productRoot, {})).toEqual([]);
  });
});
